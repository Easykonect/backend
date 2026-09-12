/**
 * Socket.IO connections: authentication, when handlers attach, messaging events, typing,
 * presence, CORS and the periodic session re-check
 */

jest.mock('socket.io', () => ({
  Server: jest.fn().mockImplementation(() => ({ use: jest.fn(), on: jest.fn(), adapter: jest.fn() })),
}));
jest.mock('@socket.io/redis-adapter', () => ({ createAdapter: jest.fn() }));
jest.mock('@socket.io/redis-emitter', () => ({ Emitter: jest.fn() }));

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
    conversation: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}));

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { getInstance: jest.fn() },
  redisPubSub: { connect: jest.fn() },
  presence: { setOnline: jest.fn(), setOffline: jest.fn(), getOnlineUsers: jest.fn() },
  session: { setSocket: jest.fn(), removeSocket: jest.fn(), getSockets: jest.fn() },
  typing: { setTyping: jest.fn(), clearTyping: jest.fn() },
  rateLimit: { check: jest.fn() },
}));

jest.mock('@/lib/auth', () => ({ verifyAccessToken: jest.fn() }));
jest.mock('@/middleware/auth.middleware', () => ({ isSessionAllowed: jest.fn() }));
jest.mock('@/services/messaging.service', () => ({
  sendMessage: jest.fn(),
  markMessagesAsRead: jest.fn(),
}));

import type { Server as HttpServer } from 'http';
import { GraphQLError } from 'graphql';
import { Server } from 'socket.io';
import prisma from '@/lib/prisma';
import { presence, rateLimit, redisPubSub, session, typing } from '@/lib/redis';
import { verifyAccessToken } from '@/lib/auth';
import { isSessionAllowed } from '@/middleware/auth.middleware';
import { RateLimitConfig } from '@/middleware/rate-limit.middleware';
import { markMessagesAsRead, sendMessage } from '@/services/messaging.service';
import { initializeSocketServer } from '@/lib/socket';

const USER_ID = '66e29f00c3b2a10012ab3400';
const CONTACT_ID = '66e29f55c3b2a10012ab3455';
const SECOND_CONTACT_ID = '66e29f77c3b2a10012ab3477';
const CONVERSATION_ID = '66e2a1f4c3b2a10012ab34cd';
const SECOND_CONVERSATION_ID = '66e2a1f4c3b2a10012ab34ce';
const NEW_CONVERSATION_ID = '66e2a1f4c3b2a10012ab34cf';
const MESSAGE_ID = '66e2b0c1c3b2a10012ab3501';
const MINUTE = 60 * 1000;
const CONTACT_ROOMS = [`user:${CONTACT_ID}`, `user:${SECOND_CONTACT_ID}`];

const mocked = (fn: unknown) => fn as jest.Mock;

type Handler = (payload?: unknown) => unknown;
interface Broadcast {
  rooms: string | string[];
  event: string;
  data: unknown;
}

interface FakeSocketObject {
  id: string;
  connected: boolean;
  handshake: { auth: { token: string }; headers: Record<string, string>; query: Record<string, string> };
  rooms: Set<string>;
  on: jest.Mock;
  emit: jest.Mock;
  join: jest.Mock;
  leave: jest.Mock;
  to: jest.Mock;
  disconnect: jest.Mock;
}

const createSocket = (id: string, query: Record<string, string>) => {
  const handlers = new Map<string, Handler>();
  const broadcasts: Broadcast[] = [];
  const socket: FakeSocketObject = {
    id,
    connected: true,
    handshake: { auth: { token: 'access-token' }, headers: {}, query },
    rooms: new Set<string>(),
    on: jest.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
      return socket;
    }),
    emit: jest.fn(),
    join: jest.fn((room: string) => {
      socket.rooms.add(room);
    }),
    leave: jest.fn((room: string) => {
      socket.rooms.delete(room);
    }),
    to: jest.fn((rooms: string | string[]) => ({
      emit: (event: string, data: unknown) => {
        broadcasts.push({ rooms, event, data });
      },
    })),
    disconnect: jest.fn(() => {
      socket.connected = false;
    }),
  };
  return { socket, handlers, broadcasts };
};
type FakeSocket = ReturnType<typeof createSocket>;

