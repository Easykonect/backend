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
