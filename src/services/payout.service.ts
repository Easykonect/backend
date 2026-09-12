/**
 * Payout Service
 *
 * Handles scheduled payouts for providers.
 *
 * Features:
 * - Set payout schedule preferences
 * - Request a withdrawal of the wallet balance on payout days
 * - Record the payout days the job skipped, and why
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import type { PayoutFrequency, PayoutSchedule, ScheduledPayout } from '@prisma/client';
import { NotificationType, PAYOUT_JOB_TIMEZONE, SCHEDULED_PAYOUT_HOUR } from '@/constants';
import { requestWithdrawal, MIN_WITHDRAWAL_NAIRA, TRANSFER_FEE_KOBO } from './withdrawal.service';
import { getDefaultBankAccount } from './bank.service';
import { HELD_IN_ESCROW, koboToNaira, MAX_SINGLE_TRANSACTION_KOBO } from './wallet.service';
import { createNotification } from './notification.service';

// ==========================================
// Types
// ==========================================

interface SetPayoutScheduleInput {
  frequency: PayoutFrequency;
  dayOfWeek?: number; // 0-6 for WEEKLY
  dayOfMonth?: number; // 1-28 for MONTHLY
  minimumAmount?: number | null; // In Naira
  bankAccountId?: string;
}

interface PaginationInput {
  page: number;
  limit: number;
}

/** Why the payout job skipped a provider on a payout day */
export type PayoutSkipReason = 'WALLET_LOCKED' | 'BELOW_MINIMUM' | 'NO_BANK_ACCOUNT';

type ScheduleWithProvider = PayoutSchedule & { provider: { userId: string } };

type ScheduleTiming = Pick<PayoutSchedule, 'frequency' | 'dayOfWeek' | 'dayOfMonth' | 'timezone' | 'isActive'>;

/** A calendar date in some time zone; weekday 0 is Sunday */
interface LocalDate {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

// ==========================================
// Constants
// ==========================================

const DEFAULT_MINIMUM_AMOUNT_KOBO = 500000; // ₦5,000

// A schedule's minimum has to be a payout that can actually be made
const MIN_PAYOUT_MINIMUM_KOBO = MIN_WITHDRAWAL_NAIRA * 100;
const MAX_PAYOUT_MINIMUM_KOBO = MAX_SINGLE_TRANSACTION_KOBO;

// A run repeated within this time (e.g. a retried job) doesn't pay out again
const PAYOUT_RUN_GAP_MS = 20 * 60 * 60 * 1000;

// Biweekly payouts count weeks from this Monday
const BIWEEKLY_EPOCH_MS = Date.UTC(2024, 0, 1);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Far enough ahead to reach any schedule's next payout day
const NEXT_PAYOUT_SEARCH_DAYS = 62;

// Skips the provider can do something about. A low balance is expected while
// earnings build up, so it's recorded without a notification.
const NOTIFIED_SKIP_REASONS = new Set<PayoutSkipReason>(['WALLET_LOCKED', 'NO_BANK_ACCOUNT']);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ==========================================
// Dates
// ==========================================

const isValidTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
};

/**
 * The schedule's time zone, or Lagos if the saved one isn't a valid zone
 */
const scheduleTimeZone = (timeZone: string | null | undefined): string =>
  timeZone && isValidTimeZone(timeZone) ? timeZone : PAYOUT_JOB_TIMEZONE;

const dateParts = (instant: Date, timeZone: string, options: Intl.DateTimeFormatOptions) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, ...options }).formatToParts(instant);
  return (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
};

/**
 * The calendar date at an instant in a time zone
 */
