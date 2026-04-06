/**
 * Background Jobs Worker
 * 
 * Processes background jobs like:
 * - Cleanup old notifications
 * - Cleanup old messages
 * - Send daily digest emails
 * - Generate analytics snapshots
 */

import { Job } from 'bullmq';
import { queueManager, QUEUE_NAMES, BackgroundJobData } from './index';
import prisma from '@/lib/prisma';

// ===========================================
// Job Processors
// ===========================================

/**
 * Clean up old read notifications (older than 30 days)
 */
async function cleanupOldNotifications(): Promise<{ deleted: number }> {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const result = await prisma.notification.deleteMany({
    where: {
      isRead: true,
      createdAt: { lt: thirtyDaysAgo },
    },
  });

  console.log(`🧹 Cleaned up ${result.count} old notifications`);
  return { deleted: result.count };
}

/**
 * Clean up soft-deleted messages (older than 7 days)
 */
async function cleanupOldMessages(): Promise<{ deleted: number }> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const result = await prisma.message.deleteMany({
    where: {
      isDeleted: true,
      deletedAt: { lt: sevenDaysAgo },
    },
  });

  console.log(`🧹 Cleaned up ${result.count} old deleted messages`);
  return { deleted: result.count };
}

/**
 * Send daily digest emails to users
 * (Summary of unread notifications, new bookings, etc.)
 */
async function sendDailyDigest(): Promise<{ sent: number }> {
  // Get users with unread notifications
  const usersWithNotifications = await prisma.notification.groupBy({
    by: ['userId'],
    where: {
      isRead: false,
      createdAt: {
        gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
      },
    },
    _count: { id: true },
  });

  let sentCount = 0;

  for (const user of usersWithNotifications) {
    // Get user details
    const userData = await prisma.user.findUnique({
      where: { id: user.userId },
      select: { email: true, firstName: true },
    });

    if (userData && user._count.id > 0) {
      // Queue digest email
      const { queueEmail } = await import('./index');
      await queueEmail({
        to: userData.email,
        subject: `Your EasyKonnect Daily Summary`,
        template: 'dailyDigest',
        templateData: {
          name: userData.firstName,
          unreadCount: user._count.id,
        },
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #4F46E5;">Your Daily Summary</h1>
            <p>Hi ${userData.firstName},</p>
            <p>You have <strong>${user._count.id}</strong> unread notifications.</p>
            <p>Log in to EasyKonnect to stay updated!</p>
            <p>Best regards,<br>The EasyKonnect Team</p>
          </div>
        `,
      });
      sentCount++;
    }
  }

  console.log(`📧 Sent ${sentCount} daily digest emails`);
  return { sent: sentCount };
}

/**
 * Generate analytics snapshot
 * (Store current stats for historical tracking)
 */
async function generateAnalyticsSnapshot(): Promise<Record<string, number>> {
  const [
    totalUsers,
    totalProviders,
    totalBookings,
    todayBookings,
    totalServices,
    activeConversations,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'SERVICE_USER' } }),
    prisma.user.count({ where: { role: 'SERVICE_PROVIDER' } }),
    prisma.booking.count(),
    prisma.booking.count({
      where: {
        createdAt: {
          gte: new Date(new Date().setHours(0, 0, 0, 0)),
        },
      },
    }),
    prisma.service.count({ where: { status: 'ACTIVE' } }),
    prisma.conversation.count({ where: { isActive: true } }),
  ]);

  const snapshot = {
    totalUsers,
    totalProviders,
    totalBookings,
    todayBookings,
    totalServices,
    activeConversations,
    timestamp: Date.now(),
  };

  console.log('📊 Analytics snapshot:', snapshot);
  
  // In a real app, you might store this in a separate analytics table
  // or send to an analytics service

  return snapshot;
}

// ===========================================
// Background Job Processor
// ===========================================
async function processBackgroundJob(job: Job<BackgroundJobData>): Promise<void> {
  const { jobType, data } = job.data;

  console.log(`⚙️ Processing background job ${job.id}: ${jobType}`);

  switch (jobType) {
    case 'CLEANUP_OLD_NOTIFICATIONS':
      await cleanupOldNotifications();
      break;

    case 'CLEANUP_OLD_MESSAGES':
      await cleanupOldMessages();
      break;

    case 'SEND_DAILY_DIGEST':
      await sendDailyDigest();
      break;

    case 'ANALYTICS_SNAPSHOT':
      await generateAnalyticsSnapshot();
      break;

    case 'UNLOCK_STALE_WALLETS':
      await unlockStaleWallets();
      break;

    default:
      console.warn(`Unknown background job type: ${jobType}`);
  }

  console.log(`✅ Background job ${job.id} completed`);
}

/**
 * Unlock stale wallet locks (locks older than 1 hour)
 * Security measure to prevent wallets being locked indefinitely
 */
async function unlockStaleWallets(): Promise<{ unlocked: number }> {
  const { unlockStaleWallets: unlockWallets } = await import('@/services/wallet.service');
  const count = await unlockWallets();
  console.log(`🔓 Unlocked ${count} stale wallet locks`);
  return { unlocked: count };
}

// ===========================================
// Initialize Background Worker
// ===========================================
export function initializeBackgroundWorker(): void {
  queueManager.registerWorker<BackgroundJobData>(
    QUEUE_NAMES.BACKGROUND,
    processBackgroundJob,
    2 // Process 2 background jobs concurrently
  );

  console.log('✅ Background worker initialized');
}

// ===========================================
// Schedule Recurring Jobs
// ===========================================
export async function scheduleRecurringJobs(): Promise<void> {
  const { queueManager: manager } = await import('./index');

  // Clean up old notifications daily at 2 AM
  await manager.addScheduledJob<BackgroundJobData>(
    QUEUE_NAMES.BACKGROUND,
    { jobType: 'CLEANUP_OLD_NOTIFICATIONS' },
    '0 2 * * *', // Every day at 2 AM
    'cleanup-notifications'
  );

  // Clean up old messages daily at 3 AM
  await manager.addScheduledJob<BackgroundJobData>(
    QUEUE_NAMES.BACKGROUND,
    { jobType: 'CLEANUP_OLD_MESSAGES' },
    '0 3 * * *', // Every day at 3 AM
    'cleanup-messages'
  );

  // Send daily digest at 8 AM
  await manager.addScheduledJob<BackgroundJobData>(
    QUEUE_NAMES.BACKGROUND,
    { jobType: 'SEND_DAILY_DIGEST' },
    '0 8 * * *', // Every day at 8 AM
    'daily-digest'
  );

  // Generate analytics snapshot every hour
  await manager.addScheduledJob<BackgroundJobData>(
    QUEUE_NAMES.BACKGROUND,
    { jobType: 'ANALYTICS_SNAPSHOT' },
    '0 * * * *', // Every hour
    'analytics-snapshot'
  );

  // Unlock stale wallet locks every 15 minutes
  await manager.addScheduledJob<BackgroundJobData>(
    QUEUE_NAMES.BACKGROUND,
    { jobType: 'UNLOCK_STALE_WALLETS' },
    '*/15 * * * *', // Every 15 minutes
    'unlock-stale-wallets'
  );

  console.log('📅 Recurring background jobs scheduled');
}

export default initializeBackgroundWorker;