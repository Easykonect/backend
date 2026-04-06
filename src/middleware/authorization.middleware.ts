/**
 * Authorization Middleware
 * Centralized authorization checks to prevent IDOR vulnerabilities
 * 
 * CRITICAL: Use these functions for ALL resource access
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { UserRole } from '@/constants';

// ==================
// Types
// ==================

export interface AuthContext {
  userId: string;
  role: string;
}

export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
}

// ==================
// Resource Ownership Checks
// ==================

/**
 * Check if user owns a booking (as customer or provider)
 */
export const canAccessBooking = async (
  userId: string,
  role: string,
  bookingId: string
): Promise<AuthorizationResult> => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { provider: true },
  });

  if (!booking) {
    return { allowed: false, reason: 'Booking not found' };
  }

  // Admin can access all bookings
  if (role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN) {
    return { allowed: true };
  }

  // User owns the booking
  if (booking.userId === userId) {
    return { allowed: true };
  }

  // Provider owns the booking
  if (booking.provider.userId === userId) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'Access denied' };
};

/**
 * Check if user owns a service
 */
export const canAccessService = async (
  userId: string,
  role: string,
  serviceId: string,
  requireOwnership: boolean = false
): Promise<AuthorizationResult> => {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    include: { provider: true },
  });

  if (!service) {
    return { allowed: false, reason: 'Service not found' };
  }

  // Admin can access all services
  if (role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN) {
    return { allowed: true };
  }

  // Public read access (for non-ownership operations)
  if (!requireOwnership) {
    return { allowed: true };
  }

  // Provider owns the service
  if (service.provider.userId === userId) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'You can only modify your own services' };
};

/**
 * Check if user can access a conversation
 */
export const canAccessConversation = async (
  userId: string,
  role: string,
  conversationId: string
): Promise<AuthorizationResult> => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { participantIds: true, type: true },
  });

  if (!conversation) {
    return { allowed: false, reason: 'Conversation not found' };
  }

  // Admin can access all conversations for moderation
  if (role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN) {
    return { allowed: true };
  }

  // User is a participant
  if (conversation.participantIds.includes(userId)) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'Access denied' };
};

/**
 * Check if user can access a review
 */
export const canAccessReview = async (
  userId: string,
  role: string,
  reviewId: string,
  requireOwnership: boolean = false
): Promise<AuthorizationResult> => {
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    include: {
      booking: {
        include: { provider: true },
      },
    },
  });

  if (!review) {
    return { allowed: false, reason: 'Review not found' };
  }

  // Admin can access all reviews
  if (role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN) {
    return { allowed: true };
  }

  // Public read access (reviews are generally public)
  if (!requireOwnership) {
    return { allowed: true };
  }

  // User wrote the review
  if (review.booking.userId === userId) {
    return { allowed: true };
  }

  // Provider can respond to reviews about them
  if (review.booking.provider.userId === userId) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'You can only modify your own reviews' };
};

/**
 * Check if user can access a dispute
 */
export const canAccessDispute = async (
  userId: string,
  role: string,
  disputeId: string
): Promise<AuthorizationResult> => {
  const dispute = await prisma.dispute.findUnique({
    where: { id: disputeId },
    include: {
      booking: {
        include: { provider: true },
      },
    },
  });

  if (!dispute) {
    return { allowed: false, reason: 'Dispute not found' };
  }

  // Admin can access all disputes
  if (role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN) {
    return { allowed: true };
  }

  // User is the booking customer
  if (dispute.booking.userId === userId) {
    return { allowed: true };
  }

  // User is the provider
  if (dispute.booking.provider.userId === userId) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'Access denied' };
};

/**
 * Check if user can access a notification
 */
export const canAccessNotification = async (
  userId: string,
  notificationId: string
): Promise<AuthorizationResult> => {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
    select: { userId: true },
  });

  if (!notification) {
    return { allowed: false, reason: 'Notification not found' };
  }

  // Only the notification owner can access
  if (notification.userId === userId) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'Access denied' };
};

/**
 * Check if user can access another user's profile
 * This restricts what data is visible based on relationship
 */
