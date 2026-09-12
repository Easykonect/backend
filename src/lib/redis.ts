/**
 * Redis Client Configuration
 * 
 * This module sets up Redis connections for:
 * 1. General caching and data storage
 * 2. Socket.io adapter (for scaling across multiple servers)
 * 3. BullMQ job queues (background task processing)
 * 
 * Uses Upstash Redis for cloud-hosted, serverless Redis
 */

import Redis, { RedisOptions } from 'ioredis';
import { config } from '@/config';
import logger from './logger';

// ===========================================
// Redis Connection URL
// ===========================================
const REDIS_URL = config.redisUrl;

// Detect if using Upstash (requires TLS)
const isUpstash = REDIS_URL.includes('upstash.io');
const usesTLS = REDIS_URL.startsWith('rediss://');

// Track connection state to avoid log spam
let isConnected = false;

// ===========================================
// Redis Connection Options
// ===========================================
const redisOptions: RedisOptions = {
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,
  
  // TLS configuration for Upstash
  ...(isUpstash || usesTLS ? {
    tls: {
      rejectUnauthorized: false,
    },
  } : {}),
  
  // Keep-alive to prevent connection drops
  keepAlive: 30000, // 30 seconds
  connectTimeout: 10000, // 10 seconds
  
  // Smarter retry strategy with reduced logging
  retryStrategy: (times: number) => {
    // Never give up: returning null would leave the process without Redis
    // until it restarts. The backoff below is capped at 30 seconds.
    // Exponential backoff: 1s, 2s, 4s, 8s... up to 30 seconds
    const delay = Math.min(Math.pow(2, times) * 1000, 30000);
    
    // Only log every 5th attempt or first/last to reduce noise
    if (times === 1 || times % 5 === 0) {
      logger.warn(`🔄 Redis reconnecting in ${delay / 1000}s (attempt ${times})`);
    }
    return delay;
  },
  
  // Only reconnect on specific errors
  reconnectOnError: (err: Error) => {
    const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'];
    if (targetErrors.some(e => err.message.includes(e))) {
      logger.dev('🔄 Redis reconnecting due to error:', err.message);
      return true;
    }
    return false;
  },
  
  // Disable offline queue to fail fast when disconnected
  enableOfflineQueue: true,
  
  // Connection name for debugging
  connectionName: 'easykonect-main',
};

// ===========================================
// Main Redis Client (for general operations)
// ===========================================
// How long a caller waits for an in-flight connection, and for one command
const READY_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 5000;

/**
 * Wait for a connecting or reconnecting client to become ready
 */
const waitForReady = (client: Redis): Promise<void> =>
  new Promise((resolve, reject) => {
    if (client.status === 'ready') return resolve();
    const onReady = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      client.off('ready', onReady);
      reject(new Error(`Redis is not ready (status: ${client.status})`));
    }, READY_TIMEOUT_MS);
    client.once('ready', onReady);
  });

/**
 * Collect keys matching a pattern with SCAN (KEYS blocks Redis on large datasets)
 */
const scanKeys = async (client: Redis, pattern: string): Promise<string[]> => {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
};

class RedisClient {
  private static instance: Redis | null = null;

  static getInstance(): Redis {
    if (!this.instance) {
      this.instance = new Redis(REDIS_URL, {
        ...redisOptions,
        lazyConnect: true,
        // Fail commands during an outage instead of queueing them forever, so
        // callers (rate limits, locks, token checks) error out quickly
        maxRetriesPerRequest: 2,
        commandTimeout: COMMAND_TIMEOUT_MS,
      });

      this.setupEventHandlers(this.instance, 'Main');
    }
    return this.instance;
  }

  static async connect(): Promise<Redis> {
    const client = this.getInstance();
    
    // A connection attempt is in flight, or ioredis is reconnecting after a
    // drop: wait for it, with a timeout instead of polling forever
    if (client.status !== 'ready' && client.status !== 'wait' && client.status !== 'end') {
      await waitForReady(client);
      return client;
    }

    if (client.status === 'ready') {
      return client;
    }

    // Start the lazy connection
    
    try {
      await client.connect();
      return client;
    } catch (error) {
      // Another caller started connecting first
      if (['connecting', 'connect'].includes(client.status)) {
        await waitForReady(client);
        return client;
      }
      throw error;
    }
  }

