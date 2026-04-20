/**
 * Security Utilities
 * 
 * Provides comprehensive security functions for:
 * - XSS Prevention (input sanitization)
 * - NoSQL Injection Prevention
 * - IDOR Protection helpers
 * - Input validation
 * - Rate limiting helpers
 * 
 * IMPORTANT: All user-generated content MUST be sanitized before storage.
 */

import sanitizeHtml from 'sanitize-html';
import validator from 'validator';
import { GraphQLError } from 'graphql';

// ==========================================
// Constants
// ==========================================

// Maximum lengths for various fields
export const MAX_LENGTHS = {
  NAME: 100,
  EMAIL: 255,
  PHONE: 20,
  SHORT_TEXT: 255,
  MEDIUM_TEXT: 1000,
  LONG_TEXT: 5000,
  DESCRIPTION: 10000,
  URL: 2048,
  PASSWORD: 128,
  SEARCH_QUERY: 200,
} as const;

// Characters that could be used for NoSQL injection
const NOSQL_INJECTION_PATTERNS = [
  /\$where/i,
  /\$gt/i,
  /\$lt/i,
  /\$ne/i,
  /\$in/i,
  /\$nin/i,
  /\$or/i,
  /\$and/i,
  /\$not/i,
  /\$regex/i,
  /\$exists/i,
  /\$type/i,
  /\$mod/i,
  /\$text/i,
  /\$expr/i,
  /\{\s*\$/,  // Objects starting with $
];

// ==========================================
// XSS Prevention - Sanitization
// ==========================================

/**
 * Strict sanitization - removes ALL HTML tags
 * Use for: names, titles, single-line inputs
 */
export const sanitizeStrict = (input: string): string => {
  if (!input || typeof input !== 'string') return '';
  
  return sanitizeHtml(input.trim(), {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'recursiveEscape',
  });
};

/**
 * Basic sanitization - allows basic formatting tags
 * Use for: descriptions, comments, messages
 */
export const sanitizeBasic = (input: string): string => {
  if (!input || typeof input !== 'string') return '';
  
  return sanitizeHtml(input.trim(), {
    allowedTags: ['b', 'i', 'em', 'strong', 'p', 'br', 'ul', 'ol', 'li'],
    allowedAttributes: {},
    disallowedTagsMode: 'recursiveEscape',
  });
};

/**
 * Rich sanitization - allows more formatting but no scripts
 * Use for: rich text editors, detailed descriptions
 */
export const sanitizeRich = (input: string): string => {
  if (!input || typeof input !== 'string') return '';
  
  return sanitizeHtml(input.trim(), {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr',
      'b', 'i', 'em', 'strong', 'u', 's', 'strike',
      'ul', 'ol', 'li',
      'blockquote', 'pre', 'code',
      'a', 'img',
    ],
    allowedAttributes: {
      'a': ['href', 'title', 'target'],
      'img': ['src', 'alt', 'title', 'width', 'height'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'recursiveEscape',
  });
};

/**
 * Escape HTML entities for safe display
 * Use when outputting user content in JSON responses
 */
export const escapeHtml = (input: string): string => {
  if (!input || typeof input !== 'string') return '';
  
  return validator.escape(input);
};

/**
 * Sanitize object recursively - sanitizes all string values
 */
export const sanitizeObject = <T extends Record<string, unknown>>(
  obj: T,
  sanitizer: (s: string) => string = sanitizeStrict
): T => {
  const result = { ...obj };
  
  for (const key in result) {
    const value = result[key];
    if (typeof value === 'string') {
      (result as any)[key] = sanitizer(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      (result as any)[key] = sanitizeObject(value as Record<string, unknown>, sanitizer);
    } else if (Array.isArray(value)) {
      (result as any)[key] = value.map(item => 
        typeof item === 'string' ? sanitizer(item) : item
      );
    }
  }
  
  return result;
};

// ==========================================
// NoSQL Injection Prevention
// ==========================================

/**
 * Check for NoSQL injection patterns
 */
export const hasNoSQLInjection = (input: string): boolean => {
  if (!input || typeof input !== 'string') return false;
  
  return NOSQL_INJECTION_PATTERNS.some(pattern => pattern.test(input));
};

/**
 * Validate and sanitize search query
 * Prevents ReDoS and NoSQL injection
 */
export const sanitizeSearchQuery = (query: string): string => {
  if (!query || typeof query !== 'string') return '';
  
  // Remove potential injection patterns
  let sanitized = query.trim();
  
  // Check for injection
  if (hasNoSQLInjection(sanitized)) {
    throw new GraphQLError('Invalid search query', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }
  
  // Limit length to prevent ReDoS
  if (sanitized.length > MAX_LENGTHS.SEARCH_QUERY) {
    sanitized = sanitized.substring(0, MAX_LENGTHS.SEARCH_QUERY);
  }
  
  // Escape special regex characters to prevent ReDoS
  sanitized = sanitized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  
  return sanitized;
};

/**
 * Validate enum value to prevent injection via unexpected values
 */
export const validateEnum = <T extends string>(
  value: string,
  allowedValues: readonly T[],
  fieldName: string
): T => {
  if (!allowedValues.includes(value as T)) {
    throw new GraphQLError(`Invalid value for ${fieldName}`, {
      extensions: { code: 'INVALID_INPUT' },
    });
  }
  return value as T;
};

/**
 * Validate MongoDB ObjectId format
 */
export const isValidObjectId = (id: string): boolean => {
  if (!id || typeof id !== 'string') return false;
  return /^[a-fA-F0-9]{24}$/.test(id);
};

/**
 * Validate and sanitize ObjectId
 */
export const validateObjectId = (id: string, fieldName: string = 'id'): string => {
  if (!isValidObjectId(id)) {
    throw new GraphQLError(`Invalid ${fieldName} format`, {
      extensions: { code: 'INVALID_INPUT' },
    });
  }
  return id;
};

// ==========================================
// Input Validation
// ==========================================

/**
 * Validate email format
 */
export const validateEmail = (email: string): string => {
  const sanitized = sanitizeStrict(email).toLowerCase();
  
  if (!validator.isEmail(sanitized)) {
    throw new GraphQLError('Invalid email format', {
      extensions: { code: 'INVALID_EMAIL' },
    });
  }
  
  if (sanitized.length > MAX_LENGTHS.EMAIL) {
    throw new GraphQLError('Email too long', {
      extensions: { code: 'INVALID_EMAIL' },
    });
  }
  
  return sanitized;
};

/**
 * Validate phone number (Nigerian format)
 */
export const validatePhone = (phone: string): string => {
  const sanitized = phone.replace(/[^0-9+]/g, '');
  
  // Nigerian phone formats: 08012345678, +2348012345678, 2348012345678
  const nigerianPhoneRegex = /^(\+?234|0)[789][01]\d{8}$/;
  
  if (!nigerianPhoneRegex.test(sanitized)) {
    throw new GraphQLError('Invalid Nigerian phone number', {
      extensions: { code: 'INVALID_PHONE' },
    });
  }
  
  return sanitized;
};

/**
 * Validate URL
 */
export const validateUrl = (url: string): string => {
  const sanitized = sanitizeStrict(url);
  
  if (!validator.isURL(sanitized, { 
    protocols: ['http', 'https'],
    require_protocol: true,
  })) {
    throw new GraphQLError('Invalid URL', {
      extensions: { code: 'INVALID_URL' },
    });
  }
  
  if (sanitized.length > MAX_LENGTHS.URL) {
    throw new GraphQLError('URL too long', {
      extensions: { code: 'INVALID_URL' },
    });
  }
  
  return sanitized;
};

/**
 * Validate name (person or business)
 */
export const validateName = (name: string, fieldName: string = 'name'): string => {
  const sanitized = sanitizeStrict(name);
  
  if (!sanitized || sanitized.length < 2) {
    throw new GraphQLError(`${fieldName} must be at least 2 characters`, {
      extensions: { code: 'INVALID_INPUT' },
    });
  }
  
  if (sanitized.length > MAX_LENGTHS.NAME) {
    throw new GraphQLError(`${fieldName} too long (max ${MAX_LENGTHS.NAME} characters)`, {
      extensions: { code: 'INVALID_INPUT' },
    });
  }
  
  // Allow letters, numbers, spaces, hyphens, apostrophes, periods
  if (!/^[\p{L}\p{N}\s\-'.]+$/u.test(sanitized)) {
    throw new GraphQLError(`${fieldName} contains invalid characters`, {
      extensions: { code: 'INVALID_INPUT' },
    });
  }
  
  return sanitized;
};

/**
 * Validate text with length limits
 */
export const validateText = (
  text: string,
  fieldName: string,
  minLength: number = 0,
  maxLength: number = MAX_LENGTHS.MEDIUM_TEXT
): string => {
  const sanitized = sanitizeBasic(text);
  
  if (sanitized.length < minLength) {
    throw new GraphQLError(
      `${fieldName} must be at least ${minLength} characters`,
      { extensions: { code: 'INVALID_INPUT' } }
    );
  }
  
  if (sanitized.length > maxLength) {
    throw new GraphQLError(
      `${fieldName} must be at most ${maxLength} characters`,
      { extensions: { code: 'INVALID_INPUT' } }
    );
  }
  
  return sanitized;
};

/**
 * Validate password strength
 */
export const validatePassword = (password: string): void => {
  if (password.length < 8) {
    throw new GraphQLError('Password must be at least 8 characters', {
      extensions: { code: 'WEAK_PASSWORD' },
    });
  }
  
  if (password.length > MAX_LENGTHS.PASSWORD) {
    throw new GraphQLError('Password too long', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }
  
  // Check for at least one uppercase, lowercase, number
  if (!/[A-Z]/.test(password)) {
    throw new GraphQLError('Password must contain at least one uppercase letter', {
      extensions: { code: 'WEAK_PASSWORD' },
    });
  }
  
  if (!/[a-z]/.test(password)) {
    throw new GraphQLError('Password must contain at least one lowercase letter', {
      extensions: { code: 'WEAK_PASSWORD' },
    });
  }
  
  if (!/[0-9]/.test(password)) {
    throw new GraphQLError('Password must contain at least one number', {
      extensions: { code: 'WEAK_PASSWORD' },
    });
  }
};

/**
 * Validate rating (1-5)
 */
export const validateRating = (rating: number): number => {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new GraphQLError('Rating must be between 1 and 5', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }
  return rating;
};

/**
 * Validate amount (positive number)
 */
export const validateAmount = (amount: number, fieldName: string = 'amount'): number => {
  if (typeof amount !== 'number' || isNaN(amount)) {
    throw new GraphQLError(`${fieldName} must be a number`, {
      extensions: { code: 'INVALID_INPUT' },
    });
  }
  
  if (amount < 0) {
    throw new GraphQLError(`${fieldName} must be positive`, {
      extensions: { code: 'INVALID_INPUT' },
    });
  }
  
  // Prevent floating point precision issues - max 2 decimal places
  if (Math.round(amount * 100) / 100 !== amount) {
    throw new GraphQLError(`${fieldName} can have at most 2 decimal places`, {
      extensions: { code: 'INVALID_INPUT' },
    });
  }
  
  return amount;
};

// ==========================================
// IDOR Protection Helpers
// ==========================================

/**
 * Verify resource ownership
 * Returns the resource if user owns it, throws error otherwise
 */
export const verifyOwnership = <T extends { userId?: string; id?: string }>(
  resource: T | null,
  userId: string,
  resourceName: string = 'Resource',
  ownerField: keyof T = 'userId' as keyof T
): T => {
  if (!resource) {
    throw new GraphQLError(`${resourceName} not found`, {
      extensions: { code: 'NOT_FOUND' },
    });
  }
  
  // Always use same error to prevent enumeration
  if (resource[ownerField] !== userId) {
    throw new GraphQLError(`${resourceName} not found`, {
      extensions: { code: 'NOT_FOUND' },
    });
  }
  
  return resource;
};

/**
 * Verify access to resource (owner OR admin)
 */
export const verifyAccess = <T extends { userId?: string }>(
  resource: T | null,
  userId: string,
  userRole: string,
  resourceName: string = 'Resource',
  adminRoles: string[] = ['ADMIN', 'SUPER_ADMIN']
): T => {
  if (!resource) {
    throw new GraphQLError(`${resourceName} not found`, {
      extensions: { code: 'NOT_FOUND' },
    });
  }
  
  const isOwner = resource.userId === userId;
  const isAdmin = adminRoles.includes(userRole);
  
  if (!isOwner && !isAdmin) {
    // Use same error to prevent enumeration
    throw new GraphQLError(`${resourceName} not found`, {
      extensions: { code: 'NOT_FOUND' },
    });
  }
  
  return resource;
};

// ==========================================
// Rate Limiting for Auth Endpoints
// ==========================================

import RedisClient from '@/lib/redis';

/**
 * Get Redis client instance
 */
const getRedis = () => RedisClient.getInstance();

/**
 * Rate limit configuration by endpoint type
 */
export const RATE_LIMIT_CONFIG = {
  LOGIN: {
    maxAttempts: 5,
    windowSeconds: 300, // 5 minutes
    blockDurationSeconds: 900, // 15 minutes block after exceeded
  },
  PASSWORD_RESET: {
    maxAttempts: 3,
    windowSeconds: 3600, // 1 hour
    blockDurationSeconds: 3600, // 1 hour block
  },
  OTP_VERIFY: {
    maxAttempts: 5,
    windowSeconds: 300, // 5 minutes
    blockDurationSeconds: 600, // 10 minutes block
  },
  OTP_RESEND: {
    maxAttempts: 3,
    windowSeconds: 300, // 5 minutes
    blockDurationSeconds: 600, // 10 minutes block
  },
  REGISTER: {
    maxAttempts: 5,
    windowSeconds: 3600, // 1 hour
    blockDurationSeconds: 3600, // 1 hour block
  },
} as const;

export type RateLimitType = keyof typeof RATE_LIMIT_CONFIG;

/**
 * Check if an identifier (email/IP) is rate limited
 * Returns { allowed: boolean, remaining: number, resetIn: number }
 */
export const checkRateLimit = async (
  type: RateLimitType,
  identifier: string
): Promise<{ allowed: boolean; remaining: number; resetIn: number; blocked: boolean }> => {
  const config = RATE_LIMIT_CONFIG[type];
  const key = `ratelimit:${type}:${identifier.toLowerCase()}`;
  const blockKey = `ratelimit:block:${type}:${identifier.toLowerCase()}`;
  const redis = getRedis();

  try {
    // Check if blocked
    const isBlocked = await redis.get(blockKey);
    if (isBlocked) {
      const ttl = await redis.ttl(blockKey);
      return {
        allowed: false,
        remaining: 0,
        resetIn: ttl > 0 ? ttl : config.blockDurationSeconds,
        blocked: true,
      };
    }

    // Get current attempt count
    const current = await redis.get(key);
    const attempts = current ? parseInt(current, 10) : 0;

    if (attempts >= config.maxAttempts) {
      // Set block
      await redis.setex(blockKey, config.blockDurationSeconds, '1');
      // Log security event
      logSecurityEvent('RATE_LIMIT', {
        reason: `Rate limit exceeded for ${type}`,
        input: { identifier: identifier.substring(0, 50) },
      });
      return {
        allowed: false,
        remaining: 0,
        resetIn: config.blockDurationSeconds,
        blocked: true,
      };
    }

    const ttl = await redis.ttl(key);
    return {
      allowed: true,
      remaining: config.maxAttempts - attempts,
      resetIn: ttl > 0 ? ttl : config.windowSeconds,
      blocked: false,
    };
  } catch (error) {
    // On Redis error, allow the request (fail open for availability)
    // But log the error
    console.error('Rate limit check failed:', error);
    return { allowed: true, remaining: 1, resetIn: 0, blocked: false };
  }
};

/**
 * Increment rate limit counter after an attempt
 */
export const incrementRateLimit = async (
  type: RateLimitType,
  identifier: string
): Promise<void> => {
  const config = RATE_LIMIT_CONFIG[type];
  const key = `ratelimit:${type}:${identifier.toLowerCase()}`;
  const redis = getRedis();

  try {
    const exists = await redis.exists(key);
    if (exists) {
      await redis.incr(key);
    } else {
      await redis.setex(key, config.windowSeconds, '1');
    }
  } catch (error) {
    console.error('Rate limit increment failed:', error);
  }
};

/**
 * Reset rate limit after successful action (e.g., successful login)
 */
export const resetRateLimit = async (
  type: RateLimitType,
  identifier: string
): Promise<void> => {
  const key = `ratelimit:${type}:${identifier.toLowerCase()}`;
  const blockKey = `ratelimit:block:${type}:${identifier.toLowerCase()}`;
  const redis = getRedis();

  try {
    await redis.del(key);
    await redis.del(blockKey);
  } catch (error) {
    console.error('Rate limit reset failed:', error);
  }
};

/**
 * Helper to enforce rate limit - throws GraphQLError if blocked
 */
export const enforceRateLimit = async (
  type: RateLimitType,
  identifier: string
): Promise<void> => {
  const result = await checkRateLimit(type, identifier);
  
  if (!result.allowed) {
    const minutes = Math.ceil(result.resetIn / 60);
    throw new GraphQLError(
      `Too many attempts. Please try again in ${minutes} minute${minutes > 1 ? 's' : ''}.`,
      {
        extensions: {
          code: 'RATE_LIMITED',
          resetIn: result.resetIn,
          blocked: result.blocked,
        },
      }
    );
  }
};

// ==========================================
// Session/Token Invalidation
// ==========================================

/**
 * Invalidate all tokens for a user (on password change, logout all, etc.)
 * Stores a "tokens invalid before" timestamp
 */
export const invalidateAllUserTokens = async (userId: string): Promise<void> => {
  const key = `user:tokens_invalid_before:${userId}`;
  const now = Math.floor(Date.now() / 1000);
  const redis = getRedis();
  
  try {
    // Set the timestamp - tokens issued before this are invalid
    // Keep for 30 days (longer than any token lifetime)
    await redis.setex(key, 30 * 24 * 60 * 60, now.toString());
  } catch (error) {
    console.error('Failed to invalidate user tokens:', error);
    throw new GraphQLError('Failed to invalidate sessions', {
      extensions: { code: 'INTERNAL_ERROR' },
    });
  }
};

/**
 * Check if a token was issued before the user's invalidation timestamp
 * Returns true if token is valid (not invalidated)
 */
export const isTokenValid = async (userId: string, tokenIssuedAt: number): Promise<boolean> => {
  const key = `user:tokens_invalid_before:${userId}`;
  const redis = getRedis();
  
  try {
    const invalidBefore = await redis.get(key);
    if (!invalidBefore) {
      // No invalidation timestamp, token is valid
      return true;
    }
    
    const invalidBeforeTimestamp = parseInt(invalidBefore, 10);
    // Token is valid if it was issued AFTER the invalidation timestamp
    return tokenIssuedAt > invalidBeforeTimestamp;
  } catch (error) {
    console.error('Failed to check token validity:', error);
    // On error, consider token valid (fail open)
    return true;
  }
};

// ==========================================
// Security Logging
// ==========================================

/**
 * Log security event (failed auth, suspicious activity)
 */
export const logSecurityEvent = (
  eventType: 'AUTH_FAILURE' | 'INJECTION_ATTEMPT' | 'IDOR_ATTEMPT' | 'RATE_LIMIT' | 'SUSPICIOUS',
  details: {
    userId?: string;
    ip?: string;
    userAgent?: string;
    path?: string;
    input?: unknown;
    reason?: string;
  }
): void => {
  // In production, send to security monitoring service
  console.warn(`🔒 SECURITY EVENT [${eventType}]:`, {
    timestamp: new Date().toISOString(),
    ...details,
    // Truncate input to prevent log injection
    input: details.input 
      ? JSON.stringify(details.input).substring(0, 500) 
      : undefined,
  });
};

// ==========================================
// Export Everything
// ==========================================

export default {
  // Sanitization
  sanitizeStrict,
  sanitizeBasic,
  sanitizeRich,
  escapeHtml,
  sanitizeObject,
  sanitizeSearchQuery,
  
  // NoSQL Injection
  hasNoSQLInjection,
  validateEnum,
  isValidObjectId,
  validateObjectId,
  
  // Validation
  validateEmail,
  validatePhone,
  validateUrl,
  validateName,
  validateText,
  validatePassword,
  validateRating,
  validateAmount,
  
  // IDOR Protection
  verifyOwnership,
  verifyAccess,
  
  // Rate Limiting
  checkRateLimit,
  incrementRateLimit,
  resetRateLimit,
  enforceRateLimit,
  RATE_LIMIT_CONFIG,
  
  // Token/Session Management
  invalidateAllUserTokens,
  isTokenValid,
  
  // Logging
  logSecurityEvent,
  
  // Constants
  MAX_LENGTHS,
};
