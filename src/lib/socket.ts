/**
 * Socket.io Server Configuration
 * 
 * This module sets up the WebSocket server with:
 * 1. Redis adapter for horizontal scaling
 * 2. Authentication middleware
 * 3. Room management for conversations
 * 4. Event handlers for real-time messaging
 */

import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { redisPubSub, presence, session, typing } from './redis';
import { verifyToken } from './auth';
import prisma from './prisma';
import { UserRole, NotificationType } from '@prisma/client';
import { config } from '@/config';

// ===========================================
// Types
// ===========================================
export interface AuthenticatedSocket extends Socket {
  userId: string;
  userType: UserRole;
  userName: string;
}

export interface MessagePayload {
  conversationId: string;
  content: string;
  attachments?: string[];
}

export interface TypingPayload {
  conversationId: string;
  isTyping: boolean;
}

export interface JoinRoomPayload {
  conversationId: string;
}

// ===========================================
// Socket.io Server Instance
// ===========================================
let io: Server | null = null;

// ===========================================
// Map role string to UserRole enum
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
      origin: config.cors.allowedOrigins,
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

      const decoded = verifyToken(token);
      if (!decoded) {
        return next(new Error('Invalid token'));
      }

      // Attach user info to socket
      const authSocket = socket as AuthenticatedSocket;
      authSocket.userId = decoded.userId;
      authSocket.userType = mapToUserRole(decoded.role);
      authSocket.userName = decoded.email.split('@')[0]; // Use email prefix as display name

      next();
    } catch (error) {
      next(new Error('Authentication failed'));
    }
  });

  // Connection handler
  io.on('connection', async (socket: Socket) => {
    const authSocket = socket as AuthenticatedSocket;
    const { userId, userType, userName } = authSocket;

    console.log(`🔌 User connected: ${userName} (${userId}) - ${userType}`);

    // Track socket session
    await session.setSocket(userId, socket.id);
    await session.setSocketUser(socket.id, userId);
    await presence.setOnline(userId);

    // Join user's personal room for direct notifications
    socket.join(`user:${userId}`);

    // Emit online status to relevant users
    socket.broadcast.emit('user:online', { userId, userName });

    // ===========================================
    // Event Handlers
    // ===========================================

    // Join a conversation room
    socket.on('conversation:join', async (payload: JoinRoomPayload) => {
      try {
        const { conversationId } = payload;
        
        // Verify user is a participant
        const conversation = await prisma.conversation.findFirst({
          where: {
            id: conversationId,
            participantIds: { has: userId },
            isActive: true,
          },
        });

        if (!conversation) {
          socket.emit('error', { message: 'Conversation not found or access denied' });
          return;
        }

        socket.join(`conversation:${conversationId}`);
        console.log(`📝 User ${userName} joined conversation ${conversationId}`);

        // Notify others in the conversation
        socket.to(`conversation:${conversationId}`).emit('user:joined', {
          userId,
          userName,
          conversationId,
        });
      } catch (error) {
        console.error('Error joining conversation:', error);
        socket.emit('error', { message: 'Failed to join conversation' });
      }
    });

    // Leave a conversation room
    socket.on('conversation:leave', (payload: JoinRoomPayload) => {
      const { conversationId } = payload;
      socket.leave(`conversation:${conversationId}`);
      
      socket.to(`conversation:${conversationId}`).emit('user:left', {
        userId,
        userName,
        conversationId,
      });
    });

    // Send a message
    socket.on('message:send', async (payload: MessagePayload) => {
      try {
        const { conversationId, content, attachments } = payload;

        // Verify user is a participant
        const conversation = await prisma.conversation.findFirst({
          where: {
            id: conversationId,
            participantIds: { has: userId },
            isActive: true,
          },
        });

        if (!conversation) {
          socket.emit('error', { message: 'Conversation not found or access denied' });
          return;
        }

        // Create message in database
        const message = await prisma.message.create({
          data: {
            conversationId,
            senderId: userId,
            senderRole: userType,
            content,
            attachments: attachments || [],
            status: 'SENT',
          },
        });

        // Update conversation last message
        await prisma.conversation.update({
          where: { id: conversationId },
          data: {
            lastMessageAt: new Date(),
            lastMessageText: content.substring(0, 100),
            updatedAt: new Date(),
          },
        });

        // Clear typing indicator
        await typing.clearTyping(conversationId, userId);

        // Prepare message payload for broadcast
        const messagePayload = {
          id: message.id,
          conversationId: message.conversationId,
          senderId: message.senderId,
          senderRole: message.senderRole,
          senderName: userName,
          content: message.content,
          attachments: message.attachments,
          status: message.status,
          createdAt: message.createdAt,
        };

        // Emit to all participants in the conversation room
        io?.to(`conversation:${conversationId}`).emit('message:new', messagePayload);

        // Send notification to offline participants
        const otherParticipants = conversation.participantIds.filter(id => id !== userId);
        
        for (const participantId of otherParticipants) {
          const isOnline = await presence.isOnline(participantId);
          
          if (!isOnline) {
            // Create push notification (handled by notification queue)
            await prisma.notification.create({
              data: {
                userId: participantId,
                type: NotificationType.NEW_MESSAGE,
                title: `New message from ${userName}`,
                message: content.substring(0, 100) + (content.length > 100 ? '...' : ''),
                entityType: 'Conversation',
                entityId: conversationId,
              },
            });
          } else {
            // Emit to user's personal room
            io?.to(`user:${participantId}`).emit('notification:new', {
              type: 'NEW_MESSAGE',
              title: `New message from ${userName}`,
              message: content.substring(0, 100),
              conversationId,
            });
          }
        }

        // Acknowledge message sent
        socket.emit('message:sent', { 
          tempId: (socket.handshake.query as { tempId?: string }).tempId,
          messageId: message.id 
        });

      } catch (error) {
        console.error('Error sending message:', error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // Typing indicator
    socket.on('typing:start', async (payload: TypingPayload) => {
      const { conversationId } = payload;
      
      await typing.setTyping(conversationId, userId);
      
      socket.to(`conversation:${conversationId}`).emit('typing:update', {
        userId,
        userName,
        conversationId,
        isTyping: true,
      });
    });

    socket.on('typing:stop', async (payload: TypingPayload) => {
      const { conversationId } = payload;
      
      await typing.clearTyping(conversationId, userId);
      
      socket.to(`conversation:${conversationId}`).emit('typing:update', {
        userId,
        userName,
        conversationId,
        isTyping: false,
      });
    });

    // Mark messages as read
    socket.on('messages:read', async (payload: { conversationId: string; messageIds: string[] }) => {
      try {
        const { conversationId, messageIds } = payload;

        // Update message status
        await prisma.message.updateMany({
          where: {
            id: { in: messageIds },
            conversationId,
            senderId: { not: userId }, // Don't mark own messages
          },
          data: {
            status: 'READ',
            readAt: new Date(),
          },
        });

        // Notify sender that messages were read
        socket.to(`conversation:${conversationId}`).emit('messages:read', {
          conversationId,
          messageIds,
          readBy: userId,
          readAt: new Date(),
        });

      } catch (error) {
        console.error('Error marking messages as read:', error);
      }
    });

    // Presence heartbeat
    socket.on('heartbeat', async () => {
      await presence.setOnline(userId);
    });

    // Get online status
    socket.on('presence:check', async (payload: { userIds: string[] }) => {
      const onlineStatus = await presence.getOnlineUsers(payload.userIds);
      socket.emit('presence:status', onlineStatus);
    });

    // ===========================================
    // Disconnect Handler
    // ===========================================
    socket.on('disconnect', async (reason) => {
      console.log(`🔌 User disconnected: ${userName} (${userId}) - ${reason}`);

      // Remove socket session
      await session.removeSocket(userId, socket.id);

      // Check if user has other active sockets
      const remainingSockets = await session.getSockets(userId);
      
      if (remainingSockets.length === 0) {
        // User is fully offline
        await presence.setOffline(userId);
        
        // Notify others
        socket.broadcast.emit('user:offline', { 
          userId, 
          userName,
          lastSeen: new Date(),
        });
      }
    });

    // Error handler
    socket.on('error', (error) => {
      console.error(`Socket error for user ${userName}:`, error);
    });
  });

  console.log('✅ Socket.io server initialized');
  return io;
}

// ===========================================
// Get Socket.io Instance
// ===========================================
export function getIO(): Server | null {
  return io;
}

// ===========================================
// Emit to Specific User
// ===========================================
export async function emitToUser(userId: string, event: string, data: unknown): Promise<void> {
  const socketIO = getIO();
  if (!socketIO) {
    console.warn('Socket.io not initialized');
    return;
  }

  socketIO.to(`user:${userId}`).emit(event, data);
}

// ===========================================
// Emit to Conversation
// ===========================================
export async function emitToConversation(conversationId: string, event: string, data: unknown): Promise<void> {
  const socketIO = getIO();
  if (!socketIO) {
    console.warn('Socket.io not initialized');
    return;
  }

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
  const socketIO = getIO();
  if (!socketIO) {
    console.warn('Socket.io not initialized');
    return;
  }

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

export default {
  initialize: initializeSocketServer,
  getIO,
  emitToUser,
  emitToConversation,
  sendNotification,
  broadcastToAll,
  getOnlineUsersCount,
};
