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
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { NotificationType } from '@/constants';

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
  metadata?: Record<string, any>;
}

interface PaginationParams {
  page?: number;
  limit?: number;
}

interface NotificationFilters {
  type?: string;
  isRead?: boolean;
}

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
      type: type as any,
      title,
      message,
      entityType,
      entityId,
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
  });

  return notification;
};

/**
 * Create notifications for multiple users
 */
export const createBulkNotifications = async (
  userIds: string[],
  type: string,
  title: string,
  message: string,
  entityType?: string,
  entityId?: string,
  metadata?: Record<string, any>
) => {
  const notifications = await prisma.notification.createMany({
    data: userIds.map((userId) => ({
      userId,
      type: type as any,
      title,
      message,
      entityType,
      entityId,
      metadata: metadata ? JSON.stringify(metadata) : null,
    })),
  });

  return notifications;
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

  const whereClause: any = {
    userId,
  };

  if (type) {
    whereClause.type = type;
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
    byType: byType.reduce((acc, item) => {
      acc[item.type] = item._count;
      return acc;
    }, {} as Record<string, number>),
  };
};

// ==================
// Helper Functions for Creating Specific Notifications
// ==================

/**
 * Notify about booking creation
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
 * Notify about new review
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
 * Notify about provider verification
 */
export const notifyVerificationApproved = async (userId: string) => {
  return createNotification({
    userId,
    type: NotificationType.VERIFICATION_APPROVED,
    title: 'Verification Approved',
    message: 'Congratulations! Your provider profile has been verified.',
    entityType: 'provider',
  });
};

/**
 * Notify about provider verification rejection
 */
export const notifyVerificationRejected = async (userId: string, reason: string) => {
  return createNotification({
    userId,
    type: NotificationType.VERIFICATION_REJECTED,
    title: 'Verification Rejected',
    message: `Your verification was rejected: ${reason}`,
    entityType: 'provider',
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

/**
 * Send system announcement to all users
 */
export const sendSystemAnnouncement = async (
  title: string,
  message: string,
  targetRoles?: string[]
) => {
  const whereClause: any = {
    status: 'ACTIVE',
  };

  if (targetRoles && targetRoles.length > 0) {
    whereClause.role = { in: targetRoles };
  }

  const users = await prisma.user.findMany({
    where: whereClause,
    select: { id: true },
  });

  const userIds = users.map((u) => u.id);

  return createBulkNotifications(
    userIds,
    NotificationType.SYSTEM_ANNOUNCEMENT,
    title,
    message
  );
};

// ==========================================
// Admin Broadcast
// ==========================================

import { GraphQLError as GqlError } from 'graphql';
import { emitToUser } from '@/lib/socket';
import { sendPushToUsers, sendPushToAll } from '@/services/push.service';

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

/**
 * Resolve a BroadcastTarget into the concrete list of user IDs that should
 * receive the notification. ACTIVE users only — banned/deactivated accounts
 * are excluded so they can't be spammed.
 *
 * `allowedRoles` is the set of roles the *caller* is permitted to target.
 * Used by admin endpoints to prevent ADMIN from messaging SUPER_ADMIN, etc.
 */
const resolveTargetUserIds = async (
  target: BroadcastTarget,
  allowedRoles: string[]
): Promise<string[]> => {
  if (target.mode === 'USER_IDS') {
    if (target.userIds.length === 0) {
      throw new GqlError('At least one userId is required', {
        extensions: { code: 'INVALID_INPUT' },
      });
    }
    // Restrict to users in allowed roles + ACTIVE status
    const users = await prisma.user.findMany({
      where: {
        id: { in: target.userIds },
        status: 'ACTIVE',
        role: { in: allowedRoles as any[] },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  if (target.mode === 'ROLE') {
    // Caller asked for specific roles — must all be in allowedRoles.
    const disallowed = target.roles.filter((r) => !allowedRoles.includes(r));
    if (disallowed.length > 0) {
      throw new GqlError(
        `You are not authorised to broadcast to role(s): ${disallowed.join(', ')}`,
        { extensions: { code: 'FORBIDDEN' } }
      );
    }
    const users = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        role: { in: target.roles as any[] },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  if (target.mode === 'ALL') {
    const users = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        role: { in: allowedRoles as any[] },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  // LOCATION — at least one of city/state must be set; matched against the
  // provider profile (since only providers have geo on file).
  if (!target.city && !target.state) {
    throw new GqlError('Location target requires city and/or state', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }
  const locationWhere: any = {};
  if (target.city) locationWhere.city = { equals: target.city, mode: 'insensitive' };
  if (target.state) locationWhere.state = { equals: target.state, mode: 'insensitive' };
  const providers = await prisma.serviceProvider.findMany({
    where: {
      ...locationWhere,
      user: { status: 'ACTIVE', role: { in: allowedRoles as any[] } },
    },
    select: { userId: true },
  });
  return providers.map((p) => p.userId);
};

/**
 * Broadcast a notification to the resolved recipients across all three
 * channels: in-app row, socket event, push.
 *
 * For very large recipient sets ("ALL" mode), the push step falls through
 * to OneSignal's broadcast segment so we don't have to pass tens of
 * thousands of player IDs in a single HTTP body.
 */
export const broadcastNotification = async (params: {
  title: string;
  message: string;
  target: BroadcastTarget;
  allowedRoles: string[];
  /** Custom notification type — defaults to SYSTEM_ANNOUNCEMENT */
  type?: string;
  /** Optional metadata persisted on the in-app row + carried in push data */
  metadata?: Record<string, any>;
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

  // 1. In-app rows (bulk insert)
  let inAppCreated = 0;
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
    inAppCreated = (result as { count?: number }).count ?? recipientIds.length;
  } catch (err) {
    console.error('Broadcast: failed to write in-app notifications', err);
  }

  // 2. Socket event (best-effort — only online users will see it)
  const socketEvent = `notification:new`;
  const socketPayload = { type: notifType, title, message, metadata };
  await Promise.all(
    recipientIds.map((uid) =>
      emitToUser(uid, socketEvent, socketPayload).catch((err) =>
        console.error('Broadcast: socket emit failed for', uid, err)
      )
    )
  );

  // 3. Push (OneSignal). For ALL mode with no role restriction we use the
  // segment broadcast endpoint; otherwise we send by the resolved IDs.
  let pushDelivery: BroadcastResult['pushDelivery'] = 'sent';
  let pushError: string | undefined;
  try {
    const pushOptions = {
      title,
      message,
      data: { type: notifType, ...(metadata ?? {}) },
    };
    const result =
      target.mode === 'ALL' && allowedRoles.length >= 3 // SU + SP + ADMIN
        ? await sendPushToAll(pushOptions)
        : await sendPushToUsers(recipientIds, pushOptions);
    if (!result.success) {
      pushDelivery = 'failed';
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