const tokenPayload = (overrides: Record<string, unknown> = {}) => ({
  userId: USER_ID,
  email: 'ada.obi@example.com',
  role: 'SERVICE_USER',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  ...overrides,
});

let authenticate: (socket: unknown, next: jest.Mock) => Promise<void>;
let onConnection: (socket: unknown) => void;

const flush = () => new Promise((resolve) => setImmediate(resolve));

const connect = async ({ id = 'socket-1', query = {} }: { id?: string; query?: Record<string, string> } = {}) => {
  const client = createSocket(id, query);
  const next = jest.fn();
  await authenticate(client.socket, next);
  expect(next).toHaveBeenCalledWith();
  onConnection(client.socket);
  await flush();
  return client;
};

const send = async (client: FakeSocket, event: string, payload?: unknown) => {
  const handler = client.handlers.get(event);
  if (!handler) throw new Error(`No handler for ${event}`);
  handler(payload);
  await flush();
};

const broadcastsOf = (client: FakeSocket, event: string) =>
  client.broadcasts.filter((broadcast) => broadcast.event === event);

const emitsOf = (client: FakeSocket, event: string) =>
  client.socket.emit.mock.calls.filter(([name]) => name === event).map(([, data]) => data);

beforeAll(async () => {
  mocked(redisPubSub.connect).mockResolvedValue({ pub: {}, sub: {} });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await initializeSocketServer({} as HttpServer);

  const server = mocked(Server).mock.results[0].value;
  authenticate = server.use.mock.calls[0][0];
  onConnection = server.on.mock.calls.find(([event]: [string]) => event === 'connection')[1];
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);

  mocked(verifyAccessToken).mockReturnValue(tokenPayload());
  mocked(isSessionAllowed).mockResolvedValue(true);
  mocked(prisma.user.findUnique).mockResolvedValue({ firstName: 'Ada', lastName: 'Obi' });
  mocked(prisma.conversation.findMany).mockResolvedValue([
    { id: CONVERSATION_ID, participantIds: [USER_ID, CONTACT_ID] },
    { id: SECOND_CONVERSATION_ID, participantIds: [SECOND_CONTACT_ID, USER_ID] },
  ]);
  mocked(prisma.conversation.findFirst).mockResolvedValue(null);

  mocked(session.setSocket).mockResolvedValue(undefined);
  mocked(session.removeSocket).mockResolvedValue(undefined);
  mocked(session.getSockets).mockResolvedValue([]);
  mocked(presence.setOnline).mockResolvedValue(undefined);
  mocked(presence.setOffline).mockResolvedValue(undefined);
  mocked(presence.getOnlineUsers).mockResolvedValue({});
  mocked(typing.setTyping).mockResolvedValue(undefined);
  mocked(typing.clearTyping).mockResolvedValue(undefined);
  mocked(rateLimit.check).mockResolvedValue({ allowed: true, remaining: 59, resetIn: 60 });

  mocked(sendMessage).mockResolvedValue({ id: MESSAGE_ID });
  mocked(markMessagesAsRead).mockResolvedValue({ success: true, message: 'Messages marked as read' });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('connecting', () => {
  it('names the user by first and last name, loaded once at connect', async () => {
    const { socket } = await connect();

    expect(socket).toMatchObject({ userId: USER_ID, userName: 'Ada Obi' });
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('names a user without a name "Someone"', async () => {
    mocked(prisma.user.findUnique).mockResolvedValue({ firstName: '', lastName: '' });

    const { socket } = await connect();

    expect(socket).toMatchObject({ userName: 'Someone' });
  });

  it('refuses a session that is no longer allowed', async () => {
    mocked(isSessionAllowed).mockResolvedValue(false);
    const { socket } = createSocket('socket-1', {});
    const next = jest.fn();

    await authenticate(socket, next);

    expect(next).toHaveBeenCalledWith(new Error('Invalid token'));
  });

  it('attaches every handler before the Redis writes finish', async () => {
    mocked(session.setSocket).mockReturnValue(new Promise(() => undefined));
    mocked(presence.setOnline).mockReturnValue(new Promise(() => undefined));
    const client = createSocket('socket-1', {});
    await authenticate(client.socket, jest.fn());

    onConnection(client.socket);

    expect([...client.handlers.keys()]).toEqual(
      expect.arrayContaining([
        'conversation:join',
        'conversation:leave',
        'message:send',
        'messages:read',
        'typing:start',
        'typing:stop',
        'heartbeat',
        'presence:check',
        'disconnect',
      ])
    );
    await send(client, 'message:send', { conversationId: CONVERSATION_ID, content: 'Hello', tempId: 't1' });
    expect(emitsOf(client, 'message:sent')).toEqual([{ tempId: 't1', messageId: MESSAGE_ID }]);
  });

  it('keeps handling events when Redis is unavailable', async () => {
    mocked(session.setSocket).mockRejectedValue(new Error('Redis unavailable'));
    mocked(presence.setOnline).mockRejectedValue(new Error('Redis unavailable'));

    const client = await connect();
    await send(client, 'typing:start', { conversationId: CONVERSATION_ID });

    expect(broadcastsOf(client, 'typing:update')).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to record socket socket-1'),
      'Redis unavailable'
    );
  });

  it('survives malformed payloads and failing handlers', async () => {
    mocked(presence.getOnlineUsers).mockRejectedValue(new Error('Redis unavailable'));
    const client = await connect();

    const events = ['conversation:join', 'conversation:leave', 'message:send', 'messages:read', 'typing:start', 'typing:stop', 'presence:check', 'heartbeat'];
    for (const event of events) {
      for (const payload of [undefined, null, 42, 'text', { conversationId: 7, messageIds: 'x' }]) {
        expect(() => client.handlers.get(event)?.(payload)).not.toThrow();
      }
    }
    await send(client, 'presence:check', { userIds: [CONTACT_ID] });

    expect(console.error).toHaveBeenCalledWith(
      `Socket event presence:check failed for user ${USER_ID}:`,
      'Redis unavailable'
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(markMessagesAsRead).not.toHaveBeenCalled();
    expect(emitsOf(client, 'error')).toContainEqual({
      message: 'Conversation not found or access denied',
      event: 'message:send',
    });
  });
});

describe('conversation rooms', () => {
  it('lets a participant join, archived conversations included', async () => {
    const client = await connect();

    await send(client, 'conversation:join', { conversationId: CONVERSATION_ID });

    expect(client.socket.join).toHaveBeenCalledWith(`conversation:${CONVERSATION_ID}`);
    expect(broadcastsOf(client, 'user:joined')).toEqual([
      {
        rooms: `conversation:${CONVERSATION_ID}`,
        event: 'user:joined',
        data: { userId: USER_ID, userName: 'Ada Obi', conversationId: CONVERSATION_ID },
      },
    ]);
    // Archiving sets isActive to false; the participation check doesn't filter on it
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { participantIds: { has: USER_ID } } })
    );
  });

  it('looks up a conversation missing from the loaded list', async () => {
    mocked(prisma.conversation.findFirst).mockResolvedValue({ participantIds: [USER_ID, CONTACT_ID] });
    const client = await connect();

    await send(client, 'conversation:join', { conversationId: NEW_CONVERSATION_ID });

    expect(prisma.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: NEW_CONVERSATION_ID, participantIds: { has: USER_ID } } })
    );
    expect(client.socket.join).toHaveBeenCalledWith(`conversation:${NEW_CONVERSATION_ID}`);
  });

  it('refuses a conversation the user is not in', async () => {
    const client = await connect();

    await send(client, 'conversation:join', { conversationId: NEW_CONVERSATION_ID });

    expect(client.socket.join).not.toHaveBeenCalledWith(`conversation:${NEW_CONVERSATION_ID}`);
    expect(emitsOf(client, 'error')).toEqual([
      { message: 'Conversation not found or access denied', event: 'conversation:join' },
    ]);
  });

  it('announces leaving only from a socket in the room', async () => {
    const client = await connect();

    await send(client, 'conversation:leave', { conversationId: CONVERSATION_ID });
    expect(broadcastsOf(client, 'user:left')).toHaveLength(0);

    await send(client, 'conversation:join', { conversationId: CONVERSATION_ID });
    await send(client, 'conversation:leave', { conversationId: CONVERSATION_ID });
    expect(client.socket.leave).toHaveBeenCalledWith(`conversation:${CONVERSATION_ID}`);
    expect(broadcastsOf(client, 'user:left')).toHaveLength(1);
  });
});

