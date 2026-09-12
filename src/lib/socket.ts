/**
 * Socket.io Server Configuration
 *
 * This module sets up the WebSocket server with:
 * 1. Redis adapter for horizontal scaling
 * 2. Authentication middleware, and a periodic re-check of each connection's session
 * 3. Room management for conversations
 * 4. Event handlers for real-time messaging, typing, read receipts and presence
 */

import { Server as HttpServer } from 'http';
import { GraphQLError } from 'graphql';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Emitter } from '@socket.io/redis-emitter';
import RedisClient, { redisPubSub, presence, session, typing, rateLimit } from './redis';
import { verifyAccessToken, type JWTPayload } from './auth';
import { isSessionAllowed } from '@/middleware/auth.middleware';
import { RateLimitConfig } from '@/middleware/rate-limit.middleware';
import prisma from './prisma';
import { UserRole } from '@prisma/client';
import { config } from '@/config';

// ===========================================
// Types
// ===========================================
export interface AuthenticatedSocket extends Socket {
  userId: string;
  userType: UserRole;
  /** The user's first and last name */
  userName: string;
  /** The verified access token the socket connected with */
  tokenPayload: JWTPayload;
  /** The raw access token, for the periodic session check */
  accessToken: string;
}

export interface MessagePayload {
  conversationId: string;
  content: string;
  attachments?: string[];
  /** The app's own ID for this message, echoed back in message:sent */
  tempId?: string | number;
}

export interface TypingPayload {
  conversationId: string;
  isTyping: boolean;
}

export interface JoinRoomPayload {
  conversationId: string;
}

/** Why the server ended a connected socket's session (sent in session:ended) */
export type SessionEndReason = 'TOKEN_EXPIRED' | 'SESSION_REVOKED';

// ===========================================
// Timings and limits
// ===========================================
// Each server refreshes the Redis records of its own sockets this often. Records expire
// after session.SESSION_TTL, so sockets lost when a server stops without a clean shutdown
// stop counting within a few minutes.
const SOCKET_REFRESH_MS = 60 * 1000;
// A connected socket's session is checked again about this often
const SESSION_RECHECK_MS = 5 * 60 * 1000;
// Conversations loaded at connect, most recently active first, for participation checks
// and presence recipients. Older conversations are looked up when used.
const MAX_CONVERSATIONS_LOADED = 1000;
// A conversation the user doesn't take part in is looked up again after this long
const NOT_PARTICIPANT_TTL_MS = 60 * 1000;
const MAX_NOT_PARTICIPANT_ENTRIES = 100;

const SESSION_END_MESSAGES: Record<SessionEndReason, string> = {
  TOKEN_EXPIRED: 'Your access token has expired. Refresh it and connect again.',
  SESSION_REVOKED: 'Your session is no longer valid. Refresh your access token or sign in again.',
};

const OBJECT_ID = /^[a-f\d]{24}$/i;

// ===========================================
// Socket.io Server Instance
// ===========================================
let io: Server | null = null;

// ===========================================
// Helpers
// ===========================================
function mapToUserRole(role: string): UserRole {
  switch (role) {
    case 'SUPER_ADMIN':
      return UserRole.SUPER_ADMIN;
    case 'ADMIN':
      return UserRole.ADMIN;
    case 'SERVICE_PROVIDER':
      return UserRole.SERVICE_PROVIDER;
    default:
      return UserRole.SERVICE_USER;
  }
}

const isObjectId = (value: unknown): value is string =>
  typeof value === 'string' && OBJECT_ID.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** First and last name, or "Someone": the same rule as message:new's senderName */
