/**
 * Authentication Utilities
 * JWT token generation, verification, and password hashing
 */

import { randomUUID } from 'crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '@/config';
import type { UserRoleType } from '@/constants';

/**
 * Access and refresh tokens carry their type so one can't be used as the other
 */
export type TokenType = 'access' | 'refresh';

/**
 * JWT Payload interface
 */
export interface JWTPayload {
  userId: string;
  email: string;
  role: UserRoleType;
  typ?: TokenType; // Set on every issued token
  jti?: string; // Unique token ID, so a single token can be revoked (set on every issued token)
  iatMs?: number; // Issue time in milliseconds (set on every issued token)
  iat?: number;  // Issued at (automatically added by JWT)
  exp?: number;  // Expiration (automatically added by JWT)
}

/**
 * Claims added to every issued token. `iatMs` lets a token issued moments after a
 * sign-out-everywhere (password change, deactivation) be told apart from the tokens
 * it ended, which whole-second `iat` can't do.
 */
const issueClaims = (typ: TokenType) => ({ typ, jti: randomUUID(), iatMs: Date.now() });

/**
 * Generate JWT access token
 */
export const generateToken = (payload: JWTPayload): string => {
  const options: SignOptions = {
    expiresIn: config.jwt.expiresIn as jwt.SignOptions['expiresIn'],
  };
  return jwt.sign({ ...payload, ...issueClaims('access') }, config.jwt.secret, options);
};

/**
 * Generate JWT refresh token
 */
export const generateRefreshToken = (payload: JWTPayload): string => {
  const options: SignOptions = {
    expiresIn: config.jwt.refreshExpiresIn as jwt.SignOptions['expiresIn'],
  };
  return jwt.sign({ ...payload, ...issueClaims('refresh') }, config.jwt.secret, options);
};

/**
 * When a token was issued, in milliseconds. Tokens issued before `iatMs` existed
 * only carry `iat`, in whole seconds.
 */
export const getTokenIssuedAtMs = (payload: Pick<JWTPayload, 'iat' | 'iatMs'>): number | null => {
  if (typeof payload.iatMs === 'number') return payload.iatMs;
  if (typeof payload.iat === 'number') return payload.iat * 1000;
  return null;
};

/**
 * Verify JWT token signature and expiry (any token type)
 */
export const verifyToken = (token: string): JWTPayload => {
  return jwt.verify(token, config.jwt.secret) as JWTPayload;
};

const verifyTokenOfType = (token: string, typ: TokenType): JWTPayload => {
  const payload = verifyToken(token);
  if (payload.typ !== typ) {
    throw new jwt.JsonWebTokenError(`Expected a ${typ} token`);
  }
  return payload;
};

/**
 * Verify a token presented as `Authorization: Bearer` (rejects refresh tokens)
 */
export const verifyAccessToken = (token: string): JWTPayload => verifyTokenOfType(token, 'access');

/**
 * Verify a token presented to a refresh endpoint (rejects access tokens)
 */
export const verifyRefreshToken = (token: string): JWTPayload => verifyTokenOfType(token, 'refresh');

/**
 * Hash password using bcrypt
 */
export const hashPassword = async (password: string): Promise<string> => {
  return bcrypt.hash(password, config.bcrypt.saltRounds);
};

/**
 * Compare password with hash
 */
export const comparePassword = async (
  password: string,
  hash: string
): Promise<boolean> => {
  return bcrypt.compare(password, hash);
};

/**
 * Generate random token (for email verification, password reset, etc.)
 */
export const generateRandomToken = (): string => {
  return crypto.randomUUID();
};
