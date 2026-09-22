/**
 * Notification Service
 * Handles system notifications for users
 *
 * Notification Types:
 * - Booking notifications (created, accepted, rejected, etc.)
 * - Payment notifications
 * - Review notifications
 * - Provider notifications (verification, service approval)
 * - Dispute notifications
 * - Message notifications
 * - System announcements
 *
 * Every notification created here is also sent to its user's socket as
 * notification:new. In-app notifications are always created; push is sent
 * separately (see push.service), where the user's notification settings apply.
 */

import { randomBytes } from 'crypto';
import { GraphQLError } from 'graphql';
import type { $Enums, Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { NotificationType, UserRole } from '@/constants';
import { emitToUser } from '@/lib/socket';
import { sendPushToUsers } from '@/services/push.service';

// ==================
// Types
// ==================

interface CreateNotificationInput {
  userId: string;
  type: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

interface PaginationParams {
  page?: number;
  limit?: number;
}

interface NotificationFilters {
  type?: string;
  isRead?: boolean;
}

// The fields notification:new carries
interface CreatedNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: string | null;
  createdAt: Date | string;
}

// ==================
// Real-time delivery
// ==================

const parseMetadata = (metadata?: string | null): Record<string, unknown> | null => {
  if (!metadata) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/**
 * Send notification:new to the user's open sockets. Best effort: the
 * notification is saved either way.
 */
const emitNotificationCreated = async (notification: CreatedNotification) => {
  try {
    await emitToUser(notification.userId, 'notification:new', {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      entityType: notification.entityType ?? null,
      entityId: notification.entityId ?? null,
      metadata: parseMetadata(notification.metadata),
      createdAt: new Date(notification.createdAt).toISOString(),
    });
  } catch (error) {
    console.error('Failed to emit notification:new', error);
  }
};

/**
 * A new ObjectId, so notifications created together have IDs to send over the
 * socket and to mark when their push goes out
 */
const newObjectId = (): string =>
  Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + randomBytes(8).toString('hex');

// ==================
// Notification Functions
// ==================

/**
 * Create a notification
 */
export const createNotification = async (input: CreateNotificationInput) => {
  const { userId, type, title, message, entityType, entityId, metadata } = input;

  const notification = await prisma.notification.create({
    data: {
      userId,
      type: type as $Enums.NotificationType,
      title,
      message,
      entityType,
      entityId,
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
  });

  await emitNotificationCreated(notification);

  return notification;
};

/**
 * Create notifications for multiple users. Returns how many were created and
 * each one's ID by user ID.
 */
export const createBulkNotifications = async (
  userIds: string[],
  type: string,
  title: string,
  message: string,
  entityType?: string,
  entityId?: string,
  metadata?: Record<string, unknown>
): Promise<{ count: number; notificationIds: Record<string, string> }> => {
  if (userIds.length === 0) {
    return { count: 0, notificationIds: {} };
  }

  const createdAt = new Date();
  const rows = userIds.map((userId) => ({
    id: newObjectId(),
    userId,
    type: type as $Enums.NotificationType,
    title,
    message,
    entityType,
    entityId,
    metadata: metadata ? JSON.stringify(metadata) : null,
    createdAt,
  }));

  const result = await prisma.notification.createMany({ data: rows });

  await Promise.all(rows.map((row) => emitNotificationCreated(row)));

  return {
    count: result.count,
    notificationIds: Object.fromEntries(rows.map((row) => [row.userId, row.id])),
  };
};

/**
 * Get notification by ID
 */
export const getNotificationById = async (userId: string, notificationId: string) => {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });

  if (!notification) {
    throw new GraphQLError('Notification not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (notification.userId !== userId) {
    throw new GraphQLError('Access denied', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  return notification;
};

/**
 * Get user's notifications
 */
export const getMyNotifications = async (
  userId: string,
  filters: NotificationFilters = {},
  pagination: PaginationParams = {}
) => {
  const { page = 1, limit = 20 } = pagination;
  const { type, isRead } = filters;
  const skip = (page - 1) * limit;

  const whereClause: Prisma.NotificationWhereInput = {
    userId,
  };

  if (type) {
    whereClause.type = type as $Enums.NotificationType;
  }

  if (typeof isRead === 'boolean') {
    whereClause.isRead = isRead;
  }

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.notification.count({
      where: whereClause,
    }),
  ]);

  const totalPages = Math.ceil(total / limit);

  return {
    notifications,
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

/**
 * Mark notification as read
 */
export const markNotificationAsRead = async (userId: string, notificationId: string) => {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });

  if (!notification) {
    throw new GraphQLError('Notification not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (notification.userId !== userId) {
    throw new GraphQLError('Access denied', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  const updated = await prisma.notification.update({
    where: { id: notificationId },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  });

  return updated;
};

/**
 * Mark all notifications as read
 */
export const markAllNotificationsAsRead = async (userId: string) => {
  await prisma.notification.updateMany({
    where: {
      userId,
      isRead: false,
    },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  });

  return { success: true, message: 'All notifications marked as read' };
};

/**
 * Delete a notification
 */
export const deleteNotification = async (userId: string, notificationId: string) => {
  const notification = await prisma.notification.findUnique({
    where: { id: notificationId },
  });

  if (!notification) {
    throw new GraphQLError('Notification not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (notification.userId !== userId) {
    throw new GraphQLError('Access denied', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  await prisma.notification.delete({
    where: { id: notificationId },
  });

  return { success: true, message: 'Notification deleted' };
};

/**
 * Delete all read notifications
 */
export const deleteReadNotifications = async (userId: string) => {
  await prisma.notification.deleteMany({
    where: {
      userId,
      isRead: true,
    },
  });

  return { success: true, message: 'Read notifications deleted' };
};

/**
 * Get unread notification count
 */
export const getUnreadNotificationCount = async (userId: string) => {
  const count = await prisma.notification.count({
    where: {
      userId,
      isRead: false,
    },
  });

  return { count };
};

/**
 * Get notification statistics
 */
export const getNotificationStats = async (userId: string) => {
  const [total, unread, byType] = await Promise.all([
    prisma.notification.count({
      where: { userId },
    }),
    prisma.notification.count({
      where: { userId, isRead: false },
    }),
    prisma.notification.groupBy({
      by: ['type'],
      where: { userId },
      _count: true,
    }),
  ]);

  return {
    total,
    unread,
    read: total - unread,
    // The schema field is a JSON string of counts per type
    byType: JSON.stringify(
      byType.reduce((acc, item) => {
        acc[item.type] = item._count;
        return acc;
      }, {} as Record<string, number>)
    ),
  };
};

// ==================
// Helper Functions for Creating Specific Notifications
// ==================
// These create the in-app notification only. For the matching push, call the
// helper in push.service with { notificationId } so the notification records
// that its push went out.

/**
 * Notify a provider about a new booking request. `providerId` is the
 * provider's user ID.
 */
export const notifyBookingCreated = async (
  providerId: string,
  bookingId: string,
  serviceName: string,
  customerName: string
) => {
  return createNotification({
    userId: providerId,
    type: NotificationType.BOOKING_CREATED,
    title: 'New Booking Request',
    message: `${customerName} has requested a booking for ${serviceName}`,
    entityType: 'booking',
    entityId: bookingId,
  });
};

/**
 * Notify about booking acceptance
 */
export const notifyBookingAccepted = async (
  userId: string,
  bookingId: string,
  serviceName: string,
  providerName: string
) => {
  return createNotification({
    userId,
    type: NotificationType.BOOKING_ACCEPTED,
    title: 'Booking Accepted',
    message: `${providerName} has accepted your booking for ${serviceName}`,
    entityType: 'booking',
    entityId: bookingId,
  });
};

/**
 * Notify about booking rejection
 */
export const notifyBookingRejected = async (
  userId: string,
  bookingId: string,
  serviceName: string,
  reason?: string
) => {
  return createNotification({
    userId,
    type: NotificationType.BOOKING_REJECTED,
    title: 'Booking Rejected',
    message: reason
      ? `Your booking for ${serviceName} was rejected: ${reason}`
      : `Your booking for ${serviceName} was rejected`,
    entityType: 'booking',
    entityId: bookingId,
  });
};

/**
 * Notify about booking cancellation
 */
export const notifyBookingCancelled = async (
  recipientId: string,
  bookingId: string,
  serviceName: string,
  cancelledBy: string,
  reason?: string
) => {
  return createNotification({
    userId: recipientId,
    type: NotificationType.BOOKING_CANCELLED,
    title: 'Booking Cancelled',
    message: reason
      ? `Booking for ${serviceName} was cancelled by ${cancelledBy}: ${reason}`
      : `Booking for ${serviceName} was cancelled by ${cancelledBy}`,
    entityType: 'booking',
    entityId: bookingId,
  });
};

/**
 * Notify about service start
 */
export const notifyBookingStarted = async (
  userId: string,
  bookingId: string,
  serviceName: string
) => {
  return createNotification({
    userId,
    type: NotificationType.BOOKING_STARTED,
    title: 'Service Started',
    message: `Your service ${serviceName} has started`,
    entityType: 'booking',
    entityId: bookingId,
  });
};

/**
 * Notify about booking completion
 */
export const notifyBookingCompleted = async (
  userId: string,
  bookingId: string,
  serviceName: string
) => {
  return createNotification({
    userId,
    type: NotificationType.BOOKING_COMPLETED,
    title: 'Service Completed',
    message: `Your service ${serviceName} has been completed. Please leave a review!`,
    entityType: 'booking',
    entityId: bookingId,
  });
};

/**
 * Notify a provider about a new review. `providerId` is the provider's user ID.
 */
export const notifyReviewReceived = async (
  providerId: string,
  reviewId: string,
  rating: number,
  customerName: string
) => {
  return createNotification({
    userId: providerId,
    type: NotificationType.REVIEW_RECEIVED,
    title: 'New Review Received',
    message: `${customerName} gave you a ${rating}-star review`,
    entityType: 'review',
    entityId: reviewId,
  });
};

/**
 * Notify about review response
 */
export const notifyReviewResponse = async (
  userId: string,
  reviewId: string,
  providerName: string
) => {
  return createNotification({
    userId,
    type: NotificationType.REVIEW_RESPONSE,
    title: 'Provider Responded to Your Review',
    message: `${providerName} has responded to your review`,
    entityType: 'review',
    entityId: reviewId,
  });
};

/**
 * Notify about provider verification. `providerId` (the provider profile ID)
 * becomes the entityId when given.
 */
export const notifyVerificationApproved = async (userId: string, providerId?: string) => {
  return createNotification({
    userId,
    type: NotificationType.VERIFICATION_APPROVED,
    title: 'Verification Approved',
    message: 'Congratulations! Your provider profile has been verified.',
    entityType: 'provider',
    entityId: providerId,
  });
};

/**
 * Notify about provider verification rejection
 */
export const notifyVerificationRejected = async (
  userId: string,
  reason: string,
  providerId?: string
) => {
  return createNotification({
    userId,
    type: NotificationType.VERIFICATION_REJECTED,
    title: 'Verification Rejected',
    message: `Your verification was rejected: ${reason}`,
    entityType: 'provider',
    entityId: providerId,
  });
};

/**
 * Notify about service approval
 */
export const notifyServiceApproved = async (
  userId: string,
  serviceId: string,
  serviceName: string
) => {
  return createNotification({
    userId,
    type: NotificationType.SERVICE_APPROVED,
    title: 'Service Approved',
    message: `Your service "${serviceName}" has been approved and is now live`,
    entityType: 'service',
    entityId: serviceId,
  });
};

/**
 * Notify about service rejection
 */
export const notifyServiceRejected = async (
  userId: string,
  serviceId: string,
  serviceName: string,
  reason: string
) => {
  return createNotification({
    userId,
    type: NotificationType.SERVICE_REJECTED,
    title: 'Service Rejected',
    message: `Your service "${serviceName}" was rejected: ${reason}`,
    entityType: 'service',
    entityId: serviceId,
  });
};

/**
 * Notify a provider that one of their services was suspended
 */
export const notifyServiceSuspended = async (
  userId: string,
  serviceId: string,
  serviceName: string,
  reason?: string
) => {
  return createNotification({
    userId,
    type: NotificationType.SERVICE_SUSPENDED,
    title: 'Service Suspended',
    message: reason
      ? `Your service "${serviceName}" has been suspended: ${reason}`
      : `Your service "${serviceName}" has been suspended`,
    entityType: 'service',
    entityId: serviceId,
  });
};

/**
 * Notify about dispute opened
 */
export const notifyDisputeOpened = async (
  recipientId: string,
  disputeId: string,
  bookingId: string
) => {
  return createNotification({
    userId: recipientId,
    type: NotificationType.DISPUTE_OPENED,
    title: 'Dispute Opened',
    message: 'A dispute has been opened for one of your bookings',
    entityType: 'dispute',
    entityId: disputeId,
    metadata: { bookingId },
  });
};

/**
 * Notify about a change to a dispute, such as an admin taking it under review.
 * `update` is the message shown.
 */
export const notifyDisputeUpdated = async (
  userId: string,
  disputeId: string,
  update: string,
  bookingId?: string
) => {
  return createNotification({
    userId,
    type: NotificationType.DISPUTE_UPDATED,
    title: 'Dispute Updated',
    message: update,
    entityType: 'dispute',
    entityId: disputeId,
    metadata: bookingId ? { bookingId } : undefined,
  });
};

/**
 * Notify about dispute resolution
 */
export const notifyDisputeResolved = async (
  userId: string,
  disputeId: string,
  resolution: string
) => {
  return createNotification({
    userId,
    type: NotificationType.DISPUTE_RESOLVED,
    title: 'Dispute Resolved',
    message: `Your dispute has been resolved: ${resolution}`,
    entityType: 'dispute',
    entityId: disputeId,
  });
};

/**
 * Notify about account suspension
 */
export const notifyAccountSuspended = async (userId: string, reason: string) => {
  return createNotification({
    userId,
    type: NotificationType.ACCOUNT_SUSPENDED,
    title: 'Account Suspended',
    message: `Your account has been suspended: ${reason}`,
  });
};

/**
 * Notify about account activation
 */
export const notifyAccountActivated = async (userId: string) => {
  return createNotification({
    userId,
    type: NotificationType.ACCOUNT_ACTIVATED,
    title: 'Account Activated',
    message: 'Your account has been activated. Welcome back!',
  });
};

// ==========================================
// Admin Broadcasts and Announcements
// ==========================================

export type BroadcastTarget =
  | { mode: 'USER_IDS'; userIds: string[] }
  | { mode: 'ROLE'; roles: string[] } // e.g. ['SERVICE_USER', 'SERVICE_PROVIDER']
  | { mode: 'ALL' }
  | { mode: 'LOCATION'; city?: string; state?: string };

export interface BroadcastResult {
  recipientCount: number;
  inAppCreated: number;
  pushDelivery: 'sent' | 'no_recipients' | 'failed';
  pushError?: string;
}

/** A broadcast as the GraphQL input gives it */
export interface BroadcastInput {
  title: string;
  message: string;
  target: {
    mode: 'USER_IDS' | 'ROLE' | 'ALL' | 'LOCATION';
    userIds?: string[] | null;
    roles?: string[] | null;
    city?: string | null;
    state?: string | null;
  };
  metadataJson?: string | null;
}

/** An announcement as the GraphQL input gives it */
export interface AnnouncementInput {
  title: string;
  message: string;
  targetRoles?: string[] | null;
}

export const BROADCAST_TITLE_MAX_LENGTH = 100;
export const BROADCAST_MESSAGE_MAX_LENGTH = 1000;
// Broadcasts and announcements together, per admin per 24 hours
export const BROADCAST_DAILY_LIMIT = 50;
const BROADCAST_WINDOW_SECONDS = 24 * 60 * 60;

const KNOWN_ROLES: string[] = Object.values(UserRole);

const invalidInput = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'INVALID_INPUT' } });

/**
 * The roles an admin can reach with sendSystemAnnouncement: customers and
 * providers, plus admins for a super admin. Nobody reaches super admins.
 */
export const announcementRolesFor = (adminRole: string): string[] =>
  adminRole === UserRole.SUPER_ADMIN
    ? [UserRole.SERVICE_USER, UserRole.SERVICE_PROVIDER, UserRole.ADMIN]
    : [UserRole.SERVICE_USER, UserRole.SERVICE_PROVIDER];

/**
 * Accounts without a ban in force. Banning doesn't change an account's status.
 * On MongoDB `null` doesn't match a field that was never written, so both are
 * checked; an expired ban has bannedUntil in the past.
 */
const notBanned = (now = new Date()): Prisma.UserWhereInput => ({
  OR: [
    { bannedAt: null },
    { bannedAt: { isSet: false } },
    { bannedUntil: { isSet: true, not: null, lte: now } },
  ],
});

/**
 * Trimmed title and message, refusing blank or over-long text
 */
const validateBroadcastText = (title: string, message: string) => {
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const cleanMessage = typeof message === 'string' ? message.trim() : '';

  if (!cleanTitle) throw invalidInput('Title is required');
  if (cleanTitle.length > BROADCAST_TITLE_MAX_LENGTH) {
    throw invalidInput(`Title can be at most ${BROADCAST_TITLE_MAX_LENGTH} characters`);
  }
  if (!cleanMessage) throw invalidInput('Message is required');
  if (cleanMessage.length > BROADCAST_MESSAGE_MAX_LENGTH) {
    throw invalidInput(`Message can be at most ${BROADCAST_MESSAGE_MAX_LENGTH} characters`);
  }

  return { title: cleanTitle, message: cleanMessage };
};

/**
 * Refuse role names that don't exist, then roles the caller can't reach
 */
const assertTargetRoles = (roles: string[], allowedRoles: string[]) => {
  const unknown = roles.filter((role) => !KNOWN_ROLES.includes(role));
  if (unknown.length > 0) {
    throw invalidInput(
      `Unknown role(s): ${unknown.join(', ')}. Use SERVICE_USER, SERVICE_PROVIDER, ADMIN or SUPER_ADMIN`
    );
  }

  const disallowed = roles.filter((role) => !allowedRoles.includes(role));
  if (disallowed.length > 0) {
    throw new GraphQLError(
      `You are not authorised to broadcast to role(s): ${disallowed.join(', ')}`,
      { extensions: { code: 'FORBIDDEN' } }
    );
  }
};

/**
 * Translate the GraphQL BroadcastTargetInput into a BroadcastTarget, checking
 * that the fields the mode needs are there
 */
const buildBroadcastTarget = (input: BroadcastInput['target']): BroadcastTarget => {
  switch (input.mode) {
    case 'USER_IDS':
      if (!input.userIds || input.userIds.length === 0) {
        throw invalidInput('USER_IDS target requires a non-empty userIds list');
      }
      return { mode: 'USER_IDS', userIds: input.userIds };
    case 'ROLE':
      if (!input.roles || input.roles.length === 0) {
        throw invalidInput('ROLE target requires a non-empty roles list');
      }
      return { mode: 'ROLE', roles: input.roles };
    case 'ALL':
      return { mode: 'ALL' };
    case 'LOCATION':
      if (!input.city && !input.state) {
        throw invalidInput('LOCATION target requires city and/or state');
      }
      return { mode: 'LOCATION', city: input.city ?? undefined, state: input.state ?? undefined };
    default:
      throw invalidInput('Unknown target mode');
  }
};

const parseMetadataJson = (raw?: string | null): Record<string, unknown> | undefined => {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalidInput(`metadataJson is not valid JSON: ${(error as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidInput('metadataJson is not valid JSON: metadataJson must encode a JSON object');
  }

  return parsed as Record<string, unknown>;
};

/**
 * Check a broadcast before anything is counted or sent: its text, target,
 * metadata, and the roles the caller can reach
 */
export const prepareBroadcast = (input: BroadcastInput, allowedRoles: string[]) => {
  const { title, message } = validateBroadcastText(input.title, input.message);
  const target = buildBroadcastTarget(input.target);
  const metadata = parseMetadataJson(input.metadataJson);

  if (target.mode === 'ROLE') {
    assertTargetRoles(target.roles, allowedRoles);
  }

  return { title, message, target, metadata };
};

/**
 * Check an announcement before anything is counted or sent. Without
 * targetRoles, it goes to every role the caller can reach.
 */
const prepareAnnouncement = (input: AnnouncementInput, allowedRoles: string[]) => {
  const { title, message } = validateBroadcastText(input.title, input.message);
  const roles = input.targetRoles && input.targetRoles.length > 0 ? input.targetRoles : allowedRoles;

  assertTargetRoles(roles, allowedRoles);

  return { title, message, roles };
};

/**
 * Count a broadcast or announcement against the admin's daily cap, shared by
 * adminBroadcastNotification, superAdminBroadcastNotification and
 * sendSystemAnnouncement
 */
export const consumeBroadcastQuota = async (adminId: string) => {
  const { rateLimit } = await import('@/lib/redis');
  const result = await rateLimit.check(
    `broadcast:${adminId}`,
    BROADCAST_DAILY_LIMIT,
    BROADCAST_WINDOW_SECONDS
  );

  if (!result.allowed) {
    throw new GraphQLError(
      `Broadcast rate limit reached (${BROADCAST_DAILY_LIMIT}/day). Resets in ${result.resetIn}s.`,
      { extensions: { code: 'RATE_LIMITED' } }
    );
  }
};

/**
 * Resolve a BroadcastTarget into the concrete list of user IDs that should
 * receive the notification. Active, unbanned accounts only, so banned and
 * deactivated accounts can't be spammed.
 *
 * `allowedRoles` is the set of roles the *caller* is permitted to target.
 * Used by admin endpoints to prevent ADMIN from messaging SUPER_ADMIN, etc.
 */
const resolveTargetUserIds = async (
  target: BroadcastTarget,
  allowedRoles: string[]
): Promise<string[]> => {
  const now = new Date();

  if (target.mode === 'USER_IDS') {
    if (target.userIds.length === 0) {
      throw invalidInput('At least one userId is required');
    }
    // Restrict to users in allowed roles + ACTIVE status
    const users = await prisma.user.findMany({
      where: {
        id: { in: target.userIds },
        status: 'ACTIVE',
        role: { in: allowedRoles as $Enums.UserRole[] },
        ...notBanned(now),
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  if (target.mode === 'ROLE') {
    // Caller asked for specific roles — must all be in allowedRoles.
    const disallowed = target.roles.filter((r) => !allowedRoles.includes(r));
    if (disallowed.length > 0) {
      throw new GraphQLError(
        `You are not authorised to broadcast to role(s): ${disallowed.join(', ')}`,
        { extensions: { code: 'FORBIDDEN' } }
      );
    }
    const users = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        role: { in: target.roles as $Enums.UserRole[] },
        ...notBanned(now),
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  if (target.mode === 'ALL') {
    const users = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        role: { in: allowedRoles as $Enums.UserRole[] },
        ...notBanned(now),
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  // LOCATION — at least one of city/state must be set; matched against the
  // provider profile (since only providers have geo on file).
  if (!target.city && !target.state) {
    throw invalidInput('Location target requires city and/or state');
  }
  const locationWhere: Prisma.ServiceProviderWhereInput = {};
  if (target.city) locationWhere.city = { equals: target.city, mode: 'insensitive' };
  if (target.state) locationWhere.state = { equals: target.state, mode: 'insensitive' };
  const providers = await prisma.serviceProvider.findMany({
    where: {
      ...locationWhere,
      user: {
        status: 'ACTIVE',
        role: { in: allowedRoles as $Enums.UserRole[] },
        ...notBanned(now),
      },
    },
    select: { userId: true },
  });
  return providers.map((p) => p.userId);
};

/**
 * Broadcast a notification to the resolved recipients across all three
 * channels: in-app notification, notification:new on the socket, and push.
 *
 * Push always goes to the resolved recipients (never OneSignal's "All"
 * segment), so banned/deactivated users and anyone who turned push off are
 * left out. sendPushToUsers batches large recipient lists.
 */
export const broadcastNotification = async (params: {
  title: string;
  message: string;
  target: BroadcastTarget;
  allowedRoles: string[];
  /** Custom notification type — defaults to SYSTEM_ANNOUNCEMENT */
  type?: string;
  /** Optional metadata persisted on the in-app row + carried in push data */
  metadata?: Record<string, unknown>;
}): Promise<BroadcastResult> => {
  const { title, message, target, allowedRoles, type, metadata } = params;
  const notifType = type ?? NotificationType.SYSTEM_ANNOUNCEMENT;

  const recipientIds = await resolveTargetUserIds(target, allowedRoles);

  if (recipientIds.length === 0) {
    return {
      recipientCount: 0,
      inAppCreated: 0,
      pushDelivery: 'no_recipients',
    };
  }

  // 1. In-app notifications (bulk insert). Each is also sent to its
  // recipient's socket as notification:new; only online users see that.
  let inAppCreated = 0;
  let notificationIds: Record<string, string> = {};
  try {
    const result = await createBulkNotifications(
      recipientIds,
      notifType,
      title,
      message,
      'broadcast',
      undefined,
      metadata
    );
    inAppCreated = result.count;
    notificationIds = result.notificationIds ?? {};
  } catch (err) {
    console.error('Broadcast: failed to write in-app notifications', err);
  }

  // 2. Push (OneSignal) to the resolved recipients. `type` goes last so a
  // `type` key in the metadata can't replace it.
  let pushDelivery: BroadcastResult['pushDelivery'] = 'sent';
  let pushError: string | undefined;
  try {
    const result = await sendPushToUsers(recipientIds, {
      title,
      message,
      data: { ...(metadata ?? {}), type: notifType },
      notificationIds,
    });
    if (!result.success) {
      // Nobody had a device OneSignal could reach: not a failure of the send
      pushDelivery = result.noRecipients ? 'no_recipients' : 'failed';
      pushError = result.errors?.join('; ');
    }
  } catch (err) {
    pushDelivery = 'failed';
    pushError = (err as Error).message;
  }

  return {
    recipientCount: recipientIds.length,
    inAppCreated,
    pushDelivery,
    pushError,
  };
};

/**
 * The broadcast mutations: check the input, count against the admin's daily
 * cap, then send
 */
export const sendAdminBroadcast = async (
  adminId: string,
  input: BroadcastInput,
  allowedRoles: string[]
) => {
  const broadcast = prepareBroadcast(input, allowedRoles);
  await consumeBroadcastQuota(adminId);
  return broadcastNotification({ ...broadcast, allowedRoles });
};

/**
 * Send a system announcement: an in-app notification (and notification:new)
 * for every active, unbanned account with one of the target roles. Without
 * targetRoles, every role in allowedRoles, which defaults to customers and
 * providers.
 */
export const sendSystemAnnouncement = async (
  title: string,
  message: string,
  targetRoles?: string[],
  options: { allowedRoles?: string[] } = {}
) => {
  const allowedRoles = options.allowedRoles ?? announcementRolesFor(UserRole.ADMIN);
  const announcement = prepareAnnouncement({ title, message, targetRoles }, allowedRoles);

  const users = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      role: { in: announcement.roles as $Enums.UserRole[] },
      ...notBanned(),
    },
    select: { id: true },
  });

  return createBulkNotifications(
    users.map((u) => u.id),
    NotificationType.SYSTEM_ANNOUNCEMENT,
    announcement.title,
    announcement.message
  );
};

/**
 * The sendSystemAnnouncement mutation: the same checks, role rules and shared
 * daily cap as the broadcast mutations
 */
export const sendAdminAnnouncement = async (
  adminId: string,
  adminRole: string,
  input: AnnouncementInput
) => {
  const allowedRoles = announcementRolesFor(adminRole);
  const announcement = prepareAnnouncement(input, allowedRoles);
  await consumeBroadcastQuota(adminId);
  return sendSystemAnnouncement(announcement.title, announcement.message, announcement.roles, {
    allowedRoles,
  });
};
