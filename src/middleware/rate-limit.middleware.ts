/**
 * Rate Limiting Middleware
 * Protects API endpoints from abuse and brute force attacks
 * 
 * Strategy: Hybrid Rate Limiting
 * - Unauthenticated endpoints: Rate limited by IP address
 * - Authenticated endpoints: Rate limited by User ID (more accurate)
 * - Falls back to IP if user ID not available
 */

import { NextRequest, NextResponse } from 'next/server';
import RedisClient, { rateLimit } from '@/lib/redis';
import { config } from '@/config';

// Rate limit configurations for different operations
export const RateLimitConfig = {
  // General API requests
  API: {
    limit: config.security.rateLimitMaxRequests, // 100 requests
    windowSeconds: config.security.rateLimitWindowMs / 1000, // 15 minutes
  },
  
  // Authentication endpoints (stricter)
  AUTH: {
    limit: 5,
    windowSeconds: 60, // 5 attempts per minute
  },
  
  // Login attempts
  LOGIN: {
    limit: 10,
    windowSeconds: 900, // 10 attempts per 15 minutes
  },
  
  // Password reset
  PASSWORD_RESET: {
    limit: 3,
    windowSeconds: 3600, // 3 attempts per hour
  },
  
  // OTP verification
  OTP: {
    limit: 5,
    windowSeconds: 300, // 5 attempts per 5 minutes
  },
  
  // File uploads
  UPLOAD: {
    limit: 20,
    windowSeconds: 60, // 20 uploads per minute
  },
  
  // Messaging
  MESSAGE: {
    limit: 60,
    windowSeconds: 60, // 60 messages per minute
  },
};

export type RateLimitType = keyof typeof RateLimitConfig;

// Operations that should always use IP (unauthenticated endpoints)
const IP_ONLY_OPERATIONS = [
  'login',
  'adminlogin',
  'register',
  'verifyemail',
  'resendverificationotp',
  'forgotpassword',
  'resetpassword',
  'adminforgotpassword',
  'adminresetpassword',
];

/**
 * Get client IP from request
 */
export const getClientIp = (request: NextRequest): string => {
  // Check various headers for real IP (behind proxies/load balancers)
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  
  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }
  
  // Fallback - this might not work in all environments
  return 'unknown';
};

/**
 * Extract user ID from JWT token in Authorization header
 */
const extractUserIdFromToken = (request: NextRequest): string | null => {
  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    
    const token = authHeader.substring(7);
    // Decode JWT payload without verification (just for rate limiting identifier)
    // Full verification happens in auth middleware
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return payload.userId || null;
  } catch {
    return null;
  }
};

/**
 * Determine the best identifier for rate limiting
 * - Uses User ID for authenticated requests (more accurate)
 * - Falls back to IP for unauthenticated requests
 */
const getRateLimitIdentifier = (
  request: NextRequest,
  operationName?: string
): { identifier: string; type: 'user' | 'ip' } => {
  const ip = getClientIp(request);
  
  // For unauthenticated operations, always use IP
  if (operationName && IP_ONLY_OPERATIONS.includes(operationName.toLowerCase())) {
    return { identifier: ip, type: 'ip' };
  }
  
  // Try to extract user ID from token
  const userId = extractUserIdFromToken(request);
  if (userId) {
    return { identifier: `user:${userId}`, type: 'user' };
  }
  
  // Fall back to IP
  return { identifier: ip, type: 'ip' };
};

/**
 * Check if request is rate limited
 * Uses hybrid approach: User ID for authenticated, IP for unauthenticated
 */
export const checkRateLimit = async (
  request: NextRequest,
  type: RateLimitType = 'API',
  customIdentifier?: string,
  operationName?: string
): Promise<{ limited: boolean; remaining: number; resetIn: number; identifierType: 'user' | 'ip' }> => {
  try {
    const { identifier, type: identifierType } = customIdentifier 
      ? { identifier: customIdentifier, type: 'ip' as const }
      : getRateLimitIdentifier(request, operationName);
    
    const key = `${type.toLowerCase()}:${identifier}`;
    const limitConfig = RateLimitConfig[type];
    
    const result = await rateLimit.check(key, limitConfig.limit, limitConfig.windowSeconds);
    
    return {
      limited: !result.allowed,
      remaining: result.remaining,
      resetIn: result.resetIn,
      identifierType,
    };
  } catch (error) {
    // If Redis is unavailable, allow the request but log the error
    console.error('Rate limit check failed:', error);
    return {
      limited: false,
      remaining: RateLimitConfig[type].limit,
      resetIn: RateLimitConfig[type].windowSeconds,
      identifierType: 'ip',
    };
  }
};