  static async disconnect(): Promise<void> {
    if (this.instance) {
      await this.instance.quit();
      this.instance = null;
    }
  }

  private static setupEventHandlers(client: Redis, name: string): void {
    client.on('connect', () => {
      if (!isConnected) {
        logger.info(`✅ ${name} Redis client connected`);
        isConnected = true;
      }
    });

    client.on('ready', () => {
      logger.once('info', `redis-ready-${name}`, `✅ ${name} Redis client ready`);
    });

    client.on('error', (error) => {
      logger.error(`❌ ${name} Redis client error:`, error.message);
    });

    client.on('close', () => {
      if (isConnected) {
        logger.dev(`🔌 ${name} Redis connection closed`);
        isConnected = false;
      }
    });

    client.on('reconnecting', () => {
      // Handled by retryStrategy - don't double log
    });
  }
}

// ===========================================
// Pub/Sub Clients (for Socket.io adapter)
// These need separate connections for publish and subscribe
// ===========================================
class RedisPubSub {
  private static pubClient: Redis | null = null;
  private static subClient: Redis | null = null;

  static getPubClient(): Redis {
    if (!this.pubClient) {
      this.pubClient = new Redis(REDIS_URL, {
        ...redisOptions,
        lazyConnect: true,
      });
      this.setupEventHandlers(this.pubClient, 'Pub');
    }
    return this.pubClient;
  }

  static getSubClient(): Redis {
    if (!this.subClient) {
      this.subClient = new Redis(REDIS_URL, {
        ...redisOptions,
        lazyConnect: true,
      });
      this.setupEventHandlers(this.subClient, 'Sub');
    }
    return this.subClient;
  }

  static async connect(): Promise<{ pub: Redis; sub: Redis }> {
    const pub = this.getPubClient();
    const sub = this.getSubClient();

    await Promise.all([
      pub.status !== 'ready' ? pub.connect() : Promise.resolve(),
      sub.status !== 'ready' ? sub.connect() : Promise.resolve(),
    ]);

    return { pub, sub };
  }

  static async disconnect(): Promise<void> {
    await Promise.all([
      this.pubClient?.quit(),
      this.subClient?.quit(),
    ]);
    this.pubClient = null;
    this.subClient = null;
  }

  private static setupEventHandlers(client: Redis, name: string): void {
    client.on('connect', () => {
      logger.once('info', `redis-pubsub-${name}`, `✅ Redis ${name} client connected`);
    });

    client.on('error', (error) => {
      logger.error(`❌ Redis ${name} client error:`, error.message);
    });
  }
}

// ===========================================
// Queue Connection (for BullMQ)
// ===========================================
class RedisQueue {
  private static connection: Redis | null = null;

  static getConnection(): Redis {
    if (!this.connection) {
      this.connection = new Redis(REDIS_URL, {
        ...redisOptions,
        maxRetriesPerRequest: null, // Required for BullMQ
      });

      this.connection.on('connect', () => {
        logger.once('info', 'redis-queue', '✅ Redis Queue connection established');
      });

      this.connection.on('error', (error) => {
        logger.error('❌ Redis Queue connection error:', error.message);
      });
    }
    return this.connection;
  }

  static async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.quit();
      this.connection = null;
    }
  }
}