const toDisplayName = (user: { firstName: string; lastName: string } | null): string =>
  [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || 'Someone';

/** A tempId as the app sent it: a non-empty string or a finite number */
const readTempId = (value: unknown): string | number | undefined => {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
};

/** Browser origins allowed to connect: WEBSOCKET_CORS_ORIGINS, else CORS_ALLOWED_ORIGINS */
const socketCorsOrigins = (): string[] =>
  config.websocket.corsOrigins.length > 0 ? config.websocket.corsOrigins : config.cors.allowedOrigins;

/** Why a connected socket's session must end now, or null while it may continue */
const findSessionEndReason = async (
  payload: JWTPayload,
  token: string
): Promise<SessionEndReason | null> => {
  if (payload.exp !== undefined && payload.exp * 1000 <= Date.now()) return 'TOKEN_EXPIRED';
  return (await isSessionAllowed(payload, token)) ? null : 'SESSION_REVOKED';
};

/**
 * The conversations a connected user takes part in, and the people they share them with.
 * Loaded once when the socket connects and kept for the connection, so typing indicators
 * and presence updates don't query the database on every event. Archived conversations
 * count: their participants can still open them.
 */
const createConversationAccess = (userId: string) => {
  const conversations = new Set<string>();
  const contacts = new Set<string>();
  // Conversation ID → when to ask the database again
  const notParticipant = new Map<string, number>();
  const lookups = new Map<string, Promise<boolean>>();

  const remember = (conversationId: string, participantIds: string[]): void => {
    conversations.add(conversationId);
    notParticipant.delete(conversationId);
    for (const id of participantIds) {
      if (id !== userId) contacts.add(id);
    }
  };

  const loaded: Promise<boolean> = prisma.conversation
    .findMany({
      where: { participantIds: { has: userId } },
      select: { id: true, participantIds: true },
      orderBy: { lastMessageAt: 'desc' },
      take: MAX_CONVERSATIONS_LOADED,
    })
    .then((rows) => {
      rows.forEach((row) => remember(row.id, row.participantIds));
      return true;
    })
    .catch((error: unknown) => {
      console.error(`Failed to load conversations for socket user ${userId}:`, errorMessage(error));
      return false;
    });

  const lookUp = async (conversationId: string): Promise<boolean> => {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, participantIds: { has: userId } },
      select: { participantIds: true },
    });
    if (conversation) {
      remember(conversationId, conversation.participantIds);
      return true;
    }

    if (notParticipant.size >= MAX_NOT_PARTICIPANT_ENTRIES) {
      const oldest = notParticipant.keys().next();
      if (!oldest.done) notParticipant.delete(oldest.value);
    }
    notParticipant.set(conversationId, Date.now() + NOT_PARTICIPANT_TTL_MS);
    return false;
  };

  return {
    /** Settles once the conversations are loaded: false when loading failed */
    loaded,
    /** IDs of the users who share a conversation with this user */
    contacts,
    remember,
    /** Whether the user takes part in the conversation; throws when the database can't be reached */
    async isParticipant(conversationId: string): Promise<boolean> {
      await loaded;
      if (conversations.has(conversationId)) return true;

      const retryAt = notParticipant.get(conversationId);
      if (retryAt !== undefined && retryAt > Date.now()) return false;

      let lookup = lookups.get(conversationId);
      if (!lookup) {
        lookup = lookUp(conversationId).finally(() => lookups.delete(conversationId));
        lookups.set(conversationId, lookup);
      }
      return lookup;
    },
  };
};

// ===========================================
// Initialize Socket.io Server
// ===========================================
export async function initializeSocketServer(httpServer: HttpServer): Promise<Server> {
  if (io) {
    return io;
  }

  // Create Socket.io server
  io = new Server(httpServer, {
    cors: {
      origin: socketCorsOrigins(),
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
  });

  // Set up Redis adapter for scaling
  try {
    const { pub, sub } = await redisPubSub.connect();
    io.adapter(createAdapter(pub, sub));
    console.log('✅ Socket.io Redis adapter configured');
  } catch (error) {
    console.error('❌ Failed to configure Redis adapter:', error);
    console.log('⚠️ Running without Redis adapter (single server mode)');
  }

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = verifyAccessToken(token);
      // The display name is loaded here, once, so it's ready before the first event
      const [allowed, user] = await Promise.all([
        isSessionAllowed(decoded, token),
        prisma.user.findUnique({
          where: { id: decoded.userId },
          select: { firstName: true, lastName: true },
        }),
      ]);
      if (!allowed) {
        return next(new Error('Invalid token'));
      }

      // Attach user info to socket
      const authSocket = socket as AuthenticatedSocket;
      authSocket.userId = decoded.userId;
      authSocket.userType = mapToUserRole(decoded.role);
      authSocket.userName = toDisplayName(user);
      authSocket.tokenPayload = decoded;
      authSocket.accessToken = token;

      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket: Socket) => handleConnection(socket as AuthenticatedSocket));

  console.log('✅ Socket.io server initialized');
  return io;
}

