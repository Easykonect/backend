/**
 * Notification Queue Worker
 * 
 * Processes notification jobs from the queue
 * - Creates in-app notifications
 * - Sends real-time notifications via Socket.io
 * - Can be extended for push notifications
 */

import { Job } from 'bullmq';
import { queueManager, QUEUE_NAMES, NotificationJobData } from './index';
import { NotificationType } from '@prisma/client';
import prisma from '@/lib/prisma';
import { emitToUser } from '@/lib/socket';

// ===========================================
// Notification Type Mapping
// ===========================================
function mapToNotificationType(type: string): NotificationType {
  const typeMap: Record<string, NotificationType> = {
    BOOKING_CREATED: NotificationType.BOOKING_CREATED,
    BOOKING_ACCEPTED: NotificationType.BOOKING_ACCEPTED,
    BOOKING_REJECTED: NotificationType.BOOKING_REJECTED,
    BOOKING_CANCELLED: NotificationType.BOOKING_CANCELLED,
    BOOKING_STARTED: NotificationType.BOOKING_STARTED,
    BOOKING_COMPLETED: NotificationType.BOOKING_COMPLETED,
    PAYMENT_RECEIVED: NotificationType.PAYMENT_RECEIVED,
    PAYMENT_FAILED: NotificationType.PAYMENT_FAILED,
    REFUND_PROCESSED: NotificationType.REFUND_PROCESSED,
    REVIEW_RECEIVED: NotificationType.REVIEW_RECEIVED,
    REVIEW_RESPONSE: NotificationType.REVIEW_RESPONSE,
    VERIFICATION_APPROVED: NotificationType.VERIFICATION_APPROVED,
    VERIFICATION_REJECTED: NotificationType.VERIFICATION_REJECTED,
    SERVICE_APPROVED: NotificationType.SERVICE_APPROVED,
    SERVICE_REJECTED: NotificationType.SERVICE_REJECTED,
    SERVICE_SUSPENDED: NotificationType.SERVICE_SUSPENDED,
    DISPUTE_OPENED: NotificationType.DISPUTE_OPENED,
    DISPUTE_UPDATED: NotificationType.DISPUTE_UPDATED,
    DISPUTE_RESOLVED: NotificationType.DISPUTE_RESOLVED,
    NEW_MESSAGE: NotificationType.NEW_MESSAGE,
    ACCOUNT_SUSPENDED: NotificationType.ACCOUNT_SUSPENDED,
    ACCOUNT_ACTIVATED: NotificationType.ACCOUNT_ACTIVATED,
    SYSTEM_ANNOUNCEMENT: NotificationType.SYSTEM_ANNOUNCEMENT,
  };

  return typeMap[type] || NotificationType.SYSTEM_ANNOUNCEMENT;
}

// ===========================================
// Notification Processor
// ===========================================
async function processNotificationJob(job: Job<NotificationJobData>): Promise<void> {
  const { userId, type, title, message, entityType, entityId, metadata } = job.data;

  console.log(`🔔 Processing notification job ${job.id} for user ${userId}`);

  try {
    // Create notification in database
    const notification = await prisma.notification.create({
      data: {
        userId,
        type: mapToNotificationType(type),
        title,
        message,
        entityType,
        entityId,
        metadata: metadata ? JSON.stringify(metadata) : undefined,
      },
    });

    console.log(`✅ Notification created: ${notification.id}`);

    // Send real-time notification via Socket.io
    await emitToUser(userId, 'notification:new', {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      entityType: notification.entityType,
      entityId: notification.entityId,
      isRead: notification.isRead,
      createdAt: notification.createdAt,
    });

    console.log(`✅ Real-time notification sent to user ${userId}`);

    // Future: Add push notification logic here
    // if (job.data.sendPush) {
    //   await sendPushNotification(userId, title, message);
    // }

  } catch (error) {
    console.error(`❌ Failed to process notification:`, error);
    throw error;
  }
}

// ===========================================
// Initialize Notification Worker
// ===========================================
export function initializeNotificationWorker(): void {
  queueManager.registerWorker<NotificationJobData>(
    QUEUE_NAMES.NOTIFICATION,
    processNotificationJob,
    5 // Process 5 notifications concurrently
  );

  console.log('✅ Notification worker initialized');
}

// ===========================================
// Helper: Send notification to multiple users
// ===========================================
export async function sendBulkNotifications(
  userIds: string[],
  type: string,
  title: string,
  message: string,
  entityType?: string,
  entityId?: string
): Promise<void> {
  const { queueNotification } = await import('./index');

  for (const userId of userIds) {
    await queueNotification({
      userId,
      type,
      title,
      message,
      entityType,
      entityId,
    });
  }
}

// ===========================================
// Helper: Send notification to all admins
// ===========================================
export async function notifyAdmins(
  type: string,
  title: string,
  message: string,
  entityType?: string,
  entityId?: string
): Promise<void> {
  const admins = await prisma.user.findMany({
    where: {
      role: { in: ['ADMIN', 'SUPER_ADMIN'] },
      status: 'ACTIVE',
    },
    select: { id: true },
  });

  await sendBulkNotifications(
    admins.map(a => a.id),
    type,
    title,
    message,
    entityType,
    entityId
  );
}

export default initializeNotificationWorker;
