/**
 * Payout Service
 * 
 * Handles scheduled payouts for providers.
 * 
 * Features:
 * - Set payout schedule preferences
 * - Process scheduled payouts
 * - Batch multiple payments into single transfer
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { PayoutFrequency } from '@prisma/client';
import { requestWithdrawal } from './withdrawal.service';
import { getDefaultBankAccount } from './bank.service';
import { koboToNaira } from './wallet.service';

// ==========================================
// Types
// ==========================================

interface SetPayoutScheduleInput {
  frequency: PayoutFrequency;
  dayOfWeek?: number; // 0-6 for WEEKLY
  dayOfMonth?: number; // 1-28 for MONTHLY
  minimumAmount?: number; // In Naira
  bankAccountId?: string;
}

interface PaginationInput {
  page: number;
  limit: number;
}

// ==========================================
// Constants
// ==========================================

const DEFAULT_MINIMUM_AMOUNT_KOBO = 500000; // ₦5,000

// ==========================================
// Helper Functions
// ==========================================

/**
 * Format payout schedule for response
 */
const formatPayoutSchedule = (schedule: any) => ({
  id: schedule.id,
  providerId: schedule.providerId,
  frequency: schedule.frequency,
  dayOfWeek: schedule.dayOfWeek,
  dayOfMonth: schedule.dayOfMonth,
  minimumAmount: koboToNaira(schedule.minimumAmount),
  minimumAmountKobo: schedule.minimumAmount,
  timezone: schedule.timezone,
  isActive: schedule.isActive,
  bankAccountId: schedule.bankAccountId,
  createdAt: schedule.createdAt.toISOString(),
  updatedAt: schedule.updatedAt.toISOString(),
});

/**
 * Format scheduled payout for response
 */
const formatScheduledPayout = (payout: any) => ({
  id: payout.id,
  providerId: payout.providerId,
  amount: koboToNaira(payout.amount),
  amountKobo: payout.amount,
  paymentIds: payout.paymentIds,
  scheduledFor: payout.scheduledFor.toISOString(),
  status: payout.status,
  withdrawalId: payout.withdrawalId,
  processedAt: payout.processedAt?.toISOString() || null,
  failureReason: payout.failureReason,
  createdAt: payout.createdAt.toISOString(),
  updatedAt: payout.updatedAt.toISOString(),
});

/**
 * Check if today matches the schedule
 */
const shouldProcessToday = (
  schedule: any,
  localDate: Date
): boolean => {
  const dayOfWeek = localDate.getDay();
  const dayOfMonth = localDate.getDate();

  switch (schedule.frequency) {
    case 'DAILY':
      return true;
    case 'WEEKLY':
      return dayOfWeek === schedule.dayOfWeek;
    case 'BIWEEKLY':
      // Process on dayOfWeek, every 2 weeks (odd weeks of the month)
      const weekOfMonth = Math.ceil(dayOfMonth / 7);
      return dayOfWeek === schedule.dayOfWeek && weekOfMonth % 2 === 1;
    case 'MONTHLY':
      return dayOfMonth === schedule.dayOfMonth;
    case 'MANUAL':
      return false;
    default:
      return false;
  }
};

// ==========================================
// Payout Schedule Management
// ==========================================

/**
 * Get provider's payout schedule
 */
export const getPayoutSchedule = async (providerId: string) => {
  const schedule = await prisma.payoutSchedule.findUnique({
    where: { providerId },
  });

  if (!schedule) {
    return null;
  }

  return formatPayoutSchedule(schedule);
};

/**
 * Set or update provider's payout schedule
 */
