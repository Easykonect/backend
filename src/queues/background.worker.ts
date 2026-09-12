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
import { PAYOUT_JOB_TIMEZONE, SCHEDULED_PAYOUT_HOUR } from '@/constants';

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
 * Clean up soft-deleted messages (older than 7 days). Conversations that were
 * reported keep theirs, as evidence for moderators.
 */
async function cleanupOldMessages(): Promise<{ deleted: number }> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const reports = await prisma.report.findMany({
    where: { targetType: { in: ['MESSAGE', 'CONVERSATION'] } },
    select: { targetType: true, targetId: true },
  });

  const reportedMessageIds = reports
    .filter((report) => report.targetType === 'MESSAGE')
    .map((report) => report.targetId);
  const reportedMessages =
    reportedMessageIds.length > 0
      ? await prisma.message.findMany({
          where: { id: { in: reportedMessageIds } },
          select: { conversationId: true },
        })
      : [];

  const keptConversationIds = [
    ...new Set([
      ...reports.filter((report) => report.targetType === 'CONVERSATION').map((report) => report.targetId),
      ...reportedMessages.map((message) => message.conversationId),
    ]),
  ];

  const result = await prisma.message.deleteMany({
    where: {
      isDeleted: true,
      deletedAt: { lt: sevenDaysAgo },
      ...(keptConversationIds.length > 0 ? { conversationId: { notIn: keptConversationIds } } : {}),
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

/**
 * Process automatic payment releases
 * Releases payments to providers' wallets for completed bookings that are
 * past their release time: RELEASE_DELAY_HOURS after the customer confirmed,
 * or AUTO_RELEASE_DAYS after completion if they never did. Open disputes hold
 * the booking out of COMPLETED, so they're never released.
 */
async function processAutomaticPaymentReleases(): Promise<{ released: number; failed: number }> {
  const { findBookingsDueForRelease, releaseBookingPayment } = await import('@/services/escrow.service');
  const { createNotification } = await import('@/services/notification.service');

  let released = 0;
  let failed = 0;

  try {
    const bookingIds = await findBookingsDueForRelease();
    console.log(`💰 Found ${bookingIds.length} bookings ready for payment release`);

    for (const bookingId of bookingIds) {
      try {
        const release = await releaseBookingPayment(bookingId);

        // Released by an overlapping run, or no longer due
        if (!release) continue;

        released++;
        const amount = release.payoutKobo / 100;

        // The money has moved; notifications are best effort
        await Promise.allSettled([
          createNotification({
            userId: release.providerUserId,
            type: 'PAYMENT_RECEIVED',
            title: 'Payment Released! 💰',
            message: `₦${amount.toLocaleString()} has been released to your wallet for completing "${release.serviceName}".`,
            metadata: { bookingId, paymentId: release.paymentId, amount },
          }),
          createNotification({
            userId: release.customerUserId,
            type: 'BOOKING_COMPLETED',
            title: 'Payment Released to Provider',
            message: `Payment for "${release.serviceName}" has been released to the service provider. Thank you for using Easykonnet!`,
            metadata: { bookingId },
          }),
        ]);

        console.log(`✅ Released payment for booking ${bookingId}`);
      } catch (error) {
        console.error(`❌ Failed to release payment for booking ${bookingId}:`, (error as Error).message);
        failed++;
      }
    }
  } catch (error) {
    console.error('❌ Error processing automatic payment releases:', (error as Error).message);
  }

  console.log(`💰 Payment release complete: ${released} released, ${failed} failed`);
  return { released, failed };
}

// ===========================================
// Background Job Processor
// ===========================================
async function processBackgroundJob(job: Job<BackgroundJobData>): Promise<void> {
  const { jobType } = job.data;

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

    case 'PROCESS_AUTOMATIC_PAYMENT_RELEASES':
      await processAutomaticPaymentReleases();
      break;

    case 'RECONCILE_WITHDRAWALS':
      await reconcileWithdrawals();
      break;

    case 'PROCESS_SCHEDULED_PAYOUTS':
      await runScheduledPayouts();
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

/**
 * Settle withdrawals whose transfer result never arrived by webhook
 */
async function reconcileWithdrawals(): Promise<{ checked: number; settled: number }> {
  const { reconcileProcessingWithdrawals } = await import('@/services/withdrawal.service');
  const result = await reconcileProcessingWithdrawals();
  console.log(`🏦 Checked ${result.checked} processing withdrawals, settled ${result.settled}`);
  return result;
}

/**
 * Request withdrawals for providers whose payout schedule is due today
 */
async function runScheduledPayouts(): Promise<{ processed: number; successful: number }> {
  const { processScheduledPayouts } = await import('@/services/payout.service');
  const result = await processScheduledPayouts();
  console.log(`🗓️ Scheduled payouts: ${result.successful} requested, ${result.failed} skipped or failed`);
  return result;
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

  // Process automatic payment releases every 10 minutes
  await manager.addScheduledJob<BackgroundJobData>(
    QUEUE_NAMES.BACKGROUND,
    { jobType: 'PROCESS_AUTOMATIC_PAYMENT_RELEASES' },
    '*/10 * * * *', // Every 10 minutes
    'automatic-payment-releases'
  );

  // Check withdrawals Paystack hasn't reported on every 30 minutes
  await manager.addScheduledJob<BackgroundJobData>(
    QUEUE_NAMES.BACKGROUND,
    { jobType: 'RECONCILE_WITHDRAWALS' },
    '*/30 * * * *', // Every 30 minutes
    'reconcile-withdrawals'
  );

  // Request scheduled payouts once a day at 08:00 Lagos time, whatever the
  // server's time zone. The job id stays the same, so the earlier schedule
  // without a time zone is replaced.
  await manager.addScheduledJob<BackgroundJobData>(
    QUEUE_NAMES.BACKGROUND,
    { jobType: 'PROCESS_SCHEDULED_PAYOUTS' },
    `0 ${SCHEDULED_PAYOUT_HOUR} * * *`,
    'scheduled-payouts',
    { timezone: PAYOUT_JOB_TIMEZONE }
  );

  console.log('📅 Recurring background jobs scheduled');
}

export default initializeBackgroundWorker;