// ===========================================
// Connection Handler
// ===========================================
// Everything up to the Redis writes at the end runs synchronously, so the event handlers
// are attached before the client can send its first event.
function handleConnection(socket: AuthenticatedSocket): void {
  const { userId, userType, userName, tokenPayload, accessToken } = socket;
  const conversationRoom = (conversationId: string) => `conversation:${conversationId}`;

  console.log(`🔌 Socket ${socket.id} connected for user ${userId} (${userType})`);

  // Join user's personal room for direct notifications
  socket.join(`user:${userId}`);

  const access = createConversationAccess(userId);

  /**
   * Attach an event handler. Socket.IO calls handlers outside any try/catch, so a thrown
   * error or a rejected promise is logged here instead of crashing the process.
   */
  const handle = (event: string, handler: (payload: unknown) => unknown): void => {
    socket.on(event, (payload: unknown) => {
      const logFailure = (error: unknown) =>
        console.error(`Socket event ${event} failed for user ${userId}:`, errorMessage(error));
      try {
        Promise.resolve(handler(payload)).catch(logFailure);
      } catch (error) {
        logFailure(error);
      }
    });
  };

  /** The error event, naming the client event that failed */
  const emitError = (event: string, message: string, extra: Record<string, unknown> = {}): void => {
    socket.emit('error', { message, event, ...extra });
  };

  /** Presence updates go only to people who share a conversation with the user */
  const emitToContacts = async (event: string, data: Record<string, unknown>): Promise<void> => {
    await access.loaded;
    if (access.contacts.size === 0) return;
    socket.to([...access.contacts].map((id) => `user:${id}`)).emit(event, data);
  };

  // ===========================================
  // Event Handlers
  // ===========================================

  // Join a conversation room
  handle('conversation:join', async (payload) => {
    const conversationId = isRecord(payload) ? payload.conversationId : undefined;
    if (!isObjectId(conversationId)) {
      emitError('conversation:join', 'Conversation not found or access denied');
      return;
    }

    let allowed: boolean;
    try {
      allowed = await access.isParticipant(conversationId);
    } catch (error) {
      console.error('Error joining conversation:', errorMessage(error));
      emitError('conversation:join', 'Failed to join conversation');
      return;
    }

    if (!allowed) {
      emitError('conversation:join', 'Conversation not found or access denied');
      return;
    }

    const room = conversationRoom(conversationId);
    socket.join(room);

    // Notify others in the conversation
    socket.to(room).emit('user:joined', { userId, userName, conversationId });
  });

  // Leave a conversation room
  handle('conversation:leave', (payload) => {
    const conversationId = isRecord(payload) ? payload.conversationId : undefined;
    if (typeof conversationId !== 'string') return;

    // Only a socket that is in the room can announce leaving it
    const room = conversationRoom(conversationId);
    if (!socket.rooms.has(room)) return;

    socket.leave(room);
    socket.to(room).emit('user:left', { userId, userName, conversationId });
  });

  // Send a message
  handle('message:send', async (raw) => {
    const payload = isRecord(raw) ? raw : {};
    // The app's ID for this message; older apps passed one when connecting
    const tempId = readTempId(payload.tempId) ?? readTempId(socket.handshake.query.tempId);
    const fail = (message: string, extra: Record<string, unknown> = {}): void =>
      emitError('message:send', message, tempId === undefined ? extra : { ...extra, tempId });

    try {
      // One budget with the sendMessage and startConversation mutations: the per-user
      // MESSAGE bucket of the GraphQL rate limiter (gql:<type>:user:<id>)
      const { limit, windowSeconds } = RateLimitConfig.MESSAGE;
      const quota = await rateLimit.check(`gql:message:user:${userId}`, limit, windowSeconds);
      if (!quota.allowed) {
        fail(`Too many messages. Please try again in ${quota.resetIn} seconds.`, {
          code: 'RATE_LIMITED',
          retryAfter: quota.resetIn,
        });
        return;
      }

      const { conversationId, content } = payload;
      const attachments = payload.attachments ?? [];
      if (!isObjectId(conversationId)) {
        fail('Conversation not found or access denied');
        return;
      }
      if (typeof content !== 'string' || !isStringArray(attachments)) {
        fail('Failed to send message');
        return;
      }

      // The same path as the sendMessage mutation: participant and block
      // checks, the content filter, notifications, and message:new to the
      // conversation room
      const { sendMessage } = await import('@/services/messaging.service');
      const message = await sendMessage(userId, userType, {
        conversationId,
        content,
        attachments,
      });
      access.remember(conversationId, []);

      // Clear typing indicator (best effort: the message is already saved)
      typing.clearTyping(conversationId, userId).catch((error: unknown) => {
        console.error('Failed to clear typing indicator:', errorMessage(error));
      });

      // Acknowledge message sent
      socket.emit('message:sent', { tempId, messageId: message.id });
    } catch (error) {
      console.error('Error sending message:', errorMessage(error));
      // Show why the message was refused (e.g. a block) rather than a generic failure
      fail(error instanceof GraphQLError ? error.message : 'Failed to send message');
    }
  });

  // Typing indicator: participants only, from the conversations loaded at connect
  const relayTyping = (isTyping: boolean) => async (payload: unknown): Promise<void> => {
    const conversationId = isRecord(payload) ? payload.conversationId : undefined;
    if (!isObjectId(conversationId) || !(await access.isParticipant(conversationId))) return;

    socket.to(conversationRoom(conversationId)).emit('typing:update', {
      userId,
      userName,
      conversationId,
      isTyping,
    });

    await (isTyping
      ? typing.setTyping(conversationId, userId)
      : typing.clearTyping(conversationId, userId));
  };
  handle('typing:start', relayTyping(true));
  handle('typing:stop', relayTyping(false));

  // Mark messages as read
  handle('messages:read', async (raw) => {
    const payload = isRecord(raw) ? raw : {};
    const { conversationId } = payload;
    if (!isObjectId(conversationId)) {
      emitError('messages:read', 'Conversation not found or access denied');
      return;
    }

    const messageIds = Array.isArray(payload.messageIds)
      ? [...new Set(payload.messageIds.filter(isObjectId))]
      : [];
    if (messageIds.length === 0) return;

    try {
      // The same as the markMessagesAsRead mutation: participants only, and only the
      // other participants' messages, adding the reader to readBy once
      const { markMessagesAsRead } = await import('@/services/messaging.service');
      await markMessagesAsRead(userId, conversationId, messageIds);
    } catch (error) {
      console.error('Error marking messages as read:', errorMessage(error));
      emitError(
        'messages:read',
        error instanceof GraphQLError ? error.message : 'Failed to mark messages as read'
      );
      return;
    }
    access.remember(conversationId, []);

    // Notify the other participants that messages were read
    socket.to(conversationRoom(conversationId)).emit('messages:read', {
      conversationId,
      messageIds,
      readBy: userId,
      readAt: new Date(),
    });
  });

  // Presence heartbeat: keeps the user online for presence.ONLINE_TTL seconds
  handle('heartbeat', () => presence.setOnline(userId));

  // Get online status
  handle('presence:check', async (payload) => {
    if (!isRecord(payload) || !Array.isArray(payload.userIds)) return;
    const userIds = payload.userIds.filter((id: unknown): id is string => typeof id === 'string');
    socket.emit('presence:status', await presence.getOnlineUsers(userIds));
  });

  // ===========================================
  // Session re-check
  // ===========================================
  // Suspension, bans, sign-out, password and role changes, and token expiry end a
  // connected socket too, not only a new connection
  let sessionTimer: ReturnType<typeof setTimeout> | undefined;

  const checkSession = async (): Promise<void> => {
    if (!socket.connected) return;
    try {
      const reason = await findSessionEndReason(tokenPayload, accessToken);
      if (reason) {
        console.log(`🔒 Ending socket ${socket.id} for user ${userId}: ${reason}`);
        socket.emit('session:ended', { reason, message: SESSION_END_MESSAGES[reason] });
        socket.disconnect(true);
        return;
      }
    } catch (error) {
      // A check that couldn't run (e.g. the database is unreachable) keeps the socket
      console.error(`Failed to re-check the session of socket ${socket.id}:`, errorMessage(error));
    }
    if (socket.connected) scheduleSessionCheck();
  };

  function scheduleSessionCheck(): void {
    // Spread the checks so sockets that connected together aren't all checked at once
    const delay = SESSION_RECHECK_MS * (0.9 + Math.random() * 0.2);
    sessionTimer = setTimeout(() => {
      checkSession().catch((error: unknown) => {
        console.error(`Session re-check failed for socket ${socket.id}:`, errorMessage(error));
      });
    }, delay);
    sessionTimer.unref();
  }
  scheduleSessionCheck();

  // ===========================================
  // Presence records
  // ===========================================
  // Record the socket and mark the user online. Best effort: without Redis the socket
  // still works, it just doesn't count for presence.
  const registered = Promise.allSettled([
    session.setSocket(userId, socket.id),
    presence.setOnline(userId),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`Failed to record socket ${socket.id} in Redis:`, errorMessage(result.reason));
      }
    }
  });

  // Keep this socket's record alive while it's connected
  const refreshTimer = setInterval(() => {
    session.setSocket(userId, socket.id).catch((error: unknown) => {
      console.error(`Failed to refresh socket ${socket.id} in Redis:`, errorMessage(error));
    });
  }, SOCKET_REFRESH_MS);
  refreshTimer.unref();

  // Emit online status to the people who share a conversation with the user
  emitToContacts('user:online', { userId, userName }).catch((error: unknown) => {
    console.error(`Failed to announce user ${userId} online:`, errorMessage(error));
  });

  // ===========================================
  // Disconnect Handler
  // ===========================================
  socket.on('disconnect', (reason: string) => {
    clearInterval(refreshTimer);
    clearTimeout(sessionTimer);
    console.log(`🔌 Socket ${socket.id} disconnected for user ${userId} - ${reason}`);

    const markOffline = async (): Promise<void> => {
      // Let the connect-time writes finish, so they can't record this socket again
      await registered;
      await session.removeSocket(userId, socket.id);

      // Check if user has other active sockets
      const remainingSockets = await session.getSockets(userId);
      if (remainingSockets.length > 0) return;

      // User is fully offline
      try {
        await presence.setOffline(userId);
      } finally {
        await emitToContacts('user:offline', { userId, userName, lastSeen: new Date() });
      }
    };

    markOffline().catch((error: unknown) => {
      console.error(`Failed to update presence after socket ${socket.id} disconnected:`, errorMessage(error));
    });
  });

  // Error handler
  socket.on('error', (error) => {
    console.error(`Socket error for user ${userId}:`, error);
  });
}