describe('message:send', () => {
  it('echoes the tempId sent with each message', async () => {
    mocked(sendMessage).mockResolvedValueOnce({ id: 'message-1' }).mockResolvedValueOnce({ id: 'message-2' });
    const client = await connect();

    await send(client, 'message:send', { conversationId: CONVERSATION_ID, content: 'One', tempId: 'temp-1' });
    await send(client, 'message:send', { conversationId: CONVERSATION_ID, content: 'Two', tempId: 'temp-2' });

    expect(emitsOf(client, 'message:sent')).toEqual([
      { tempId: 'temp-1', messageId: 'message-1' },
      { tempId: 'temp-2', messageId: 'message-2' },
    ]);
    expect(sendMessage).toHaveBeenCalledWith(USER_ID, 'SERVICE_USER', {
      conversationId: CONVERSATION_ID,
      content: 'One',
      attachments: [],
    });
  });

  it('falls back to the tempId the socket connected with', async () => {
    const client = await connect({ query: { tempId: 'legacy' } });

    await send(client, 'message:send', { conversationId: CONVERSATION_ID, content: 'Hi' });
    await send(client, 'message:send', { conversationId: CONVERSATION_ID, content: 'Hi', tempId: 7 });

    expect(emitsOf(client, 'message:sent')).toEqual([
      { tempId: 'legacy', messageId: MESSAGE_ID },
      { tempId: 7, messageId: MESSAGE_ID },
    ]);
  });

  it('shares the GraphQL per-user MESSAGE budget of 60 a minute', async () => {
    const client = await connect();

    await send(client, 'message:send', { conversationId: CONVERSATION_ID, content: 'Hi' });

    expect(RateLimitConfig.MESSAGE).toEqual({ limit: 60, windowSeconds: 60 });
    expect(rateLimit.check).toHaveBeenCalledWith(`gql:message:user:${USER_ID}`, 60, 60);
  });

  it('refuses a message over the limit with the seconds to wait', async () => {
    mocked(rateLimit.check).mockResolvedValue({ allowed: false, remaining: 0, resetIn: 42 });
    const client = await connect();

    await send(client, 'message:send', { conversationId: CONVERSATION_ID, content: 'Hi', tempId: 'temp-1' });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(emitsOf(client, 'error')).toEqual([
      {
        message: 'Too many messages. Please try again in 42 seconds.',
        event: 'message:send',
        code: 'RATE_LIMITED',
        retryAfter: 42,
        tempId: 'temp-1',
      },
    ]);
  });

  it('reports why a message was refused, with its tempId', async () => {
    mocked(sendMessage).mockRejectedValue(new GraphQLError("You can't send messages in this conversation"));
    const client = await connect();

    await send(client, 'message:send', { conversationId: CONVERSATION_ID, content: 'Hi', tempId: 'temp-1' });

    expect(emitsOf(client, 'error')).toEqual([
      { message: "You can't send messages in this conversation", event: 'message:send', tempId: 'temp-1' },
    ]);
    expect(emitsOf(client, 'message:sent')).toEqual([]);
  });

  it('still acknowledges a saved message when clearing the typing indicator fails', async () => {
    mocked(typing.clearTyping).mockRejectedValue(new Error('Redis unavailable'));
    const client = await connect();

    await send(client, 'message:send', { conversationId: CONVERSATION_ID, content: 'Hi', tempId: 'temp-1' });

    expect(emitsOf(client, 'message:sent')).toEqual([{ tempId: 'temp-1', messageId: MESSAGE_ID }]);
    expect(emitsOf(client, 'error')).toEqual([]);
  });
});