export const setPayoutSchedule = async (
  providerId: string,
  userId: string,
  input: SetPayoutScheduleInput
) => {
  const { frequency, dayOfWeek, dayOfMonth, minimumAmount, bankAccountId } = input;

  // Validate dayOfWeek for WEEKLY
  if (frequency === 'WEEKLY' && (dayOfWeek === undefined || dayOfWeek < 0 || dayOfWeek > 6)) {
    throw new GraphQLError('Day of week must be 0-6 for weekly payouts', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  // Validate dayOfMonth for MONTHLY
  if (frequency === 'MONTHLY' && (!dayOfMonth || dayOfMonth < 1 || dayOfMonth > 28)) {
    throw new GraphQLError('Day of month must be 1-28 for monthly payouts', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  // Validate bank account if provided
  if (bankAccountId) {
    const bankAccount = await prisma.providerBankAccount.findFirst({
      where: { id: bankAccountId, providerId },
    });

    if (!bankAccount) {
      throw new GraphQLError('Bank account not found', {
        extensions: { code: 'BANK_ACCOUNT_NOT_FOUND' },
      });
    }
  }

  // Get user's timezone from settings
  const userSettings = await prisma.userSettings.findUnique({
    where: { userId },
  });
  const timezone = userSettings?.timezone || 'Africa/Lagos';

  // Convert minimumAmount from naira to kobo
  const minimumAmountKobo = minimumAmount 
    ? Math.round(minimumAmount * 100) 
    : DEFAULT_MINIMUM_AMOUNT_KOBO;

  // Upsert schedule
  const schedule = await prisma.payoutSchedule.upsert({
    where: { providerId },
    create: {
      providerId,
      frequency,
      dayOfWeek: frequency === 'WEEKLY' || frequency === 'BIWEEKLY' ? dayOfWeek : null,
      dayOfMonth: frequency === 'MONTHLY' ? dayOfMonth : null,
      minimumAmount: minimumAmountKobo,
      timezone,
      bankAccountId,
      isActive: true,
    },
    update: {
      frequency,
      dayOfWeek: frequency === 'WEEKLY' || frequency === 'BIWEEKLY' ? dayOfWeek : null,
      dayOfMonth: frequency === 'MONTHLY' ? dayOfMonth : null,
      minimumAmount: minimumAmountKobo,
      timezone,
      bankAccountId,
      isActive: true,
    },
  });

  return formatPayoutSchedule(schedule);
};

/**
 * Pause payout schedule
 */
export const pausePayoutSchedule = async (providerId: string) => {
  const schedule = await prisma.payoutSchedule.findUnique({
    where: { providerId },
  });

  if (!schedule) {
    throw new GraphQLError('Payout schedule not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  await prisma.payoutSchedule.update({
    where: { providerId },
    data: { isActive: false },
  });

  return {
    success: true,
    message: 'Payout schedule paused',
  };
};

/**
 * Resume payout schedule
 */
export const resumePayoutSchedule = async (providerId: string) => {
  const schedule = await prisma.payoutSchedule.findUnique({
    where: { providerId },
  });

  if (!schedule) {
    throw new GraphQLError('Payout schedule not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Verify bank account is still valid
  if (schedule.bankAccountId) {
    const bankAccount = await prisma.providerBankAccount.findFirst({
      where: { id: schedule.bankAccountId, providerId },
    });

    if (!bankAccount) {
      throw new GraphQLError('Bank account no longer exists. Please update your payout settings.', {
        extensions: { code: 'BANK_ACCOUNT_INVALID' },
      });
    }
  }

  await prisma.payoutSchedule.update({
    where: { providerId },
    data: { isActive: true },
  });

  return {
    success: true,
    message: 'Payout schedule resumed',
  };
};

// ==========================================
// Pending Earnings
// ==========================================

/**
 * Get provider's pending earnings (withdrawable)
 */
export const getProviderPendingEarnings = async (providerId: string) => {
  const now = new Date();

  // Get completed payments that have passed the dispute window
  const withdrawablePayments = await prisma.payment.findMany({
    where: {
      booking: { providerId },
      status: 'COMPLETED',
      walletTransactionId: null, // Not yet credited to wallet
      withdrawableAt: { lte: now }, // Past dispute window
    },
    select: {
      id: true,
      providerPayout: true,
    },
  });

  // Get payments still in dispute window
  const pendingPayments = await prisma.payment.findMany({
    where: {
      booking: { providerId },
      status: 'COMPLETED',
      walletTransactionId: null,
      OR: [
        { withdrawableAt: null },
        { withdrawableAt: { gt: now } },
      ],
    },
    select: {
      id: true,
      providerPayout: true,
      withdrawableAt: true,
    },
  });

  const withdrawableAmount = withdrawablePayments.reduce((sum, p) => sum + p.providerPayout, 0);
  const pendingAmount = pendingPayments.reduce((sum, p) => sum + p.providerPayout, 0);

  return {
    withdrawableAmount,
    pendingAmount,
    totalPendingEarnings: withdrawableAmount + pendingAmount,
    withdrawablePaymentIds: withdrawablePayments.map((p) => p.id),
    pendingPayments: pendingPayments.map((p) => ({
      id: p.id,
      amount: p.providerPayout,
      withdrawableAt: p.withdrawableAt?.toISOString() || null,
    })),
  };
};

// ==========================================
// Scheduled Payout Processing
// ==========================================

/**
 * Process scheduled payouts for all providers
 * This should be called by a cron job daily
 */
export const processScheduledPayouts = async () => {
  const schedules = await prisma.payoutSchedule.findMany({
    where: {
      isActive: true,
      frequency: { not: 'MANUAL' },
    },
    include: {
      provider: {
        include: {
          user: true,
        },
      },
    },
  });

  const results: { providerId: string; success: boolean; message: string }[] = [];

  for (const schedule of schedules) {
    try {
      // Get local time for the provider's timezone
      const now = new Date();
      const localDate = new Date(now.toLocaleString('en-US', { timeZone: schedule.timezone }));

      if (!shouldProcessToday(schedule, localDate)) {
        continue;
      }

      // Get pending earnings
      const earnings = await getProviderPendingEarnings(schedule.providerId);

      // Check minimum amount
      const earningsKobo = Math.round(earnings.withdrawableAmount * 100);
      if (earningsKobo < schedule.minimumAmount) {
        results.push({
          providerId: schedule.providerId,
          success: false,
          message: `Below minimum amount (${koboToNaira(earningsKobo)} < ${koboToNaira(schedule.minimumAmount)})`,
        });
        continue;
      }

      // Get bank account
      let bankAccountId = schedule.bankAccountId;
      if (!bankAccountId) {
        const defaultAccount = await getDefaultBankAccount(schedule.providerId);
        if (!defaultAccount) {
          results.push({
            providerId: schedule.providerId,
            success: false,
            message: 'No bank account available',
          });
          continue;
        }
        bankAccountId = defaultAccount.id;
      }

      // Create scheduled payout record
      const scheduledPayout = await prisma.scheduledPayout.create({
        data: {
          providerId: schedule.providerId,
          amount: earningsKobo,
          paymentIds: earnings.withdrawablePaymentIds,
          scheduledFor: now,
          status: 'PENDING',
        },
      });

      // Skip if no bank account ID
      if (!bankAccountId) {
        await prisma.scheduledPayout.update({
          where: { id: scheduledPayout.id },
          data: {
            status: 'FAILED',
            failureReason: 'No bank account configured for payout',
          },
        });
        results.push({
          providerId: schedule.providerId,
          success: false,
          message: 'No bank account configured',
        });
        continue;
      }

      // Request withdrawal
      try {
        const withdrawal = await requestWithdrawal(
          schedule.providerId,
          schedule.provider.userId,
          {
            amount: earnings.withdrawableAmount,
            bankAccountId,
          }
        );

        // Update scheduled payout with withdrawal ID
        await prisma.scheduledPayout.update({
          where: { id: scheduledPayout.id },
          data: {
            status: 'PROCESSING',
            withdrawalId: withdrawal.id,
          },
        });

        results.push({
          providerId: schedule.providerId,
          success: true,
          message: `Withdrawal of ₦${earnings.withdrawableAmount} initiated`,
        });
      } catch (error: any) {
        await prisma.scheduledPayout.update({
          where: { id: scheduledPayout.id },
          data: {
            status: 'FAILED',
            failureReason: error.message,
          },
        });

        results.push({
          providerId: schedule.providerId,
          success: false,
          message: error.message,
        });
      }
    } catch (error: any) {
      results.push({
        providerId: schedule.providerId,
        success: false,
        message: error.message,
      });
    }
  }

  return {
    processed: results.length,
    successful: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
};

/**
 * Get scheduled payout history for provider
 */
export const getScheduledPayoutHistory = async (
  providerId: string,
  pagination: PaginationInput
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const [payouts, total] = await Promise.all([
    prisma.scheduledPayout.findMany({
      where: { providerId },
      orderBy: { scheduledFor: 'desc' },
      skip,
      take: limit,
    }),
    prisma.scheduledPayout.count({ where: { providerId } }),
  ]);

  return {
    payouts: payouts.map(formatScheduledPayout),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
};

/**
 * Get pending scheduled payouts (admin)
 */
export const getPendingScheduledPayouts = async (pagination: PaginationInput) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const [payouts, total] = await Promise.all([
    prisma.scheduledPayout.findMany({
      where: { status: 'PENDING' },
      orderBy: { scheduledFor: 'asc' },
      skip,
      take: limit,
    }),
    prisma.scheduledPayout.count({ where: { status: 'PENDING' } }),
  ]);

  return {
    payouts: payouts.map(formatScheduledPayout),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
};