// ===========================================
// Cache Helper Functions
// ===========================================
export const cache = {
  /**
   * Set a value in cache with optional expiration
   */
  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const client = await RedisClient.connect();
    const serialized = JSON.stringify(value);
    
    if (ttlSeconds) {
      await client.setex(key, ttlSeconds, serialized);
    } else {
      await client.set(key, serialized);
    }
  },

  /**
   * Get a value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    const client = await RedisClient.connect();
    const value = await client.get(key);
    
    if (!value) return null;
    
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  },

  /**
   * Delete a value from cache
   */
  async del(key: string): Promise<void> {
    const client = await RedisClient.connect();
    await client.del(key);
  },

  /**
   * Delete multiple keys matching a pattern
   */
  async delPattern(pattern: string): Promise<void> {
    const client = await RedisClient.connect();
    const keys = await scanKeys(client, pattern);
    
    if (keys.length > 0) {
      await client.del(...keys);
    }
  },

  /**
   * Check if a key exists
   */
  async exists(key: string): Promise<boolean> {
    const client = await RedisClient.connect();
    const result = await client.exists(key);
    return result === 1;
  },

  /**
   * Set expiration on an existing key
   */
  async expire(key: string, ttlSeconds: number): Promise<void> {
    const client = await RedisClient.connect();
    await client.expire(key, ttlSeconds);
  },

  /**
   * Increment a counter
   */
  async incr(key: string): Promise<number> {
    const client = await RedisClient.connect();
    return client.incr(key);
  },

  /**
   * Decrement a counter
   */
  async decr(key: string): Promise<number> {
    const client = await RedisClient.connect();
    return client.decr(key);
  },
};

// ===========================================
// User Presence Helpers
// ===========================================
export const presence = {
  // A user counts as online for 3 minutes after connecting or sending `heartbeat`. Apps send
  // `heartbeat` every 60 seconds while in the foreground; a user who stops expires on their own.
  ONLINE_TTL: 180,

  /**
   * Mark a user as online
   */
  async setOnline(userId: string): Promise<void> {
    const client = await RedisClient.connect();
    const key = `presence:${userId}`;
    await client.setex(key, this.ONLINE_TTL, Date.now().toString());
  },

  /**
   * Check if a user is online
   */
  async isOnline(userId: string): Promise<boolean> {
    const client = await RedisClient.connect();
    const key = `presence:${userId}`;
    const result = await client.exists(key);
    return result === 1;
  },

  /**
   * Get last seen timestamp
   */
  async getLastSeen(userId: string): Promise<Date | null> {
    const client = await RedisClient.connect();
    const key = `presence:${userId}`;
    const timestamp = await client.get(key);
    return timestamp ? new Date(parseInt(timestamp)) : null;
  },

  /**
   * Get online status for multiple users
   */
  async getOnlineUsers(userIds: string[]): Promise<Record<string, boolean>> {
    const client = await RedisClient.connect();
    const pipeline = client.pipeline();
    
    userIds.forEach(id => pipeline.exists(`presence:${id}`));
    
    const results = await pipeline.exec();
    const onlineStatus: Record<string, boolean> = {};
    
    userIds.forEach((id, index) => {
      const result = results?.[index];
      onlineStatus[id] = result ? result[1] === 1 : false;
    });
    
    return onlineStatus;
  },

  /**
   * Remove user from online status
   */
  async setOffline(userId: string): Promise<void> {
    const client = await RedisClient.connect();
    await client.del(`presence:${userId}`);
  },
};

// ===========================================
// Typing Indicator Helpers
// ===========================================
export const typing = {
  TYPING_TTL: 5, // 5 seconds - typing indicator expires quickly

  /**
   * Set user as typing in a conversation
   */
  async setTyping(conversationId: string, userId: string): Promise<void> {
    const client = await RedisClient.connect();
    const key = `typing:${conversationId}:${userId}`;
    await client.setex(key, this.TYPING_TTL, '1');
  },

  /**
   * Clear typing indicator
   */
  async clearTyping(conversationId: string, userId: string): Promise<void> {
    const client = await RedisClient.connect();
    const key = `typing:${conversationId}:${userId}`;
    await client.del(key);
  },

  /**
   * Get all users currently typing in a conversation
   */
  async getTypingUsers(conversationId: string): Promise<string[]> {
    const client = await RedisClient.connect();
    const pattern = `typing:${conversationId}:*`;
    const keys = await scanKeys(client, pattern);
    
    // Extract user IDs from keys
    return keys.map(key => key.split(':')[2]);
  },
};

// ===========================================
// Rate Limiting Helpers
// ===========================================

