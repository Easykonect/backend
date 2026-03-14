/**
 * Token Management Service
 * Handles refresh token storage, validation, and invalidation
 * 
 * Security Features:
 * - Tokens stored hashed in Redis
 * - Automatic expiry
 * - Blacklist for invalidated tokens
 * - Device/session tracking
 */

import crypto from 'crypto';
import RedisClient from '@/lib/redis';
import { config } from '@/config';

// Token prefixes for Redis keys
const TOKEN_PREFIX = 'refresh_token:';
const BLACKLIST_PREFIX = 'token_blacklist:';
const USER_TOKENS_PREFIX = 'user_tokens:';

// Token expiry (30 days in seconds)
const TOKEN_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

/**
 * Hash a token for secure storage
 */
const hashToken = (token: string): string => {
  return crypto
    .createHash('sha256')
    .update(token + config.jwt.secret)
    .digest('hex');
};

/**
 * Store a refresh token for a user
 */
export const storeRefreshToken = async (
  userId: string,
  refreshToken: string,
  metadata?: {
    deviceInfo?: string;
    ipAddress?: string;
  }
): Promise<void> => {
  try {
    const client = await RedisClient.connect();
    const hashedToken = hashToken(refreshToken);
    
    // Store token data
    const tokenData = JSON.stringify({
      userId,
      createdAt: Date.now(),
      ...metadata,
    });
    
    // Store token with expiry
    await client.setex(`${TOKEN_PREFIX}${hashedToken}`, TOKEN_EXPIRY_SECONDS, tokenData);
    
    // Add to user's token set for tracking
    await client.sadd(`${USER_TOKENS_PREFIX}${userId}`, hashedToken);
    await client.expire(`${USER_TOKENS_PREFIX}${userId}`, TOKEN_EXPIRY_SECONDS);
  } catch (error) {
    console.error('Failed to store refresh token:', error);
  }
};

/**
 * Validate a refresh token
 * Returns user ID if valid, null otherwise
 */
export const validateRefreshToken = async (refreshToken: string): Promise<string | null> => {
  try {
    const client = await RedisClient.connect();
    const hashedToken = hashToken(refreshToken);
    
    // Check if token is blacklisted
    const isBlacklisted = await client.exists(`${BLACKLIST_PREFIX}${hashedToken}`);
    if (isBlacklisted) {
      return null;
    }
    
    // Get token data
    const tokenData = await client.get(`${TOKEN_PREFIX}${hashedToken}`);
    if (!tokenData) {
      return null;
    }
    
    const parsed = JSON.parse(tokenData);
    return parsed.userId;
  } catch (error) {
    console.error('Failed to validate refresh token:', error);
    return null;
  }
};

/**
 * Invalidate a specific refresh token (logout)
 */
export const invalidateRefreshToken = async (refreshToken: string): Promise<void> => {
  try {
    const client = await RedisClient.connect();
    const hashedToken = hashToken(refreshToken);
    
    // Get token data to find user ID
    const tokenData = await client.get(`${TOKEN_PREFIX}${hashedToken}`);
    
    // Delete the token
    await client.del(`${TOKEN_PREFIX}${hashedToken}`);
    
    // Add to blacklist (in case JWT is still valid)
    await client.setex(`${BLACKLIST_PREFIX}${hashedToken}`, TOKEN_EXPIRY_SECONDS, '1');
    
    // Remove from user's token set
    if (tokenData) {
      const parsed = JSON.parse(tokenData);
      await client.srem(`${USER_TOKENS_PREFIX}${parsed.userId}`, hashedToken);
    }
  } catch (error) {
    console.error('Failed to invalidate refresh token:', error);
  }
};

/**
 * Invalidate all refresh tokens for a user (logout all devices)
 */
export const invalidateAllUserTokens = async (userId: string): Promise<void> => {
  try {
    const client = await RedisClient.connect();
    
    // Get all user's tokens
    const tokens = await client.smembers(`${USER_TOKENS_PREFIX}${userId}`);
    
    // Delete and blacklist all tokens
    await Promise.all(
      tokens.map(async (hashedToken) => {
        await client.del(`${TOKEN_PREFIX}${hashedToken}`);
        await client.setex(`${BLACKLIST_PREFIX}${hashedToken}`, TOKEN_EXPIRY_SECONDS, '1');
      })
    );
    
    // Delete user's token set
    await client.del(`${USER_TOKENS_PREFIX}${userId}`);
  } catch (error) {
    console.error('Failed to invalidate all user tokens:', error);
  }
};

/**
 * Rotate a refresh token (invalidate old, create new)
 * Used for refresh token rotation strategy
 */
export const rotateRefreshToken = async (
  oldToken: string,
  newToken: string,
  userId: string,
  metadata?: {
    deviceInfo?: string;
    ipAddress?: string;
  }
): Promise<void> => {
  await invalidateRefreshToken(oldToken);
  await storeRefreshToken(userId, newToken, metadata);
};

/**
 * Check if a token is blacklisted
 */
export const isTokenBlacklisted = async (refreshToken: string): Promise<boolean> => {
  try {
    const client = await RedisClient.connect();
    const hashedToken = hashToken(refreshToken);
    const exists = await client.exists(`${BLACKLIST_PREFIX}${hashedToken}`);
    return exists === 1;
  } catch (error) {
    console.error('Failed to check token blacklist:', error);
    return false;
  }
};

/**
 * Get active sessions count for a user
 */
export const getUserSessionCount = async (userId: string): Promise<number> => {
  try {
    const client = await RedisClient.connect();
    return client.scard(`${USER_TOKENS_PREFIX}${userId}`);
  } catch (error) {
    console.error('Failed to get user session count:', error);
    return 0;
  }
};

export default {
  storeRefreshToken,
  validateRefreshToken,
  invalidateRefreshToken,
  invalidateAllUserTokens,
  rotateRefreshToken,
  isTokenBlacklisted,
  getUserSessionCount,
};