export const canAccessUserProfile = async (
  requesterId: string,
  requesterRole: string,
  targetUserId: string,
  accessLevel: 'public' | 'private' | 'full'
): Promise<AuthorizationResult> => {
  // Self access always allowed
  if (requesterId === targetUserId) {
    return { allowed: true };
  }

  // Admin can access all profiles
  if (requesterRole === UserRole.ADMIN || requesterRole === UserRole.SUPER_ADMIN) {
    return { allowed: true };
  }

  // For public access level (name, photo only)
  if (accessLevel === 'public') {
    return { allowed: true };
  }

  // Check if users have a relationship (booking, message, etc.)
  const hasRelationship = await checkUserRelationship(requesterId, targetUserId);
  
  if (accessLevel === 'private' && hasRelationship) {
    return { allowed: true };
  }

  // Full access only for self or admin
  if (accessLevel === 'full') {
    return { allowed: false, reason: 'Access denied' };
  }

  return { allowed: false, reason: 'Access denied' };
};

/**
 * Check if two users have a business relationship
 * (booking, conversation, etc.)
 */
const checkUserRelationship = async (
  userId1: string,
  userId2: string
): Promise<boolean> => {
  // Check for shared bookings
  const sharedBooking = await prisma.booking.findFirst({
    where: {
      OR: [
        { userId: userId1, provider: { userId: userId2 } },
        { userId: userId2, provider: { userId: userId1 } },
      ],
    },
  });

  if (sharedBooking) return true;

  // Check for conversations
  const sharedConversation = await prisma.conversation.findFirst({
    where: {
      participantIds: { hasEvery: [userId1, userId2] },
      isActive: true,
    },
  });

  if (sharedConversation) return true;

  return false;
};

// ==================
// Authorization Helpers
// ==================

/**
 * Require authorization - throws if not allowed
 */
export const requireAuthorization = (result: AuthorizationResult): void => {
  if (!result.allowed) {
    throw new GraphQLError(result.reason || 'Access denied', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
};

/**
 * Check if user is admin
 */
export const isAdmin = (role: string): boolean => {
  return role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
};

/**
 * Check if user is super admin
 */
export const isSuperAdmin = (role: string): boolean => {
  return role === UserRole.SUPER_ADMIN;
};

/**
 * Require admin role
 */
export const requireAdmin = (role: string): void => {
  if (!isAdmin(role)) {
    throw new GraphQLError('Admin access required', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
};

/**
 * Require super admin role
 */
export const requireSuperAdmin = (role: string): void => {
  if (!isSuperAdmin(role)) {
    throw new GraphQLError('Super admin access required', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
};

// ==================
// Rate Limiting for Sensitive Operations
// ==================

import RedisClient from '@/lib/redis';

/**
 * Rate limit key prefix for security operations
 */
const RATE_LIMIT_PREFIX = 'security:rate:';

/**
 * Check and enforce rate limit
 */
export const checkRateLimit = async (
  key: string,
  maxAttempts: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> => {
  const redisClient = RedisClient.getInstance();
  if (!redisClient) {
    // If Redis unavailable, allow but log warning
    console.warn('Redis unavailable for rate limiting');
    return { allowed: true, remaining: maxAttempts, resetAt: new Date() };
  }

  const fullKey = `${RATE_LIMIT_PREFIX}${key}`;
  
  const current = await redisClient.incr(fullKey);
  
  if (current === 1) {
    await redisClient.expire(fullKey, windowSeconds);
  }

  const ttl = await redisClient.ttl(fullKey);
  const resetAt = new Date(Date.now() + (ttl > 0 ? ttl : windowSeconds) * 1000);
  const remaining = Math.max(0, maxAttempts - current);

  return {
    allowed: current <= maxAttempts,
    remaining,
    resetAt,
  };
};

/**
 * Enforce rate limit - throws if exceeded
 */
export const enforceRateLimit = async (
  identifier: string,
  operation: string,
  maxAttempts: number,
  windowSeconds: number
): Promise<void> => {
  const key = `${operation}:${identifier}`;
  const result = await checkRateLimit(key, maxAttempts, windowSeconds);

  if (!result.allowed) {
    throw new GraphQLError(
      `Too many attempts. Please try again after ${Math.ceil((result.resetAt.getTime() - Date.now()) / 1000)} seconds.`,
      {
        extensions: {
          code: 'RATE_LIMIT_EXCEEDED',
          resetAt: result.resetAt.toISOString(),
        },
      }
    );
  }
};