/**
 * Sliding window on a sorted set in one atomic step: drop entries older than the
 * window, count the rest, and add `cost` entries only if they fit under the limit.
 * KEYS[1] = key; ARGV = limit, window (ms), now (ms), cost, unique member prefix.
 * Returns {1 allowed | 0 limited, remaining, ms until enough entries leave the window}.
 */
const SLIDING_WINDOW_SCRIPT = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])

if count + cost <= limit then
  for i = 1, cost do
    redis.call('ZADD', KEYS[1], now, ARGV[5] .. ':' .. i)
  end
  redis.call('PEXPIRE', KEYS[1], window)
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {1, limit - count - cost, tonumber(oldest[2]) + window - now}
end

local reset = window
if cost <= limit then
  -- The request fits once this many of the oldest entries have left the window
  local index = count + cost - limit - 1
  local blocking = redis.call('ZRANGE', KEYS[1], index, index, 'WITHSCORES')
  reset = tonumber(blocking[2]) + window - now
end
return {0, math.max(limit - count, 0), reset}
`;

type RateLimitResult = { allowed: boolean; remaining: number; resetIn: number };

// Fallback while Redis is unavailable: fixed windows in this process, capped in size
const RATE_LIMIT_MEMORY_MAX_KEYS = 10000;
// During an outage, try Redis again at most this often; other checks go straight to memory
const RATE_LIMIT_REDIS_RETRY_MS = 5000;

const memoryWindows = new Map<string, { count: number; resetAt: number }>();
let slidingWindowSha: string | null = null;
let rateLimitRedisDown = false;
let lastRateLimitRedisAttempt = 0;

const toResetSeconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

const runSlidingWindow = async (
  client: Redis,
  key: string,
  args: (string | number)[]
): Promise<unknown> => {
  if (slidingWindowSha) {
    try {
      return await client.evalsha(slidingWindowSha, 1, key, ...args);
    } catch (error) {
      // Redis restarted or its script cache was flushed: load the script again
      if (!(error instanceof Error && error.message.includes('NOSCRIPT'))) throw error;
    }
  }
  slidingWindowSha = String(await client.script('LOAD', SLIDING_WINDOW_SCRIPT));
  return client.evalsha(slidingWindowSha, 1, key, ...args);
};

const pruneMemoryWindows = (now: number): void => {
  for (const [key, window] of memoryWindows) {
    if (window.resetAt <= now) memoryWindows.delete(key);
  }
  // Still full: drop the oldest windows (a Map iterates in insertion order)
  for (const key of memoryWindows.keys()) {
    if (memoryWindows.size < RATE_LIMIT_MEMORY_MAX_KEYS) break;
    memoryWindows.delete(key);
  }
};

const checkInMemory = (key: string, limit: number, windowMs: number, cost: number): RateLimitResult => {
  const now = Date.now();
  let window = memoryWindows.get(key);
  if (!window || window.resetAt <= now) {
    memoryWindows.delete(key);
    if (memoryWindows.size >= RATE_LIMIT_MEMORY_MAX_KEYS) pruneMemoryWindows(now);
    window = { count: 0, resetAt: now + windowMs };
    memoryWindows.set(key, window);
  }

  const resetIn = toResetSeconds(window.resetAt - now);
  if (window.count + cost > limit) {
    return { allowed: false, remaining: Math.max(limit - window.count, 0), resetIn };
  }
  window.count += cost;
  return { allowed: true, remaining: limit - window.count, resetIn };
};

export const rateLimit = {
  /**
   * Count `cost` requests (default 1) against `key`, allowing at most `limit` per
   * sliding window of `windowSeconds`, in one atomic Redis script. While Redis is
   * unavailable the same limits are enforced in this process's memory.
   * resetIn is in seconds (at least 1): when the key has room again.
   */
  async check(
    key: string,
    limit: number,
    windowSeconds: number,
    cost = 1
  ): Promise<RateLimitResult> {
    const redisKey = `ratelimit:${key}`;
    const windowMs = windowSeconds * 1000;
    const now = Date.now();

    if (!rateLimitRedisDown || now - lastRateLimitRedisAttempt >= RATE_LIMIT_REDIS_RETRY_MS) {
      lastRateLimitRedisAttempt = now;
      try {
        const client = await RedisClient.connect();
        const reply = await runSlidingWindow(client, redisKey, [
          limit,
          windowMs,
          now,
          cost,
          `${now}-${Math.random()}`,
        ]);
        if (!Array.isArray(reply) || reply.length !== 3) {
          throw new Error('Unexpected reply from the rate limit script');
        }
        const [allowed, remaining, resetMs] = reply.map(Number);

        if (rateLimitRedisDown) {
          rateLimitRedisDown = false;
          logger.info('✅ Rate limiting is using Redis again');
        }
        return { allowed: allowed === 1, remaining, resetIn: toResetSeconds(resetMs) };
      } catch (error) {
        if (!rateLimitRedisDown) {
          rateLimitRedisDown = true;
          logger.error(
            '❌ Redis unavailable for rate limiting; enforcing limits in memory until it recovers:',
            error instanceof Error ? error.message : error
          );
        }
      }
    }

    return checkInMemory(redisKey, limit, windowMs, cost);
  },
};

// ===========================================
// Session Management Helpers
// ===========================================
type RedisTransaction = { exec(): Promise<[error: Error | null, result: unknown][] | null> };

/** Run a MULTI transaction, failing when it was aborted or any command in it failed */
const execTransaction = async (transaction: RedisTransaction): Promise<unknown[]> => {
  const results = await transaction.exec();
  if (!results) throw new Error('Redis transaction was aborted');
  return results.map(([error, result]) => {
    if (error) throw error;
    return result;
  });
};

export const session = {
  // Socket records last 3 minutes. The server holding a socket refreshes its record every
  // minute while it's connected, so records of sockets lost in a restart or crash expire
  // on their own and can't keep a user from going offline.
  SESSION_TTL: 180,

  /**
   * Key of a user's sockets: a sorted set scored by when each socket's record expires (ms).
   * The earlier `socket:user:<id>` sets had no per-socket expiry; they're no longer written.
   */
  socketsKey(userId: string): string {
    return `sockets:user:${userId}`;
  },

  /**
   * Store or refresh a socket's record for a user
   */
  async setSocket(userId: string, socketId: string): Promise<void> {
    const client = await RedisClient.connect();
    const key = this.socketsKey(userId);
    await execTransaction(
      client
        .multi()
        .zadd(key, Date.now() + this.SESSION_TTL * 1000, socketId)
        .expire(key, this.SESSION_TTL)
    );
  },

  /**
   * Get the IDs of a user's sockets whose records haven't expired
   */
  async getSockets(userId: string): Promise<string[]> {
    const client = await RedisClient.connect();
    const key = this.socketsKey(userId);
    const [, members] = await execTransaction(
      client.multi().zremrangebyscore(key, '-inf', Date.now()).zrange(key, 0, -1)
    );
    return Array.isArray(members) ? members.map(String) : [];
  },

  /**
   * Remove a socket's record
   */
  async removeSocket(userId: string, socketId: string): Promise<void> {
    const client = await RedisClient.connect();
    await client.zrem(this.socketsKey(userId), socketId);
  },

  /**
   * Map socket ID to user ID
   */
  async setSocketUser(socketId: string, userId: string): Promise<void> {
    const client = await RedisClient.connect();
    const key = `socket:${socketId}`;
    await client.setex(key, this.SESSION_TTL, userId);
  },

  /**
   * Get user ID from socket ID
   */
  async getSocketUser(socketId: string): Promise<string | null> {
    const client = await RedisClient.connect();
    const key = `socket:${socketId}`;
    return client.get(key);
  },

  /**
   * Clean up all socket sessions for a user
   */
  async clearUserSockets(userId: string): Promise<void> {
    const client = await RedisClient.connect();
    const sockets = await this.getSockets(userId);
    
    if (sockets.length > 0) {
      await Promise.all(sockets.map(socketId => client.del(`socket:${socketId}`)));
    }

    await client.del(this.socketsKey(userId), `socket:user:${userId}`);
  },
};

// ===========================================
// Exports
// ===========================================
export const redis = RedisClient;
export const redisPubSub = RedisPubSub;
export const redisQueue = RedisQueue;

export default RedisClient;
