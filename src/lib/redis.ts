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
let lastLoggedAttempt = 0;

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
    if (times > 10) {
      logger.error('❌ Redis: Max retry attempts reached. Stopping reconnection.');
      return null; // Stop retrying after 10 attempts
    }
    // Exponential backoff: 1s, 2s, 4s, 8s... up to 30 seconds
    const delay = Math.min(Math.pow(2, times) * 1000, 30000);
    
    // Only log every 5th attempt or first/last to reduce noise
    if (times === 1 || times % 5 === 0 || times === 10) {
      logger.warn(`🔄 Redis reconnecting in ${delay / 1000}s (attempt ${times}/10)`);
    }
    lastLoggedAttempt = times;
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
class RedisClient {
  private static instance: Redis | null = null;
  private static isConnecting = false;

  static getInstance(): Redis {
    if (!this.instance) {
      this.instance = new Redis(REDIS_URL, {
        ...redisOptions,
        lazyConnect: true,
      });

      this.setupEventHandlers(this.instance, 'Main');
    }
    return this.instance;
  }

  static async connect(): Promise<Redis> {
    const client = this.getInstance();
    
    if (this.isConnecting) {
      // Wait for existing connection attempt
      return new Promise((resolve) => {
        const checkConnection = setInterval(() => {
          if (client.status === 'ready') {
            clearInterval(checkConnection);
            resolve(client);
          }
        }, 100);
      });
    }

    if (client.status === 'ready') {
      return client;
    }

    this.isConnecting = true;
    
    try {
      await client.connect();
      this.isConnecting = false;
      return client;
    } catch (error) {
      this.isConnecting = false;
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
    const keys = await client.keys(pattern);
    
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
  ONLINE_TTL: 300, // 5 minutes - user is considered online if active within this time

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
    const keys = await client.keys(pattern);
    
    // Extract user IDs from keys
    return keys.map(key => key.split(':')[2]);
  },
};

// ===========================================
// Rate Limiting Helpers
// ===========================================
export const rateLimit = {
  /**
   * Check and increment rate limit
   * Returns true if within limit, false if exceeded
   */
  async check(
    key: string, 
    limit: number, 
    windowSeconds: number
  ): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
    const client = await RedisClient.connect();
    const now = Date.now();
    const windowStart = now - (windowSeconds * 1000);
    
    // Use sorted set for sliding window rate limiting
    const redisKey = `ratelimit:${key}`;
    
    // Remove old entries
    await client.zremrangebyscore(redisKey, 0, windowStart);
    
    // Count current requests
    const count = await client.zcard(redisKey);
    
    if (count >= limit) {
      // Get the oldest entry to calculate reset time
      const oldest = await client.zrange(redisKey, 0, 0, 'WITHSCORES');
      const resetIn = oldest.length > 1 
        ? Math.ceil((parseInt(oldest[1]) + windowSeconds * 1000 - now) / 1000)
        : windowSeconds;
      
      return { allowed: false, remaining: 0, resetIn };
    }
    
    // Add current request
    await client.zadd(redisKey, now, `${now}-${Math.random()}`);
    await client.expire(redisKey, windowSeconds);
    
    return { 
      allowed: true, 
      remaining: limit - count - 1, 
      resetIn: windowSeconds 
    };
  },
};

// ===========================================
// Session Management Helpers
// ===========================================
export const session = {
  SESSION_TTL: 86400 * 7, // 7 days

  /**
   * Store socket session for a user
   */
  async setSocket(userId: string, socketId: string): Promise<void> {
    const client = await RedisClient.connect();
    const key = `socket:user:${userId}`;
    await client.sadd(key, socketId);
    await client.expire(key, this.SESSION_TTL);
  },

  /**
   * Get all socket IDs for a user
   */
  async getSockets(userId: string): Promise<string[]> {
    const client = await RedisClient.connect();
    const key = `socket:user:${userId}`;
    return client.smembers(key);
  },

  /**
   * Remove a socket session
   */
  async removeSocket(userId: string, socketId: string): Promise<void> {
    const client = await RedisClient.connect();
    const key = `socket:user:${userId}`;
    await client.srem(key, socketId);
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
    
    await client.del(`socket:user:${userId}`);
  },
};

// ===========================================
// Exports
// ===========================================
export const redis = RedisClient;
export const redisPubSub = RedisPubSub;
export const redisQueue = RedisQueue;

export default RedisClient;