const localDateIn = (instant: Date, timeZone: string): LocalDate => {
  const part = dateParts(instant, timeZone, { year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' });

  return {
    year: Number(part('year')),
    month: Number(part('month')),
    day: Number(part('day')),
    weekday: WEEKDAYS.indexOf(part('weekday')),
  };
};

/**
 * How far a time zone's clocks are ahead of UTC at an instant, in milliseconds
 */
const timeZoneOffsetMs = (instant: Date, timeZone: string): number => {
  const part = dateParts(instant, timeZone, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });

  const wallClock = Date.UTC(
    Number(part('year')),
    Number(part('month')) - 1,
    Number(part('day')),
    Number(part('hour')),
    Number(part('minute')),
    Number(part('second'))
  );

  return wallClock - Math.floor(instant.getTime() / 1000) * 1000;
};

/**
 * When the payout job runs on a calendar date of its own time zone. The day
 * may overflow the month.
 */
const payoutJobRunOn = (year: number, month: number, day: number): Date => {
  const wallClock = Date.UTC(year, month - 1, day, SCHEDULED_PAYOUT_HOUR);
  return new Date(wallClock - timeZoneOffsetMs(new Date(wallClock), PAYOUT_JOB_TIMEZONE));
};

/**
 * Whether a schedule pays out on a calendar date in its time zone
 */
const isPayoutDay = (
  schedule: Pick<PayoutSchedule, 'frequency' | 'dayOfWeek' | 'dayOfMonth'>,
  date: LocalDate
): boolean => {
  switch (schedule.frequency) {
    case 'DAILY':
      return true;
    case 'WEEKLY':
      return date.weekday === schedule.dayOfWeek;
    case 'BIWEEKLY': {
      // Every other week on the chosen day
      const week = Math.floor((Date.UTC(date.year, date.month - 1, date.day) - BIWEEKLY_EPOCH_MS) / WEEK_MS);
      return date.weekday === schedule.dayOfWeek && week % 2 === 0;
    }
    case 'MONTHLY':
      return date.day === schedule.dayOfMonth;
    default:
      return false;
  }
};

/**
 * When the payout job will next request a payout for this schedule: its first
 * daily run (08:00 Lagos time) after `now` that falls on a payout day in the
 * schedule's time zone. Null for a paused or MANUAL schedule. The job still
 * skips that day if the balance or bank account doesn't allow a payout.
 */
export const getNextPayoutDate = (schedule: ScheduleTiming, now: Date = new Date()): Date | null => {
  if (!schedule.isActive || schedule.frequency === 'MANUAL') {
    return null;
  }

  const timeZone = scheduleTimeZone(schedule.timezone);
  const today = localDateIn(now, PAYOUT_JOB_TIMEZONE);

  for (let offset = 0; offset <= NEXT_PAYOUT_SEARCH_DAYS; offset++) {
    const run = payoutJobRunOn(today.year, today.month, today.day + offset);

    if (run.getTime() > now.getTime() && isPayoutDay(schedule, localDateIn(run, timeZone))) {
      return run;
    }
  }

  return null;
};

// ==========================================
// Helper Functions
// ==========================================

const formatNaira = (kobo: number) => koboToNaira(kobo).toLocaleString('en-US');

/**
 * Format payout schedule for response
 */
const formatPayoutSchedule = (schedule: PayoutSchedule) => ({
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
  nextPayoutDate: getNextPayoutDate(schedule)?.toISOString() ?? null,
  createdAt: schedule.createdAt.toISOString(),
  updatedAt: schedule.updatedAt.toISOString(),
});

/**
 * Format scheduled payout for response
 */
const formatScheduledPayout = (payout: ScheduledPayout) => {
  // Each payout becomes one withdrawal, which carries the flat transfer fee. A
  // skipped day made no withdrawal.
  const skipped = Boolean(payout.skipReason);

  return {
    id: payout.id,
    providerId: payout.providerId,
    amount: koboToNaira(payout.amount),
    amountKobo: payout.amount,
    fee: skipped ? 0 : koboToNaira(TRANSFER_FEE_KOBO),
    netAmount: skipped ? 0 : koboToNaira(payout.amount - TRANSFER_FEE_KOBO),
    paymentIds: payout.paymentIds,
    scheduledFor: payout.scheduledFor.toISOString(),
    status: payout.status,
    skipReason: payout.skipReason ?? null,
    withdrawalId: payout.withdrawalId,
    processedAt: payout.processedAt?.toISOString() || null,
    failureReason: payout.failureReason,
    createdAt: payout.createdAt.toISOString(),
    updatedAt: payout.updatedAt.toISOString(),
  };
};

/**
 * Record a payout day the job skipped. The provider is notified when the
 * reason is one they can act on and their previous payout wasn't skipped for
 * the same reason, so a lasting problem notifies once.
 */
const recordSkippedPayout = async (
  schedule: ScheduleWithProvider,
  skipReason: PayoutSkipReason,
  message: string,
  amountKobo: number,
  now: Date
) => {
  const notify = NOTIFIED_SKIP_REASONS.has(skipReason);

  const previous = notify
    ? await prisma.scheduledPayout.findFirst({
        where: { providerId: schedule.providerId },
        orderBy: { scheduledFor: 'desc' },
        select: { skipReason: true },
      })
    : null;

  const payout = await prisma.scheduledPayout.create({
    data: {
      providerId: schedule.providerId,
      amount: amountKobo,
      paymentIds: [],
      scheduledFor: now,
      status: 'CANCELLED',
      skipReason,
      failureReason: message,
      processedAt: now,
    },
  });

  if (!notify || previous?.skipReason === skipReason) {
    return;
  }

  try {
    await createNotification({
      userId: schedule.provider.userId,
      type: NotificationType.SYSTEM_ANNOUNCEMENT,
      title: 'Scheduled payout skipped',
      message,
      entityType: 'scheduledPayout',
      entityId: payout.id,
      metadata: { scheduledPayoutId: payout.id, skipReason },
    });
  } catch (error) {
    console.error('Failed to notify a provider of a skipped payout:', error);
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
 * Set or update provider's payout schedule. Saving also turns a paused
 * schedule back on.
 */
export const setPayoutSchedule = async (
  providerId: string,
  userId: string,
  input: SetPayoutScheduleInput
) => {
  const { frequency, dayOfWeek, dayOfMonth, minimumAmount, bankAccountId } = input;

  if ((frequency as string) === 'INSTANT') {
    throw new GraphQLError('Instant payouts are not supported. Choose DAILY, WEEKLY, BIWEEKLY, MONTHLY or MANUAL.', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  // Validate dayOfWeek for WEEKLY and BIWEEKLY
  if (
    (frequency === 'WEEKLY' || frequency === 'BIWEEKLY') &&
    (dayOfWeek == null || dayOfWeek < 0 || dayOfWeek > 6)
  ) {
    throw new GraphQLError('Day of week must be 0-6 for weekly and biweekly payouts', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  // Validate dayOfMonth for MONTHLY
  if (frequency === 'MONTHLY' && (!dayOfMonth || dayOfMonth < 1 || dayOfMonth > 28)) {
    throw new GraphQLError('Day of month must be 1-28 for monthly payouts', {
      extensions: { code: 'INVALID_INPUT' },
    });
  }

  // Left out, null or 0 sets the default. Anything else must be an amount a
  // payout can reach: at least the minimum withdrawal, at most the cap.
  const minimumAmountKobo = minimumAmount ? Math.round(minimumAmount * 100) : DEFAULT_MINIMUM_AMOUNT_KOBO;

  if (
    !Number.isFinite(minimumAmountKobo) ||
    minimumAmountKobo < MIN_PAYOUT_MINIMUM_KOBO ||
    minimumAmountKobo > MAX_PAYOUT_MINIMUM_KOBO
  ) {
    throw new GraphQLError(
      `Minimum payout amount must be between ₦${formatNaira(MIN_PAYOUT_MINIMUM_KOBO)} and ₦${formatNaira(MAX_PAYOUT_MINIMUM_KOBO)}`,
      { extensions: { code: 'INVALID_INPUT' } }
    );
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
 * Pause payout schedule. setPayoutSchedule turns it back on.
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

// ==========================================
// Pending Earnings
// ==========================================

/**
 * What the provider can withdraw now, and the earnings still on their way to
 * the wallet (in naira)
 */
export const getProviderPendingEarnings = async (providerId: string, userId: string) => {
  const now = new Date();

  // Escrow is the same test Wallet.pendingBalance uses, so payments released
  // before walletTransactionId was recorded (only payoutAt set) don't count
  const [releasedPayments, heldPayments, wallet] = await Promise.all([
    // In escrow but past their release time; the release job credits them within minutes
    prisma.payment.findMany({
      where: {
        booking: { providerId },
        ...HELD_IN_ESCROW,
        withdrawableAt: { lte: now },
      },
      select: {
        id: true,
        providerPayout: true,
      },
    }),
    // Still held: no release time yet, or one in the future. On MongoDB
    // `field: null` doesn't match a field that was never written, hence isSet.
    prisma.payment.findMany({
      where: {
        booking: { providerId },
        ...HELD_IN_ESCROW,
        AND: [
          ...HELD_IN_ESCROW.AND,
          {
            OR: [
              { withdrawableAt: null },
              { withdrawableAt: { isSet: false } },
              { withdrawableAt: { gt: now } },
            ],
          },
        ],
      },
      select: {
        id: true,
        providerPayout: true,
        withdrawableAt: true,
      },
    }),
    prisma.wallet.findUnique({
      where: { userId },
      select: { balance: true, isLocked: true },
    }),
  ]);

  const releasedAmount = releasedPayments.reduce((sum, p) => sum + p.providerPayout, 0);
  const heldAmount = heldPayments.reduce((sum, p) => sum + p.providerPayout, 0);

  // Withdrawable now: the wallet balance, unless an open withdrawal holds the wallet
  const availableNow = wallet && !wallet.isLocked ? koboToNaira(wallet.balance) : 0;

  const nextAvailable = heldPayments
    .map((p) => p.withdrawableAt)
    .filter((date): date is Date => date instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return {
    totalPending: releasedAmount + heldAmount,
    availableNow,
    pendingClearance: heldAmount,
    nextAvailableDate: nextAvailable?.toISOString() ?? null,
    releasedAmount,
    heldAmount,
    releasedPaymentIds: releasedPayments.map((p) => p.id),
    pendingPayments: heldPayments.map((p) => ({
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

  const results: { providerId: string; success: boolean; skipped?: PayoutSkipReason; message: string }[] = [];

  for (const schedule of schedules) {
    try {
      const now = new Date();

      if (!isPayoutDay(schedule, localDateIn(now, scheduleTimeZone(schedule.timezone)))) {
        continue;
      }

      // Once per run day, even if the job runs again. A skipped day counts.
      const recentPayout = await prisma.scheduledPayout.findFirst({
        where: {
          providerId: schedule.providerId,
          scheduledFor: { gte: new Date(now.getTime() - PAYOUT_RUN_GAP_MS) },
        },
      });

      if (recentPayout) {
        continue;
      }

      const skip = async (reason: PayoutSkipReason, message: string, amountKobo: number) => {
        await recordSkippedPayout(schedule, reason, message, amountKobo, now);
        results.push({ providerId: schedule.providerId, success: false, skipped: reason, message });
      };

      // Payouts come out of the wallet, which holds the released earnings
      const wallet = await prisma.wallet.findUnique({
        where: { userId: schedule.provider.userId },
      });

      const minimumKobo = Math.max(schedule.minimumAmount, MIN_WITHDRAWAL_NAIRA * 100);
      const amountKobo = Math.min(wallet?.balance ?? 0, MAX_SINGLE_TRANSACTION_KOBO);

      if (wallet?.isLocked) {
        await skip(
          'WALLET_LOCKED',
          'Scheduled payout skipped because your wallet is locked by a withdrawal that is still open.',
          amountKobo
        );
        continue;
      }

      if (amountKobo < minimumKobo) {
        await skip(
          'BELOW_MINIMUM',
          `Scheduled payout skipped because your balance of ₦${formatNaira(amountKobo)} is below your minimum of ₦${formatNaira(minimumKobo)}.`,
          amountKobo
        );
        continue;
      }

      // Get bank account
      const bankAccountId =
        schedule.bankAccountId ?? (await getDefaultBankAccount(schedule.providerId))?.id;

      if (!bankAccountId) {
        await skip(
          'NO_BANK_ACCOUNT',
          'Scheduled payout skipped because you have no bank account for payouts. Add one, or set a default account.',
          amountKobo
        );
        continue;
      }

      // Create scheduled payout record
      const scheduledPayout = await prisma.scheduledPayout.create({
        data: {
          providerId: schedule.providerId,
          amount: amountKobo,
          paymentIds: [],
          scheduledFor: now,
          status: 'PENDING',
        },
      });

      // Request withdrawal; it's processed like any other, and its outcome
      // updates this record
      try {
        const withdrawal = await requestWithdrawal(
          schedule.providerId,
          schedule.provider.userId,
          {
            amount: koboToNaira(amountKobo),
            bankAccountId,
          },
          { scheduledPayoutId: scheduledPayout.id }
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
          message: `Withdrawal of ₦${koboToNaira(amountKobo)} requested`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Withdrawal request failed';

        await prisma.scheduledPayout.update({
          where: { id: scheduledPayout.id },
          data: {
            status: 'FAILED',
            failureReason: message,
          },
        });

        results.push({
          providerId: schedule.providerId,
          success: false,
          message,
        });
      }
    } catch (error) {
      results.push({
        providerId: schedule.providerId,
        success: false,
        message: error instanceof Error ? error.message : 'Scheduled payout failed',
      });
    }
  }

  return {
    processed: results.length,
    successful: results.filter((r) => r.success).length,
    skipped: results.filter((r) => r.skipped).length,
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
    items: payouts.map(formatScheduledPayout),
    total,
    page,
    totalPages: Math.ceil(total / limit),
    hasNextPage: page * limit < total,
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
    items: payouts.map(formatScheduledPayout),
    total,
    page,
    totalPages: Math.ceil(total / limit),
    hasNextPage: page * limit < total,
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