/**
 * Rate limit response headers
 */
export const rateLimitHeaders = (
  remaining: number,
  resetIn: number,
  limit: number
): Record<string, string> => ({
  'X-RateLimit-Limit': limit.toString(),
  'X-RateLimit-Remaining': remaining.toString(),
  'X-RateLimit-Reset': resetIn.toString(),
});

/**
 * Rate limited error response
 */
export const rateLimitedResponse = (resetIn: number): NextResponse => {
  return NextResponse.json(
    {
      errors: [
        {
          message: `Too many requests. Please try again in ${resetIn} seconds.`,
          extensions: { code: 'RATE_LIMITED' },
        },
      ],
    },
    {
      status: 429,
      headers: {
        'Retry-After': resetIn.toString(),
      },
    }
  );
};

/**
 * Extract operation name from GraphQL request body
 */
export const extractGraphQLOperation = async (
  request: NextRequest
): Promise<{ operationName?: string; operationType?: string }> => {
  try {
    // Clone request to read body without consuming it
    const body = await request.clone().json();
    
    let operationName = body.operationName;
    
    // If no operationName, try to extract from query
    if (!operationName && body.query) {
      const match = body.query.match(/(?:query|mutation|subscription)\s+(\w+)/);
      if (match) {
        operationName = match[1];
      }
    }
    
    // Determine operation type
    let operationType = 'query';
    if (body.query) {
      if (body.query.trim().startsWith('mutation')) {
        operationType = 'mutation';
      } else if (body.query.trim().startsWith('subscription')) {
        operationType = 'subscription';
      }
    }
    
    return { operationName, operationType };
  } catch {
    return {};
  }
};

/**
 * Determine rate limit type based on GraphQL operation
 */
export const getRateLimitTypeForOperation = (operationName?: string): RateLimitType => {
  if (!operationName) return 'API';
  
  const authOperations = [
    'login',
    'adminLogin',
    'register',
    'refreshToken',
    'adminRefreshToken',
  ];
  
  const passwordOperations = [
    'forgotPassword',
    'resetPassword',
    'adminForgotPassword',
    'adminResetPassword',
  ];
  
  const otpOperations = [
    'verifyEmail',
    'resendVerificationOtp',
  ];
  
  const uploadOperations = [
    'uploadProfilePhoto',
    'uploadServiceImages',
    'uploadProviderDocuments',
  ];
  
  const messageOperations = [
    'sendMessage',
  ];
  
  const lowerOpName = operationName.toLowerCase();
  
  if (authOperations.some(op => lowerOpName.includes(op.toLowerCase()))) {
    return 'AUTH';
  }
  
  if (lowerOpName.includes('login')) {
    return 'LOGIN';
  }
  
  if (passwordOperations.some(op => lowerOpName.includes(op.toLowerCase()))) {
    return 'PASSWORD_RESET';
  }
  
  if (otpOperations.some(op => lowerOpName.includes(op.toLowerCase()))) {
    return 'OTP';
  }
  
  if (uploadOperations.some(op => lowerOpName.includes(op.toLowerCase()))) {
    return 'UPLOAD';
  }
  
  if (messageOperations.some(op => lowerOpName.includes(op.toLowerCase()))) {
    return 'MESSAGE';
  }
  
  return 'API';
};

/**
 * Block suspicious IPs (can be extended to use an IP blocklist)
 */
export const isBlockedIp = async (ip: string): Promise<boolean> => {
  try {
    const client = await RedisClient.connect();
    const blocked = await client.sismember('blocked_ips', ip);
    return blocked === 1;
  } catch {
    return false;
  }
};

/**
 * Add IP to blocklist
 */
export const blockIp = async (ip: string, durationSeconds: number = 86400): Promise<void> => {
  try {
    const client = await RedisClient.connect();
    await client.sadd('blocked_ips', ip);
    // Remove after duration
    setTimeout(async () => {
      await client.srem('blocked_ips', ip);
    }, durationSeconds * 1000);
  } catch (error) {
    console.error('Failed to block IP:', error);
  }
};