describe('messages:read', () => {
  it('marks messages read like the markMessagesAsRead mutation and tells the room', async () => {
    const client = await connect();

    await send(client, 'messages:read', {
      conversationId: CONVERSATION_ID,
      messageIds: [MESSAGE_ID, MESSAGE_ID, 'not-an-id'],
    });

    expect(markMessagesAsRead).toHaveBeenCalledWith(USER_ID, CONVERSATION_ID, [MESSAGE_ID]);
    expect(broadcastsOf(client, 'messages:read')).toEqual([
      {
        rooms: `conversation:${CONVERSATION_ID}`,
        event: 'messages:read',
        data: {
          conversationId: CONVERSATION_ID,
          messageIds: [MESSAGE_ID],
          readBy: USER_ID,
          readAt: expect.any(Date),
        },
      },
    ]);
  });

  it('refuses a conversation the user is not in', async () => {
    mocked(markMessagesAsRead).mockRejectedValue(new GraphQLError('Conversation not found or access denied'));
    const client = await connect();

    await send(client, 'messages:read', { conversationId: NEW_CONVERSATION_ID, messageIds: [MESSAGE_ID] });

    expect(emitsOf(client, 'error')).toEqual([
      { message: 'Conversation not found or access denied', event: 'messages:read' },
    ]);
    expect(broadcastsOf(client, 'messages:read')).toHaveLength(0);
  });

  it('does nothing without message IDs', async () => {
    const client = await connect();

    await send(client, 'messages:read', { conversationId: CONVERSATION_ID, messageIds: [] });
    await send(client, 'messages:read', { conversationId: CONVERSATION_ID });

    expect(markMessagesAsRead).not.toHaveBeenCalled();
    expect(broadcastsOf(client, 'messages:read')).toHaveLength(0);
  });
});

