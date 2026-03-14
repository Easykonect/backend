/**
 * Logger Utility
 * 
 * Environment-aware logging that:
 * - Shows all logs in development
 * - Shows only important logs in production
 * - Reduces noise from repetitive operations
 */

import { config } from '@/config';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerOptions {
  /** Only log in development */
  devOnly?: boolean;
  /** Only log once per session (for startup messages) */
  once?: boolean;
}

// Track messages that should only be logged once
const loggedOnce = new Set<string>();

/**
 * Logger with environment awareness
 */
export const logger = {
  /**
   * Debug level - only shows in development
   */
  debug: (message: string, ...args: unknown[]) => {
    if (config.isDevelopment) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  },

  /**
   * Info level - shows in all environments
   */
  info: (message: string, ...args: unknown[]) => {
    console.log(message, ...args);
  },

  /**
   * Warning level - shows in all environments
   */
  warn: (message: string, ...args: unknown[]) => {
    console.warn(message, ...args);
  },

  /**
   * Error level - shows in all environments
   */
  error: (message: string, ...args: unknown[]) => {
    console.error(message, ...args);
  },

  /**
   * Log only once per session (useful for startup messages)
   */
  once: (level: LogLevel, key: string, message: string, ...args: unknown[]) => {
    if (loggedOnce.has(key)) return;
    loggedOnce.add(key);
    
    switch (level) {
      case 'debug':
        logger.debug(message, ...args);
        break;
      case 'info':
        logger.info(message, ...args);
        break;
      case 'warn':
        logger.warn(message, ...args);
        break;
      case 'error':
        logger.error(message, ...args);
        break;
    }
  },

  /**
   * Log only in development (for verbose/noisy operations)
   */
  dev: (message: string, ...args: unknown[]) => {
    if (config.isDevelopment) {
      console.log(message, ...args);
    }
  },

  /**
   * Redis-specific logging (reduced noise)
   */
  redis: {
    connected: (name: string) => {
      logger.once('info', `redis-connected-${name}`, `✅ ${name} Redis client connected`);
    },
    error: (name: string, error: string) => {
      // Always log errors
      console.error(`❌ ${name} Redis client error:`, error);
    },
    reconnecting: (attempt: number, maxAttempts: number) => {
      // Only log every 5th attempt to reduce noise
      if (attempt === 1 || attempt % 5 === 0 || attempt === maxAttempts) {
        console.log(`🔄 Redis reconnecting (attempt ${attempt}/${maxAttempts})`);
      }
    },
  },

  /**
   * Socket-specific logging (reduced noise in production)
   */
  socket: {
    userConnected: (userName: string, userId: string) => {
      logger.dev(`🔌 User connected: ${userName} (${userId})`);
    },
    userDisconnected: (userName: string, userId: string) => {
      logger.dev(`🔌 User disconnected: ${userName} (${userId})`);
    },
    error: (message: string, error: unknown) => {
      console.error(`❌ Socket error: ${message}`, error);
    },
  },

  /**
   * Queue-specific logging
   */
  queue: {
    jobStarted: (queueName: string, jobId: string) => {
      logger.dev(`⚙️ Processing job ${jobId} in ${queueName}`);
    },
    jobCompleted: (queueName: string, jobId: string) => {
      logger.dev(`✅ Job ${jobId} completed in ${queueName}`);
    },
    jobFailed: (queueName: string, jobId: string, error: string) => {
      console.error(`❌ Job ${jobId} failed in ${queueName}:`, error);
    },
  },

  /**
   * Email-specific logging
   */
  email: {
    sent: (to: string, messageId?: string) => {
      logger.dev(`📧 Email sent to ${to}${messageId ? ` (${messageId})` : ''}`);
    },
    failed: (to: string, error: unknown) => {
      console.error(`❌ Failed to send email to ${to}:`, error);
    },
  },
};

export default logger;
