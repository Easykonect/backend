/**
 * Token Management Service
 * Handles refresh token storage, validation, and invalidation, and revoking
 * single access tokens at sign-out
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
import type { JWTPayload } from '@/lib/auth';
import { invalidateAllUserTokens as invalidateTokensIssuedBefore } from '@/utils/security';

// Token prefixes for Redis keys
const TOKEN_PREFIX = 'refresh_token:';
const BLACKLIST_PREFIX = 'token_blacklist:';
const USER_TOKENS_PREFIX = 'user_tokens:';
const ACCESS_DENYLIST_PREFIX = 'access_token_denylist:';

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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The Redis client for checks made on every request: it connects on first use,
 * but doesn't wait for a reconnect during an outage, so commands fail fast
 */
const getClientForRequestChecks = async () => {
  const client = RedisClient.getInstance();
  return client.status === 'wait' ? RedisClient.connect() : client;
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
 * What the token store knows about a refresh token. `unavailable` means Redis
 * couldn't be reached, so the caller decides whether the token's signature is
 * enough on its own.
 */
export type RefreshTokenRecord =
  | { status: 'active'; userId: string }
  | { status: 'revoked' }
  | { status: 'unavailable' };

/**
 * Look up a refresh token: active (stored and not revoked), revoked (revoked,
 * expired from the store, or never stored), or unavailable (Redis error)
 */
export const checkRefreshToken = async (refreshToken: string): Promise<RefreshTokenRecord> => {
  const hashedToken = hashToken(refreshToken);
  let tokenData: string | null;

  try {
    const client = await RedisClient.connect();

    if (await client.exists(`${BLACKLIST_PREFIX}${hashedToken}`)) {
      return { status: 'revoked' };
    }

    tokenData = await client.get(`${TOKEN_PREFIX}${hashedToken}`);
  } catch (error) {
    console.warn(`Refresh token store unavailable: ${errorMessage(error)}`);
    return { status: 'unavailable' };
  }

  if (!tokenData) {
    return { status: 'revoked' };
  }

  try {
    const parsed = JSON.parse(tokenData) as { userId?: unknown };
    return typeof parsed.userId === 'string'
      ? { status: 'active', userId: parsed.userId }
      : { status: 'revoked' };
  } catch {
    return { status: 'revoked' };
  }
};

/**
 * Validate a refresh token
 * Returns user ID if valid, null otherwise (including when Redis is unavailable)
 */
export const validateRefreshToken = async (refreshToken: string): Promise<string | null> => {
  const record = await checkRefreshToken(refreshToken);
  return record.status === 'active' ? record.userId : null;
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
 * Sign a user out everywhere: revoke every stored refresh token and reject
 * tokens issued until now. Callers also set the account's `tokenInvalidatedAt`
 * in the same write as the change that ends the sessions, which keeps the
 * sign-out in force when Redis is unavailable.
 */
export const endAllSessions = async (userId: string): Promise<void> => {
  await Promise.all([invalidateAllUserTokens(userId), invalidateTokensIssuedBefore(userId)]);
};

/**
 * Denylist keys for one access token: its unique `jti` (which socket
 * connections can check without the raw token) and the token's hash (which
 * covers tokens issued before `jti` existed)
 */
const accessDenylistKeys = (payload: JWTPayload, accessToken?: string): string[] => {
  const keys: string[] = [];
  if (payload.jti) keys.push(`${ACCESS_DENYLIST_PREFIX}jti:${payload.jti}`);
  if (accessToken) keys.push(`${ACCESS_DENYLIST_PREFIX}${hashToken(accessToken)}`);
  return keys;
};

/**
 * Revoke one access token until it expires (sign-out on one device). Failures
 * are logged, not thrown, so signing out always succeeds for the user.
 */
export const revokeAccessToken = async (payload: JWTPayload, accessToken?: string): Promise<void> => {
  const keys = accessDenylistKeys(payload, accessToken);
  const secondsLeft = payload.exp
    ? payload.exp - Math.floor(Date.now() / 1000)
    : TOKEN_EXPIRY_SECONDS;

  if (keys.length === 0 || secondsLeft <= 0) return;

  try {
    const client = await RedisClient.connect();
    await Promise.all(keys.map((key) => client.setex(key, secondsLeft, '1')));
  } catch (error) {
    console.error('Failed to revoke access token:', error);
  }
};

/**
 * Whether an access token was revoked with `revokeAccessToken`. When Redis
 * can't be reached the token counts as not revoked, so an outage doesn't sign
 * everyone out.
 */
export const isAccessTokenRevoked = async (
  payload: JWTPayload,
  accessToken?: string
): Promise<boolean> => {
  const keys = accessDenylistKeys(payload, accessToken);
  if (keys.length === 0) return false;

  try {
    const client = await getClientForRequestChecks();
    return (await client.exists(...keys)) > 0;
  } catch (error) {
    console.warn(`Access token denylist unavailable, allowing the token: ${errorMessage(error)}`);
    return false;
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

const tokenService = {
  storeRefreshToken,
  checkRefreshToken,
  validateRefreshToken,
  invalidateRefreshToken,
  invalidateAllUserTokens,
  endAllSessions,
  revokeAccessToken,
  isAccessTokenRevoked,
  rotateRefreshToken,
  isTokenBlacklisted,
  getUserSessionCount,
};

export default tokenService;