describe('typing indicators', () => {
  it('relays typing in a conversation loaded at connect without querying again', async () => {
    const client = await connect();

    await send(client, 'typing:start', { conversationId: CONVERSATION_ID });
    await send(client, 'typing:stop', { conversationId: CONVERSATION_ID });

    const update = (isTyping: boolean) => ({
      rooms: `conversation:${CONVERSATION_ID}`,
      event: 'typing:update',
      data: { userId: USER_ID, userName: 'Ada Obi', conversationId: CONVERSATION_ID, isTyping },
    });
    expect(broadcastsOf(client, 'typing:update')).toEqual([update(true), update(false)]);
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(typing.setTyping).toHaveBeenCalledWith(CONVERSATION_ID, USER_ID);
  });

  it('ignores typing in a conversation the user is not in, asking the database once', async () => {
    const client = await connect();

    for (let i = 0; i < 3; i += 1) {
      await send(client, 'typing:start', { conversationId: NEW_CONVERSATION_ID });
    }

    expect(broadcastsOf(client, 'typing:update')).toHaveLength(0);
    expect(typing.setTyping).not.toHaveBeenCalled();
    expect(prisma.conversation.findFirst).toHaveBeenCalledTimes(1);
  });

  it('remembers a conversation started after connecting', async () => {
    mocked(prisma.conversation.findFirst).mockResolvedValue({ participantIds: [USER_ID, CONTACT_ID] });
    const client = await connect();

    await send(client, 'typing:start', { conversationId: NEW_CONVERSATION_ID });
    await send(client, 'typing:start', { conversationId: NEW_CONVERSATION_ID });

    expect(broadcastsOf(client, 'typing:update')).toHaveLength(2);
    expect(prisma.conversation.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('presence', () => {
  it('announces a user online only to people who share a conversation with them', async () => {
    const client = await connect();

    expect(broadcastsOf(client, 'user:online')).toEqual([
      { rooms: CONTACT_ROOMS, event: 'user:online', data: { userId: USER_ID, userName: 'Ada Obi' } },
    ]);
  });

  it('announces offline to the same people when the last socket disconnects', async () => {
    const client = await connect();

    await send(client, 'disconnect', 'transport close');

    expect(session.removeSocket).toHaveBeenCalledWith(USER_ID, 'socket-1');
    expect(presence.setOffline).toHaveBeenCalledWith(USER_ID);
    expect(broadcastsOf(client, 'user:offline')).toEqual([
      {
        rooms: CONTACT_ROOMS,
        event: 'user:offline',
        data: { userId: USER_ID, userName: 'Ada Obi', lastSeen: expect.any(Date) },
      },
    ]);
  });

  it('keeps the user online while another socket is connected', async () => {
    mocked(session.getSockets).mockResolvedValue(['socket-2']);
    const client = await connect();

    await send(client, 'disconnect', 'transport close');

    expect(presence.setOffline).not.toHaveBeenCalled();
    expect(broadcastsOf(client, 'user:offline')).toHaveLength(0);
  });

  it('sends no presence updates for a user without conversations', async () => {
    mocked(prisma.conversation.findMany).mockResolvedValue([]);
    const client = await connect();

    await send(client, 'disconnect', 'transport close');

    expect(client.broadcasts).toEqual([]);
  });

  it('refreshes presence on heartbeat', async () => {
    const client = await connect();

    await send(client, 'heartbeat');

    expect(presence.setOnline).toHaveBeenCalledTimes(2);
  });

  it('refreshes the socket record every minute until the socket disconnects', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const client = await connect();
    expect(session.setSocket).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2 * MINUTE);
    expect(session.setSocket).toHaveBeenCalledTimes(3);

    await send(client, 'disconnect', 'transport close');
    await jest.advanceTimersByTimeAsync(10 * MINUTE);
    expect(session.setSocket).toHaveBeenCalledTimes(3);
  });
});

describe('session re-check', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });

  it('does not check again within the first four minutes', async () => {
    await connect();

    await jest.advanceTimersByTimeAsync(4 * MINUTE);

    expect(isSessionAllowed).toHaveBeenCalledTimes(1);
  });

  it('ends a socket whose session is no longer allowed', async () => {
    const client = await connect();
    mocked(isSessionAllowed).mockResolvedValue(false);

    await jest.advanceTimersByTimeAsync(6 * MINUTE);

    expect(emitsOf(client, 'session:ended')).toEqual([
      {
        reason: 'SESSION_REVOKED',
        message: 'Your session is no longer valid. Refresh your access token or sign in again.',
      },
    ]);
    expect(client.socket.disconnect).toHaveBeenCalledWith(true);
    // Checked with the raw token too, at connect and again later, so sign-outs are matched
    expect(isSessionAllowed).toHaveBeenCalledTimes(2);
    expect(isSessionAllowed).toHaveBeenNthCalledWith(1, expect.objectContaining({ userId: USER_ID }), 'access-token');
    expect(isSessionAllowed).toHaveBeenLastCalledWith(expect.objectContaining({ userId: USER_ID }), 'access-token');
  });

  it('ends a socket whose access token has expired', async () => {
    mocked(verifyAccessToken).mockReturnValue(tokenPayload({ exp: Math.floor(Date.now() / 1000) + 60 }));
    const client = await connect();

    await jest.advanceTimersByTimeAsync(6 * MINUTE);

    expect(emitsOf(client, 'session:ended')).toEqual([
      { reason: 'TOKEN_EXPIRED', message: 'Your access token has expired. Refresh it and connect again.' },
    ]);
    expect(client.socket.disconnect).toHaveBeenCalledWith(true);
    expect(isSessionAllowed).toHaveBeenCalledTimes(1);
  });

  it('keeps the socket when the check cannot run, and checks again later', async () => {
    const client = await connect();
    mocked(isSessionAllowed).mockRejectedValue(new Error('Database unavailable'));

    await jest.advanceTimersByTimeAsync(6 * MINUTE);
    expect(client.socket.disconnect).not.toHaveBeenCalled();

    mocked(isSessionAllowed).mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(6 * MINUTE);
    expect(client.socket.disconnect).toHaveBeenCalledWith(true);
  });
});