// ===========================================
// Get Socket.io Instance
// ===========================================
export function getIO(): Server | null {
  return io;
}

// The part of Server / Emitter used by the emit helpers below
type Broadcaster = {
  to(room: string): { emit(event: string, ...args: unknown[]): unknown };
  emit(event: string, ...args: unknown[]): unknown;
};

let emitter: Emitter | null = null;

/**
 * Next.js bundles route handlers separately from the custom server, so `io` is
 * never set where resolvers run. Publish through Redis instead: the Socket.IO
 * server's Redis adapter delivers the event to connected clients.
 */
const getEmitter = (): Emitter => {
  if (!emitter) {
    const redis = RedisClient.getInstance();
    // The emitter doesn't handle publish failures, and an unhandled rejection
    // during a Redis outage would crash the process
    emitter = new Emitter({
      publish: (channel: string, message: string | Buffer) =>
        redis.publish(channel, message).catch((error: Error) => {
          console.error('Failed to publish socket event:', error.message);
        }),
    });
  }
  return emitter;
};

// ===========================================
// Emit to Specific User
// ===========================================
export async function emitToUser(userId: string, event: string, data: unknown): Promise<void> {
  const socketIO = (getIO() ?? getEmitter()) as unknown as Broadcaster;

  socketIO.to(`user:${userId}`).emit(event, data);
}

