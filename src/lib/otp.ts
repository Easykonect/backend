/**
 * OTP (One-Time Password) Utilities
 * Secure OTP generation and verification
 * 
 * Security features:
 * - Cryptographically secure random number generation
 * - OTP is hashed before storage (never stored as plain text)
 * - Time-based expiry
 * - Rate limiting support
 */

import crypto from 'crypto';
import { config } from '@/config';

/**
 * Generate a cryptographically secure OTP
 * Uses crypto.randomInt for secure random number generation
 */
export const generateOtp = (length: number = config.otp.length): string => {
  // Generate each digit using cryptographically secure random
  const digits: string[] = [];
  for (let i = 0; i < length; i++) {
    digits.push(crypto.randomInt(0, 10).toString());
  }
  return digits.join('');
};

/**
 * Hash OTP for secure storage
 * Uses SHA-256 with a salt
 */
export const hashOtp = (otp: string): string => {
  const salt = config.jwt.secret; // Use JWT secret as salt
  return crypto
    .createHash('sha256')
    .update(otp + salt)
    .digest('hex');
};

/**
 * Verify OTP against stored hash
 */
export const verifyOtp = (otp: string, hashedOtp: string): boolean => {
  const hash = hashOtp(otp);
  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash, 'hex'),
      Buffer.from(hashedOtp, 'hex')
    );
  } catch {
    return false;
  }
};

/**
 * Calculate OTP expiry time
 */
export const getOtpExpiry = (): Date => {
  const expiry = new Date();
  expiry.setMinutes(expiry.getMinutes() + config.otp.expiryMinutes);
  return expiry;
};

/**
 * Check if OTP has expired
 */
export const isOtpExpired = (expiry: Date | null): boolean => {
  if (!expiry) return true;
  return new Date() > expiry;
};

/**
 * Generate a secure random token (for password reset, etc.)
 * Returns a URL-safe base64 encoded string
 */
export const generateSecureToken = (bytes: number = 32): string => {
  return crypto.randomBytes(bytes).toString('base64url');
};

/**
 * Hash a token for secure storage
 */
export const hashToken = (token: string): string => {
  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');
};

export default {
  generateOtp,
  hashOtp,
  verifyOtp,
  getOtpExpiry,
  isOtpExpired,
  generateSecureToken,
  hashToken,
};