describe('CORS', () => {
  const originsFor = async (env: { WEBSOCKET_CORS_ORIGINS: string; CORS_ALLOWED_ORIGINS: string }) => {
    const saved = {
      WEBSOCKET_CORS_ORIGINS: process.env.WEBSOCKET_CORS_ORIGINS,
      CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
    };
    Object.assign(process.env, env);
    try {
      let origin: unknown;
      await jest.isolateModulesAsync(async () => {
        const socketIo = await import('socket.io');
        const socketModule = await import('@/lib/socket');
        await socketModule.initializeSocketServer({} as HttpServer);
        origin = mocked(socketIo.Server).mock.calls[0][1].cors.origin;
      });
      return origin;
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  it('allows the origins in WEBSOCKET_CORS_ORIGINS', async () => {
    await expect(
      originsFor({
        WEBSOCKET_CORS_ORIGINS: 'https://admin.example.com, https://ops.example.com',
        CORS_ALLOWED_ORIGINS: 'https://www.example.com',
      })
    ).resolves.toEqual(['https://admin.example.com', 'https://ops.example.com']);
  });

  it('falls back to CORS_ALLOWED_ORIGINS when WEBSOCKET_CORS_ORIGINS is empty', async () => {
    await expect(
      originsFor({ WEBSOCKET_CORS_ORIGINS: '', CORS_ALLOWED_ORIGINS: 'https://www.example.com' })
    ).resolves.toEqual(['https://www.example.com']);
  });
});