// ===========================================
// Emit to Conversation
// ===========================================
export async function emitToConversation(conversationId: string, event: string, data: unknown): Promise<void> {
  const socketIO = (getIO() ?? getEmitter()) as unknown as Broadcaster;

  socketIO.to(`conversation:${conversationId}`).emit(event, data);
}

// ===========================================
// Send Notification via Socket
// ===========================================
export async function sendNotification(
  userId: string,
  notification: {
    id: string;
    type: string;
    title: string;
    message: string;
    relatedId?: string;
    relatedType?: string;
    createdAt: Date;
  }
): Promise<void> {
  await emitToUser(userId, 'notification:new', notification);
}

// ===========================================
// Broadcast to All Connected Users
// ===========================================
export async function broadcastToAll(event: string, data: unknown): Promise<void> {
  const socketIO = (getIO() ?? getEmitter()) as unknown as Broadcaster;

  socketIO.emit(event, data);
}

// ===========================================
// Get Online Users Count
// ===========================================
export async function getOnlineUsersCount(): Promise<number> {
  const socketIO = getIO();
  if (!socketIO) return 0;

  const sockets = await socketIO.fetchSockets();
  return sockets.length;
}

const socketService = {
  initialize: initializeSocketServer,
  getIO,
  emitToUser,
  emitToConversation,
  sendNotification,
  broadcastToAll,
  getOnlineUsersCount,
};

export default socketService;
