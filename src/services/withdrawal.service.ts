/**
 * Withdrawal Service
 *
 * Handles provider withdrawal operations.
 *
 * Lifecycle:
 * - Request: the wallet is locked ("Pending withdrawal") and a PENDING
 *   withdrawal is created with a snapshot of the bank details
 * - Process (admin): the withdrawal is claimed (PENDING → PROCESSING), the
 *   wallet debited, and a Paystack transfer started under a reference unique
 *   to this attempt
 * - Paystack reports the result by webhook. Success completes the withdrawal
 *   and unlocks the wallet. Failure returns the money to the wallet and puts
 *   the withdrawal back to PENDING for an admin to retry or reject, until
 *   MAX_RETRIES attempts have failed.
 * - If starting a transfer errors, the money is only returned once Paystack
 *   confirms no transfer was made. Otherwise the withdrawal stays PROCESSING
 *   and a background job checks it with Paystack.
 *
 * Security:
 * - Status changes are conditional updates, so two admins (or an admin and a
 *   webhook) can't act on the same withdrawal twice
 * - Each debit and reversal has a reference unique to the withdrawal attempt
 * - Bank details snapshot at request time
 * - Daily and per-withdrawal limits
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { paystack, PaystackRequestError, type PaystackTransferResponse } from '@/lib/paystack';
import { AdminAction, type Withdrawal, type WithdrawalStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { withTransaction } from '@/lib/transaction';
import { captureException } from '@/lib/sentry';
import { LedgerReference, NotificationType } from '@/constants';
import { isBanActive, isRestrictionActive } from '@/utils/security';
import {
  applyWalletCredit,
  applyWalletDebit,
  canWithdraw,
  koboToNaira,
  nairaToKobo,
  MAX_SINGLE_TRANSACTION_KOBO,
} from './wallet.service';
import { createAuditLog } from './audit.service';
import { createBulkNotifications, createNotification } from './notification.service';
import { sendPushToUser } from './push.service';

/**
 * Write an in-app notification AND fire a push. Errors are swallowed so a
 * messaging failure can't roll back a successful withdrawal-state change.
 */
const notifyAndPush = async (
  userId: string,
  type: string,
  title: string,
  message: string,
  metadata?: Record<string, any>
) => {
  try {
    await createNotification({ userId, type, title, message, metadata });
  } catch (err) {
    console.error('Failed to write withdrawal notification', err);
  }
  try {
    await sendPushToUser(userId, {
      title,
      message,
      data: { type, ...(metadata ?? {}) },
    });
  } catch (err) {
    console.error('Failed to send withdrawal push', err);
  }
};

// ==========================================
// Types
// ==========================================

interface RequestWithdrawalInput {
  amount: number; // In Naira
  bankAccountId: string;
}

interface WithdrawalFilters {
  status?: WithdrawalStatus;
  providerId?: string;
  startDate?: string;
  endDate?: string;
}

interface PaginationInput {
  page: number;
  limit: number;
}

// What a Paystack transfer event or lookup tells us
interface TransferEvent {
  reference?: string;
  transferCode?: string;
}

type TransferData = PaystackTransferResponse['data'];

type LatePayoutOutcome =
  | { outcome: 'recovered'; withdrawal: Withdrawal }
  | { outcome: 'moved-on' | 'nothing' };

/** Who a withdrawal belongs to */
export interface WithdrawalProviderSummary {
  id: string;
  userId: string;
  businessName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

interface ProviderUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  provider?: { businessName: string } | null;
}

// ==========================================
// Constants
// ==========================================

const MAX_RETRIES = 5;
export const TRANSFER_FEE_KOBO = 5000; // ₦50 transfer fee (adjust as needed)
export const MIN_WITHDRAWAL_NAIRA = 1000; // Minimum ₦1,000 withdrawal, well above the fee

// A transfer still processing after this long is checked with Paystack
const RECONCILE_AFTER_MINUTES = 30;

const LockReason = {
  PENDING: 'Pending withdrawal',
  PROCESSING: 'Processing withdrawal',
  FAILED: 'Transfer failed - pending review',
} as const;

// Transfer states in which Paystack won't deliver the money
const FAILED_TRANSFER_STATES = new Set<string>(['failed', 'abandoned', 'blocked', 'rejected']);

// The references processWithdrawal issues
const ATTEMPT_REFERENCE = /^wdr_[0-9a-f]{24}_\d+$/;

// ==========================================
// Helper Functions
// ==========================================

/**
 * Paystack transfer reference for one attempt. Paystack treats a repeated
 * reference as the same transfer, so each retry needs its own; it also
 * expects references in lowercase.
 */
const transferReferenceFor = (withdrawalId: string, attempt: number) =>
  `wdr_${withdrawalId}_${attempt}`.toLowerCase();

/**
 * Placeholder until the first attempt. The field is unique, so it can't be
 * left empty.
 */
const generateRequestReference = (): string => `wdr_req_${uuidv4().replace(/-/g, '')}`;

/**
 * Format withdrawal for response
 */
const formatWithdrawal = (withdrawal: any) => ({
  id: withdrawal.id,
  walletId: withdrawal.walletId,
  providerId: withdrawal.providerId,
  amount: koboToNaira(withdrawal.amount),
  amountKobo: withdrawal.amount,
  fee: koboToNaira(withdrawal.fee),
  feeKobo: withdrawal.fee,
  netAmount: koboToNaira(withdrawal.netAmount),
  netAmountKobo: withdrawal.netAmount,
  status: withdrawal.status,
  bankCode: withdrawal.bankCode,
  bankName: withdrawal.bankName,
  accountNumber: withdrawal.accountNumber,
  accountName: withdrawal.accountName,
  bankAccountSnapshot: {
    bankCode: withdrawal.bankCode,
    bankName: withdrawal.bankName,
    accountNumber: withdrawal.accountNumber,
    accountName: withdrawal.accountName,
  },
  transferCode: withdrawal.transferCode,
  transferReference: withdrawal.transferReference,
  transferRef: withdrawal.transferReference,
  requestedAt: withdrawal.requestedAt.toISOString(),
  processedAt: withdrawal.processedAt?.toISOString() || null,
  completedAt: withdrawal.completedAt?.toISOString() || null,
  failureReason: withdrawal.failureReason,
  retryCount: withdrawal.retryCount,
  lastRetryAt: withdrawal.lastRetryAt?.toISOString() || null,
  processedBy: withdrawal.processedBy,
  createdAt: withdrawal.createdAt.toISOString(),
  updatedAt: withdrawal.updatedAt.toISOString(),
});

/**
 * The withdrawal a transfer belongs to. The reference is saved before the
 * transfer starts, so it's matched first; withdrawals started before
 * references were lowercase may come back with different casing.
 */
const findWithdrawalForTransfer = async ({ reference, transferCode }: TransferEvent) => {
  if (reference) {
    const byReference =
      (await prisma.withdrawal.findFirst({ where: { transferReference: reference } })) ??
      (await prisma.withdrawal.findFirst({
        where: { transferReference: { equals: reference, mode: 'insensitive' } },
      }));
    if (byReference) return byReference;
  }

  if (transferCode) {
    return prisma.withdrawal.findFirst({ where: { transferCode } });
  }

  return null;
};

const notifyProvider = async (
  providerId: string,
  type: string,
  title: string,
  message: string,
  withdrawalId: string
) => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
  });

  if (provider) {
    await notifyAndPush(provider.userId, type, title, message, { withdrawalId });
  }
};

/**
 * In-app notification to every active admin. Errors are swallowed.
 */
const notifyAdmins = async (title: string, message: string, metadata: Record<string, string>) => {
  try {
    const admins = await prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
      select: { id: true },
    });
    await createBulkNotifications(
      admins.map((admin) => admin.id),
      NotificationType.SYSTEM_ANNOUNCEMENT,
      title,
      message,
      'withdrawal',
      undefined,
      metadata
    );
  } catch (error) {
    console.error('Failed to alert admins about a withdrawal:', error);
  }
};

const toProviderSummary = (providerId: string, user: ProviderUser): WithdrawalProviderSummary => ({
  id: providerId,
  userId: user.id,
  businessName: user.provider?.businessName ?? null,
  firstName: user.firstName ?? null,
  lastName: user.lastName ?? null,
  email: user.email ?? null,
});

/**
 * Who a withdrawal belongs to, for results that didn't load it with the withdrawal
 */
export const getWithdrawalProviderSummary = async (
  providerId: string
): Promise<WithdrawalProviderSummary | null> => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
    select: {
      businessName: true,
      user: { select: { id: true, email: true, firstName: true, lastName: true } },
    },
  });

  return provider
    ? toProviderSummary(providerId, { ...provider.user, provider: { businessName: provider.businessName } })
    : null;
};

/**
 * Keep a scheduled payout in step with the withdrawal it created
 */
const updateScheduledPayout = async (
  withdrawal: { scheduledPayoutId: string | null },
  status: WithdrawalStatus,
  failureReason?: string
) => {
  if (!withdrawal.scheduledPayoutId) return;

  try {
    await prisma.scheduledPayout.update({
      where: { id: withdrawal.scheduledPayoutId },
      data: {
        status,
        processedAt: new Date(),
        ...(failureReason ? { failureReason } : {}),
      },
    });
  } catch (error) {
    console.error('Failed to update scheduled payout:', error);
  }
};

// ==========================================
// Withdrawal Request Functions
// ==========================================

/**
 * Request a withdrawal (provider only)
 */
export const requestWithdrawal = async (
  providerId: string,
  userId: string,
  input: RequestWithdrawalInput,
  options: { scheduledPayoutId?: string } = {}
) => {
  const { amount, bankAccountId } = input;
  const amountKobo = nairaToKobo(amount);

  // Validate minimum withdrawal
  if (!Number.isFinite(amount) || amount < MIN_WITHDRAWAL_NAIRA) {
    throw new GraphQLError(
      `Minimum withdrawal amount is ₦${MIN_WITHDRAWAL_NAIRA}`,
      { extensions: { code: 'MIN_WITHDRAWAL_NOT_MET' } }
    );
  }

  if (amountKobo > MAX_SINGLE_TRANSACTION_KOBO) {
    throw new GraphQLError(
      `A single withdrawal can be at most ₦${koboToNaira(MAX_SINGLE_TRANSACTION_KOBO).toLocaleString()}`,
      { extensions: { code: 'WITHDRAWAL_LIMIT_EXCEEDED' } }
    );
  }

  // The minimum withdrawal is well above the fee, so the net amount is never too small
  const fee = TRANSFER_FEE_KOBO;
  const netAmount = amountKobo - fee;

  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: { bannedAt: true, bannedUntil: true, restrictedAt: true, restrictedUntil: true },
  });

  if (!account || isBanActive(account) || isRestrictionActive(account)) {
    throw new GraphQLError(
      'Your account is restricted, so you can’t withdraw right now. Please contact support.',
      { extensions: { code: 'ACCOUNT_RESTRICTED' } }
    );
  }

  // Check daily withdrawal limit
  const limitCheck = await canWithdraw(userId, amountKobo);
  if (!limitCheck.allowed) {
    throw new GraphQLError(limitCheck.reason || 'Daily withdrawal limit reached', {
      extensions: {
        code: 'DAILY_LIMIT_EXCEEDED',
        // In naira, like every other amount the API returns
        remainingLimit: koboToNaira(limitCheck.remainingLimit ?? 0),
      },
    });
  }

  const pendingWithdrawal = await prisma.withdrawal.findFirst({
    where: {
      providerId,
      status: { in: ['PENDING', 'PROCESSING'] },
    },
  });

  if (pendingWithdrawal) {
    throw new GraphQLError(
      'You have a pending withdrawal. Please wait for it to complete.',
      { extensions: { code: 'PENDING_WITHDRAWAL_EXISTS' } }
    );
  }

  // Get provider's wallet
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
  });

  if (!wallet) {
    throw new GraphQLError('Wallet not found', {
      extensions: { code: 'WALLET_NOT_FOUND' },
    });
  }

  // Check if wallet is locked
  if (wallet.isLocked) {
    throw new GraphQLError(
      `Wallet is locked: ${wallet.lockedReason || 'Pending operation'}`,
      { extensions: { code: 'WALLET_LOCKED' } }
    );
  }

  // Check sufficient balance
  if (wallet.balance < amountKobo) {
    throw new GraphQLError(
      'Insufficient balance for this withdrawal',
      { extensions: { code: 'INSUFFICIENT_BALANCE' } }
    );
  }

  // Get bank account (with snapshot)
  const bankAccount = await prisma.providerBankAccount.findFirst({
    where: {
      id: bankAccountId,
      providerId,
    },
  });

  if (!bankAccount) {
    throw new GraphQLError('Bank account not found', {
      extensions: { code: 'BANK_ACCOUNT_NOT_FOUND' },
    });
  }

  // Lock the wallet and create the withdrawal together. The lock only takes
  // an unlocked wallet with enough balance, so concurrent requests can't both
  // succeed.
  const withdrawal = await withTransaction(async (tx) => {
    const lockResult = await tx.wallet.updateMany({
      where: {
        id: wallet.id,
        isLocked: false,
        balance: { gte: amountKobo },
      },
      data: {
        isLocked: true,
        lockedReason: LockReason.PENDING,
      },
    });

    if (lockResult.count === 0) {
      throw new GraphQLError(
        'Unable to process withdrawal. Wallet may be locked or balance changed.',
        { extensions: { code: 'WALLET_LOCK_FAILED' } }
      );
    }

    return tx.withdrawal.create({
      data: {
        walletId: wallet.id,
        providerId,
        amount: amountKobo,
        fee,
        netAmount,
        status: 'PENDING',
        bankCode: bankAccount.bankCode,
        bankName: bankAccount.bankName,
        accountNumber: bankAccount.accountNumber,
        accountName: bankAccount.accountName,
        transferReference: generateRequestReference(),
        requestedAt: new Date(),
        scheduledPayoutId: options.scheduledPayoutId,
      },
    });
  });

  await notifyAdmins(
    'New withdrawal request',
    `${options.scheduledPayoutId ? 'A scheduled payout' : 'A withdrawal'} of ₦${koboToNaira(amountKobo).toLocaleString('en-US')} to ${bankAccount.accountName} (${bankAccount.bankName}) is waiting for approval.`,
    { withdrawalId: withdrawal.id }
  );

  return formatWithdrawal(withdrawal);
};

/**
 * Cancel a pending withdrawal (provider only)
 */
export const cancelWithdrawal = async (
  withdrawalId: string,
  providerId: string,
  _userId: string
) => {
  const withdrawal = await prisma.withdrawal.findFirst({
    where: {
      id: withdrawalId,
      providerId,
    },
  });

  if (!withdrawal) {
    throw new GraphQLError('Withdrawal not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (withdrawal.status !== 'PENDING') {
    throw new GraphQLError(
      `Cannot cancel withdrawal with status: ${withdrawal.status}`,
      { extensions: { code: 'INVALID_STATUS' } }
    );
  }

  // A pending withdrawal holds no money, so cancelling only releases the lock
  await withTransaction(async (tx) => {
    const { count } = await tx.withdrawal.updateMany({
      where: { id: withdrawalId, providerId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });

    if (count === 0) {
      throw new GraphQLError('This withdrawal can no longer be cancelled', {
        extensions: { code: 'INVALID_STATUS' },
      });
    }

    await tx.wallet.update({
      where: { id: withdrawal.walletId },
      data: {
        isLocked: false,
        lockedReason: null,
      },
    });
  });

  await updateScheduledPayout(withdrawal, 'CANCELLED', 'Cancelled by the provider');

  const updated = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
  });

  return {
    success: true,
    message: 'Withdrawal cancelled successfully',
    withdrawal: formatWithdrawal(updated),
  };
};

/**
 * Get provider's withdrawal history
 */
export const getProviderWithdrawals = async (
  providerId: string,
  filters: WithdrawalFilters = {},
  pagination: PaginationInput
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const where: any = { providerId };

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.startDate || filters.endDate) {
    where.requestedAt = {};
    if (filters.startDate) {
      where.requestedAt.gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      where.requestedAt.lte = new Date(filters.endDate);
    }
  }

  const [withdrawals, total] = await Promise.all([
    prisma.withdrawal.findMany({
      where,
      orderBy: { requestedAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.withdrawal.count({ where }),
  ]);

  const items = withdrawals.map(formatWithdrawal);

  return {
    items,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    hasNextPage: page * limit < total,
    withdrawals: items,
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

// ==========================================
// Admin Functions
// ==========================================

/**
 * Get one of the provider's withdrawals
 */
export const getProviderWithdrawalById = async (withdrawalId: string, providerId: string) => {
  const withdrawal = await prisma.withdrawal.findFirst({
    where: { id: withdrawalId, providerId },
  });

  return withdrawal ? formatWithdrawal(withdrawal) : null;
};

/**
 * Get all withdrawals (admin)
 */
export const getAllWithdrawals = async (
  filters: WithdrawalFilters = {},
  pagination: PaginationInput
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const where: any = {};

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.providerId) {
    where.providerId = filters.providerId;
  }

  if (filters.startDate || filters.endDate) {
    where.requestedAt = {};
    if (filters.startDate) {
      where.requestedAt.gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      where.requestedAt.lte = new Date(filters.endDate);
    }
  }

  const [withdrawals, total] = await Promise.all([
    prisma.withdrawal.findMany({
      where,
      orderBy: { requestedAt: 'desc' },
      skip,
      take: limit,
      include: {
        wallet: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                provider: { select: { businessName: true } },
              },
            },
          },
        },
      },
    }),
    prisma.withdrawal.count({ where }),
  ]);

  const items = withdrawals.map((w) => ({
    ...formatWithdrawal(w),
    provider: w.wallet?.user ? toProviderSummary(w.providerId, w.wallet.user) : null,
  }));

  return {
    items,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    hasNextPage: page * limit < total,
    withdrawals: items,
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
 * Get pending withdrawals count (admin dashboard)
 */
export const getPendingWithdrawalsCount = async () => {
  return prisma.withdrawal.count({
    where: { status: 'PENDING' },
  });
};

/**
 * Get the Paystack recipient for the withdrawal's bank account, creating it
 * if needed
 */
const getRecipientCode = async (withdrawal: Withdrawal): Promise<string> => {
  const bankAccount = await prisma.providerBankAccount.findFirst({
    where: {
      providerId: withdrawal.providerId,
      accountNumber: withdrawal.accountNumber,
      bankCode: withdrawal.bankCode,
    },
  });

  if (bankAccount?.recipientCode) {
    return bankAccount.recipientCode;
  }

  const response = await paystack.createTransferRecipient({
    type: 'nuban',
    name: withdrawal.accountName,
    account_number: withdrawal.accountNumber,
    bank_code: withdrawal.bankCode,
    currency: 'NGN',
  });

  if (!response.status) {
    throw new GraphQLError('Failed to create transfer recipient', {
      extensions: { code: 'PAYSTACK_ERROR' },
    });
  }

  const recipientCode = response.data.recipient_code;

  if (bankAccount) {
    await prisma.providerBankAccount.update({
      where: { id: bankAccount.id },
      data: { recipientCode },
    });
  }

  return recipientCode;
};

/**
 * Return a failed attempt's debit to the wallet. Changes nothing unless the
 * withdrawal is still PROCESSING on this attempt, so a repeated or late event
 * can't return the money twice. Before MAX_RETRIES attempts have failed the
 * withdrawal goes back to PENDING, with the wallet locked, for an admin to
 * retry or reject; after that it fails for good and the wallet is unlocked.
 */
const reverseAttempt = async (withdrawalId: string, reference: string, failureReason: string) => {
  return withTransaction(async (tx) => {
    const current = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });

    if (
      !current ||
      current.status !== 'PROCESSING' ||
      current.transferReference?.toLowerCase() !== reference.toLowerCase()
    ) {
      return null;
    }

    const attempt = current.retryCount;
    const final = attempt + 1 >= MAX_RETRIES;

    const { count } = await tx.withdrawal.updateMany({
      where: { id: withdrawalId, status: 'PROCESSING', retryCount: attempt },
      data: final
        ? {
            status: 'FAILED',
            failureReason: `Failed after ${MAX_RETRIES} attempts. Last error: ${failureReason}`,
            lastRetryAt: new Date(),
          }
        : {
            status: 'PENDING',
            retryCount: attempt + 1,
            lastRetryAt: new Date(),
            failureReason,
            transferCode: null,
          },
    });

    if (count === 0) return null;

    await applyWalletCredit(tx, {
      walletId: current.walletId,
      amount: current.amount,
      source: 'WITHDRAWAL_REVERSAL',
      description: final
        ? `Refund: withdrawal to ${current.bankName} failed after ${MAX_RETRIES} attempts`
        : `Refund: transfer to ${current.bankName} failed`,
      reference: LedgerReference.withdrawalReversal(current.id, attempt),
      withdrawalId: current.id,
    });

    await tx.wallet.update({
      where: { id: current.walletId },
      data: final
        ? { isLocked: false, lockedReason: null }
        : { isLocked: true, lockedReason: LockReason.FAILED },
    });

    return { withdrawal: current, final };
  });
};

/**
 * Alert admins to a withdrawal that needs a person to look at it
 */
const alertAdmins = async (title: string, message: string, metadata: Record<string, string>) => {
  captureException(new Error(title), { tags: { area: 'withdrawals' }, extra: { message, ...metadata } });
  await notifyAdmins(title, message, metadata);
};

/**
 * The attempt number in one of our transfer references
 */
const attemptFromReference = (reference: string): number | null => {
  const normalized = reference.toLowerCase();
  return ATTEMPT_REFERENCE.test(normalized)
    ? Number(normalized.slice(normalized.lastIndexOf('_') + 1))
    : null;
};

/**
 * The attempt a withdrawal's current transfer reference belongs to
 */
const currentAttempt = (withdrawal: Pick<Withdrawal, 'transferReference' | 'retryCount'>): number => {
  const fromReference = withdrawal.transferReference ? attemptFromReference(withdrawal.transferReference) : null;
  return fromReference ?? withdrawal.retryCount;
};

/**
 * Paystack paid a transfer after its amount had been returned to the wallet.
 * Take the returned amount back and complete the withdrawal. If that can't be
 * done (most likely the provider has already used the money), alert admins.
 */
const recordLatePayout = async (withdrawalId: string, reference: string) => {
  try {
    const result = await withTransaction(async (tx): Promise<LatePayoutOutcome> => {
      const current = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });

      if (!current) return { outcome: 'nothing' };

      // Retried under a later attempt since: this payout may be one of two
      if (current.transferReference?.toLowerCase() !== reference.toLowerCase()) {
        return { outcome: 'moved-on' };
      }

      if (!(['PENDING', 'FAILED', 'CANCELLED'] as string[]).includes(current.status)) {
        return { outcome: 'nothing' };
      }

      // Paid and then returned by the bank: this success event is a repeat
      if (current.status === 'FAILED' && current.completedAt) {
        return { outcome: 'nothing' };
      }

      // A failure before the last attempt moves the withdrawal on to the next one
      const attempt =
        attemptFromReference(reference) ??
        (current.status === 'FAILED' ? current.retryCount : current.retryCount - 1);

      // This late payout was recorded already
      const recorded = await tx.walletTransaction.findUnique({
        where: { reference: LedgerReference.withdrawalLatePayout(current.id, attempt) },
      });

      if (recorded) return { outcome: 'nothing' };

      const reversal = await tx.walletTransaction.findUnique({
        where: { reference: LedgerReference.withdrawalReversal(current.id, attempt) },
      });

      if (!reversal) return { outcome: 'nothing' };

      const { count } = await tx.withdrawal.updateMany({
        where: { id: current.id, status: current.status, transferReference: current.transferReference },
        data: { status: 'COMPLETED', completedAt: new Date(), failureReason: null },
      });

      // Changed while this ran, e.g. retried by an admin
      if (count === 0) return { outcome: 'moved-on' };

      await applyWalletDebit(tx, {
        walletId: current.walletId,
        amount: reversal.amount,
        source: 'WITHDRAWAL',
        description: `Withdrawal to ${current.bankName} went through after the amount was returned`,
        reference: LedgerReference.withdrawalLatePayout(current.id, attempt),
        withdrawalId: current.id,
        allowLocked: true,
      });

      // A withdrawal waiting for review holds the wallet's lock
      if (current.status === 'PENDING') {
        await tx.wallet.update({
          where: { id: current.walletId },
          data: { isLocked: false, lockedReason: null },
        });
      }

      return { outcome: 'recovered', withdrawal: current };
    });

    if (result.outcome === 'moved-on') {
      await alertAdmins(
        'Earlier withdrawal attempt was paid',
        `Paystack paid ${reference} for withdrawal ${withdrawalId} after the withdrawal had moved on. Check whether the provider was paid twice.`,
        { withdrawalId, reference }
      );
      return;
    }

    if (result.outcome !== 'recovered') return;

    const recovered = result.withdrawal;

    await updateScheduledPayout(recovered, 'COMPLETED');

    await notifyProvider(
      recovered.providerId,
      'PAYMENT_RECEIVED',
      'Withdrawal Successful',
      `₦${koboToNaira(recovered.netAmount)} has been sent to your ${recovered.bankName} account.`,
      recovered.id
    );
  } catch (error) {
    captureException(error, { tags: { area: 'withdrawals' }, extra: { withdrawalId, reference } });
    await alertAdmins(
      'Withdrawal paid after a refund',
      `Paystack paid withdrawal ${withdrawalId} (${reference}) after its amount had been returned to the provider's wallet, and the amount couldn't be taken back automatically. Recover it from the provider's wallet.`,
      { withdrawalId, reference }
    );
  }
};

/**
 * A successful transfer that matches no current withdrawal attempt. If it's an
 * earlier attempt of one of our withdrawals, the provider may have been paid
 * twice.
 */
const flagUnmatchedPayout = async ({ reference, transferCode }: TransferEvent) => {
  const attempt = reference ? attemptFromReference(reference) : null;

  if (!reference || attempt === null) {
    console.log(`Transfer not found: ${reference ?? transferCode}`);
    return;
  }

  const withdrawalId = reference.toLowerCase().split('_')[1];
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });

  if (!withdrawal) {
    console.log(`Transfer not found: ${reference}`);
    return;
  }

  await alertAdmins(
    'Earlier withdrawal attempt was paid',
    `Paystack paid attempt ${attempt + 1} (${reference}) of withdrawal ${withdrawal.id} after it had moved on to a later attempt. Check whether the provider was paid twice.`,
    { withdrawalId: withdrawal.id, reference }
  );
};

/**
 * The last attempt failed and its amount is back in the wallet: update a
 * linked scheduled payout and tell the provider. Best effort, since the money
 * has already moved.
 */
const finishFailedWithdrawal = async (withdrawal: Withdrawal, failureReason: string) => {
  try {
    await updateScheduledPayout(withdrawal, 'FAILED', failureReason);

    await notifyProvider(
      withdrawal.providerId,
      'PAYMENT_FAILED',
      'Withdrawal Failed',
      `Your withdrawal of ₦${koboToNaira(withdrawal.amount)} failed after multiple attempts. The amount has been refunded to your wallet.`,
      withdrawal.id
    );
  } catch (error) {
    captureException(error, { tags: { area: 'withdrawals' }, extra: { withdrawalId: withdrawal.id } });
  }
};

/**
 * Starting a transfer errored. If Paystack has the transfer after all, carry
 * on with it. The money goes back to the wallet straight away only when
 * Paystack rejected the request and confirms no transfer exists. After a
 * timeout or server error the transfer may still be created, so the
 * withdrawal stays PROCESSING and reconciliation settles it later, rather
 * than risk paying the provider twice.
 */
const resolveTransferStartError = async (
  withdrawal: Withdrawal,
  reference: string,
  error: unknown
): Promise<TransferData> => {
  const message = error instanceof Error ? error.message : 'Transfer initiation failed';
  const rejected =
    error instanceof PaystackRequestError &&
    error.httpStatus !== undefined &&
    error.httpStatus >= 400 &&
    error.httpStatus < 500;
  let transferMissing = false;

  try {
    const existing = await paystack.verifyTransfer(reference);
    if (existing.status && existing.data) {
      return existing.data;
    }
  } catch (verifyError) {
    transferMissing = verifyError instanceof PaystackRequestError && verifyError.httpStatus === 404;
  }

  if (!rejected || !transferMissing) {
    await prisma.withdrawal.updateMany({
      where: { id: withdrawal.id, status: 'PROCESSING', transferReference: reference },
      data: { failureReason: `Transfer status unknown: ${message}` },
    });
    captureException(error, { tags: { area: 'withdrawals' }, extra: { withdrawalId: withdrawal.id, reference } });

    throw new GraphQLError(
      'Paystack didn’t confirm whether the transfer was made. It will be checked again automatically, so don’t retry it.',
      { extensions: { code: 'TRANSFER_UNCONFIRMED' } }
    );
  }

  const reversed = await reverseAttempt(withdrawal.id, reference, message);

  if (reversed?.final) {
    await finishFailedWithdrawal(reversed.withdrawal, message);
  }

  throw new GraphQLError(`Transfer initiation failed: ${message}. The amount is back in the provider's wallet.`, {
    extensions: { code: 'TRANSFER_FAILED' },
  });
};

/**
 * Record a transfer Paystack accepted, and apply its state if it's already final
 */
const applyTransferState = async (withdrawalId: string, reference: string, transfer: TransferData) => {
  try {
    // Webhooks match on the reference, so the code is for display and lookups
    await prisma.withdrawal.updateMany({
      where: { id: withdrawalId, transferReference: reference },
      data: { transferCode: transfer.transfer_code },
    });

    const event = { reference, transferCode: transfer.transfer_code };

    if (transfer.status === 'success') {
      await handleTransferSuccess(event);
    } else if (transfer.status === 'reversed') {
      await handleTransferReversed(event);
    } else if (FAILED_TRANSFER_STATES.has(transfer.status)) {
      await handleTransferFailed(event, `Transfer ${transfer.status}`);
    } else if (transfer.status === 'otp') {
      captureException(new Error('Withdrawal transfer is waiting for OTP approval in Paystack'), {
        tags: { area: 'withdrawals' },
        extra: { withdrawalId, reference },
      });
    }
  } catch (error) {
    // The webhook and reconciliation apply the same state later
    captureException(error, { tags: { area: 'withdrawals' }, extra: { withdrawalId, reference } });
  }
};

/**
 * Process a withdrawal (admin)
 * Initiates Paystack transfer
 */
export const processWithdrawal = async (
  withdrawalId: string,
  adminId: string,
  adminRole: string
) => {
  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
    include: { wallet: true },
  });

  if (!withdrawal) {
    throw new GraphQLError('Withdrawal not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (withdrawal.status !== 'PENDING') {
    throw new GraphQLError(
      `Cannot process withdrawal with status: ${withdrawal.status}`,
      { extensions: { code: 'INVALID_STATUS' } }
    );
  }

  const account = await prisma.user.findUnique({
    where: { id: withdrawal.wallet.userId },
    select: { bannedAt: true, bannedUntil: true, restrictedAt: true, restrictedUntil: true },
  });

  if (!account) {
    throw new GraphQLError('The provider’s account no longer exists', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // A ban or restriction may have started since the withdrawal was requested
  if (isBanActive(account) || isRestrictionActive(account)) {
    throw new GraphQLError(
      'The provider’s account is banned or restricted, so this withdrawal can’t be processed. Reject it, or process it once the restriction ends.',
      { extensions: { code: 'PROVIDER_RESTRICTED' } }
    );
  }

  // A failed attempt returns its debit before the withdrawal waits for a retry.
  // One that came back to PENDING without that (under the earlier payout
  // process) still holds its debit, so another attempt would debit it twice.
  if (withdrawal.retryCount > 0) {
    const previousReversal = await prisma.walletTransaction.findUnique({
      where: { reference: LedgerReference.withdrawalReversal(withdrawal.id, withdrawal.retryCount - 1) },
      select: { id: true },
    });

    if (!previousReversal) {
      throw new GraphQLError(
        'The amount of this withdrawal’s last failed attempt was never returned to the wallet, so it can’t be retried. Check the provider’s wallet history, then correct the balance or reject the withdrawal.',
        { extensions: { code: 'MANUAL_REVIEW_REQUIRED' } }
      );
    }
  }

  // The amount only counts towards the daily limit once it's debited
  const limitCheck = await canWithdraw(withdrawal.wallet.userId, withdrawal.amount);
  if (!limitCheck.allowed) {
    throw new GraphQLError(limitCheck.reason || 'Daily withdrawal limit reached', {
      extensions: { code: 'DAILY_LIMIT_EXCEEDED', remainingLimit: koboToNaira(limitCheck.remainingLimit ?? 0) },
    });
  }

  const recipientCode = await getRecipientCode(withdrawal);

  const attempt = withdrawal.retryCount;
  const reference = transferReferenceFor(withdrawal.id, attempt);

  // Claim the withdrawal and debit the wallet together; a second admin's
  // claim matches nothing
  await withTransaction(async (tx) => {
    const { count } = await tx.withdrawal.updateMany({
      where: { id: withdrawalId, status: 'PENDING', retryCount: attempt },
      data: {
        status: 'PROCESSING',
        processedAt: new Date(),
        processedBy: adminId,
        transferReference: reference,
        transferCode: null,
        failureReason: null,
      },
    });

    if (count === 0) {
      throw new GraphQLError('This withdrawal is already being processed', {
        extensions: { code: 'INVALID_STATUS' },
      });
    }

    await applyWalletDebit(tx, {
      walletId: withdrawal.walletId,
      amount: withdrawal.amount,
      source: 'WITHDRAWAL',
      description: `Withdrawal to ${withdrawal.bankName} - ${withdrawal.accountNumber}`,
      reference: LedgerReference.withdrawal(withdrawal.id, attempt),
      withdrawalId: withdrawal.id,
      // The wallet is locked by this withdrawal
      allowLocked: true,
    });

    await tx.wallet.update({
      where: { id: withdrawal.walletId },
      data: { isLocked: true, lockedReason: LockReason.PROCESSING },
    });
  });

  // Logged before the transfer starts, so the attempt is recorded whatever happens next
  try {
    await createAuditLog({
      action: AdminAction.PROCESS_WITHDRAWAL,
      targetType: 'Withdrawal',
      targetId: withdrawalId,
      performedBy: adminId,
      performedByRole: adminRole,
      previousValue: { status: 'PENDING' },
      newValue: { status: 'PROCESSING', reference, attempt },
      reason: 'Withdrawal approved and transfer initiated',
    });
  } catch (error) {
    captureException(error, { tags: { area: 'withdrawals' }, extra: { withdrawalId } });
  }

  let transfer: TransferData;
  try {
    const response = await paystack.initiateTransfer({
      source: 'balance',
      amount: withdrawal.netAmount, // Already in kobo
      recipient: recipientCode,
      reason: `Easykonnet withdrawal ${withdrawal.id}`,
      reference,
    });

    if (!response.status) {
      throw new PaystackRequestError(response.message || 'Transfer initiation failed', 400);
    }

    transfer = response.data;
  } catch (error) {
    transfer = await resolveTransferStartError(withdrawal, reference, error);
  }

  await applyTransferState(withdrawal.id, reference, transfer);

  const updated = await prisma.withdrawal.findUniqueOrThrow({
    where: { id: withdrawalId },
  });

  return formatWithdrawal(updated);
};

/**
 * Reject a withdrawal (admin)
 */
export const rejectWithdrawal = async (
  withdrawalId: string,
  adminId: string,
  adminRole: string,
  reason: string
) => {
  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
  });

  if (!withdrawal) {
    throw new GraphQLError('Withdrawal not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (withdrawal.status !== 'PENDING') {
    throw new GraphQLError(
      `Cannot reject withdrawal with status: ${withdrawal.status}`,
      { extensions: { code: 'INVALID_STATUS' } }
    );
  }

  // A pending withdrawal holds no money, so rejecting only releases the lock
  await withTransaction(async (tx) => {
    const { count } = await tx.withdrawal.updateMany({
      where: { id: withdrawalId, status: 'PENDING' },
      data: {
        status: 'CANCELLED',
        failureReason: reason,
        processedAt: new Date(),
        processedBy: adminId,
      },
    });

    if (count === 0) {
      throw new GraphQLError('This withdrawal is no longer pending', {
        extensions: { code: 'INVALID_STATUS' },
      });
    }

    await tx.wallet.update({
      where: { id: withdrawal.walletId },
      data: {
        isLocked: false,
        lockedReason: null,
      },
    });
  });

  try {
    await createAuditLog({
      action: AdminAction.REJECT_WITHDRAWAL,
      targetType: 'Withdrawal',
      targetId: withdrawalId,
      performedBy: adminId,
      performedByRole: adminRole,
      previousValue: { status: 'PENDING' },
      newValue: { status: 'CANCELLED', reason },
      reason,
    });
  } catch (error) {
    captureException(error, { tags: { area: 'withdrawals' }, extra: { withdrawalId } });
  }

  await updateScheduledPayout(withdrawal, 'CANCELLED', reason);

  await notifyProvider(
    withdrawal.providerId,
    'PAYMENT_FAILED',
    'Withdrawal Rejected',
    `Your withdrawal of ₦${koboToNaira(withdrawal.amount)} has been rejected. Reason: ${reason}`,
    withdrawalId
  );

  const updated = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
  });

  return formatWithdrawal(updated);
};

// ==========================================
// Webhook Handlers
// ==========================================

/**
 * Handle a successful transfer. The balance was debited when the withdrawal
 * was processed, so this completes it and unlocks the wallet.
 */
export const handleTransferSuccess = async (event: TransferEvent) => {
  const withdrawal = await findWithdrawalForTransfer(event);

  if (!withdrawal) {
    await flagUnmatchedPayout(event);
    return;
  }

  const completed = await withTransaction(async (tx) => {
    // Only a withdrawal still processing completes, so a repeat does nothing
    const { count } = await tx.withdrawal.updateMany({
      where: { id: withdrawal.id, status: 'PROCESSING' },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        ...(event.transferCode ? { transferCode: event.transferCode } : {}),
      },
    });

    if (count === 0) return false;

    await tx.wallet.update({
      where: { id: withdrawal.walletId },
      data: {
        isLocked: false,
        lockedReason: null,
      },
    });

    return true;
  });

  if (!completed) {
    // Paid after the money had been returned to the wallet
    if (withdrawal.status !== 'COMPLETED' && withdrawal.transferReference) {
      await recordLatePayout(withdrawal.id, withdrawal.transferReference);
    }
    return;
  }

  await updateScheduledPayout(withdrawal, 'COMPLETED');

  await notifyProvider(
    withdrawal.providerId,
    'PAYMENT_RECEIVED',
    'Withdrawal Successful',
    `₦${koboToNaira(withdrawal.netAmount)} has been sent to your ${withdrawal.bankName} account.`,
    withdrawal.id
  );
};

/**
 * Handle a failed transfer: return the money to the wallet
 */
export const handleTransferFailed = async (event: TransferEvent, failureReason: string) => {
  const withdrawal = await findWithdrawalForTransfer(event);

  if (!withdrawal?.transferReference) {
    console.log(`Transfer not found: ${event.reference ?? event.transferCode}`);
    return;
  }

  const reversed = await reverseAttempt(withdrawal.id, withdrawal.transferReference, failureReason);

  if (reversed?.final) {
    await finishFailedWithdrawal(reversed.withdrawal, failureReason);
  }
};

/**
 * Handle a reversed transfer. Before completion it's a failure; after
 * completion the bank has returned money we'd already sent.
 */
export const handleTransferReversed = async (event: TransferEvent) => {
  const withdrawal = await findWithdrawalForTransfer(event);

  if (!withdrawal) {
    console.log(`Transfer not found: ${event.reference ?? event.transferCode}`);
    return;
  }

  if (withdrawal.status === 'PROCESSING') {
    await handleTransferFailed(event, 'Transfer reversed');
    return;
  }

  if (withdrawal.status !== 'COMPLETED') return;

  const returned = await withTransaction(async (tx) => {
    const { count } = await tx.withdrawal.updateMany({
      where: { id: withdrawal.id, status: 'COMPLETED' },
      data: { status: 'FAILED', failureReason: 'The bank returned the transfer' },
    });

    if (count === 0) return false;

    await applyWalletCredit(tx, {
      walletId: withdrawal.walletId,
      amount: withdrawal.amount,
      source: 'WITHDRAWAL_REVERSAL',
      description: `Refund: transfer to ${withdrawal.bankName} was returned by the bank`,
      // Its own event: the same attempt may already have had a reversal, if it
      // failed and was then paid late
      reference: LedgerReference.withdrawalReturn(withdrawal.id, currentAttempt(withdrawal)),
      withdrawalId: withdrawal.id,
    });

    return true;
  });

  if (!returned) return;

  await updateScheduledPayout(withdrawal, 'FAILED', 'The bank returned the transfer');

  await notifyProvider(
    withdrawal.providerId,
    'PAYMENT_FAILED',
    'Withdrawal Returned',
    `Your bank returned the transfer of ₦${koboToNaira(withdrawal.netAmount)}. ₦${koboToNaira(withdrawal.amount)} is back in your wallet. Please check your bank details.`,
    withdrawal.id
  );
};

/**
 * Check withdrawals that have been processing for a while with Paystack and
 * apply the result, for transfers whose webhook never arrived or whose start
 * couldn't be confirmed. Called by a background job.
 */
export const reconcileProcessingWithdrawals = async () => {
  const cutoff = new Date(Date.now() - RECONCILE_AFTER_MINUTES * 60 * 1000);

  const processing = await prisma.withdrawal.findMany({
    where: { status: 'PROCESSING', processedAt: { lt: cutoff } },
    orderBy: { processedAt: 'asc' },
    take: 50,
  });

  let settled = 0;

  for (const withdrawal of processing) {
    const reference = withdrawal.transferReference;
    if (!reference) continue;

    try {
      const response = withdrawal.transferCode
        ? await paystack.fetchTransfer(withdrawal.transferCode)
        : await paystack.verifyTransfer(reference);
      const transfer = response.data;
      const event = { reference, transferCode: transfer.transfer_code };

      if (transfer.status === 'success') {
        await handleTransferSuccess(event);
        settled++;
      } else if (transfer.status === 'reversed') {
        await handleTransferReversed(event);
        settled++;
      } else if (FAILED_TRANSFER_STATES.has(transfer.status)) {
        await handleTransferFailed(event, `Transfer ${transfer.status}`);
        settled++;
      }
      // pending, otp, received: still under way
    } catch (error) {
      const notFound = error instanceof PaystackRequestError && error.httpStatus === 404;

      // Only a transfer started under one of our attempt references is known
      // never to have been made when Paystack has no record of it
      if (notFound && !withdrawal.transferCode && ATTEMPT_REFERENCE.test(reference)) {
        await handleTransferFailed({ reference }, 'Paystack has no record of this transfer');
        settled++;
      } else {
        captureException(error, {
          tags: { area: 'withdrawals' },
          extra: { withdrawalId: withdrawal.id, reference },
        });
      }
    }
  }

  return { checked: processing.length, settled };
};

/**
 * Start a new transfer attempt for a PENDING withdrawal whose last attempt
 * failed (admin). A FAILED withdrawal is final: its amount is back in the
 * wallet, and the provider requests a new withdrawal.
 */
export const retryWithdrawal = async (
  withdrawalId: string,
  adminId: string,
  adminRole: string
) => {
  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
  });

  if (!withdrawal) {
    throw new GraphQLError('Withdrawal not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (withdrawal.status !== 'PENDING' || withdrawal.retryCount === 0) {
    throw new GraphQLError('This withdrawal is not eligible for retry', {
      extensions: { code: 'INVALID_STATUS' },
    });
  }

  // A PENDING withdrawal has had fewer than MAX_RETRIES attempts
  return processWithdrawal(withdrawalId, adminId, adminRole);
};

/**
 * Get withdrawal statistics (admin)
 */
export const getWithdrawalStats = async (startDate?: string, endDate?: string) => {
  const where: any = {};

  if (startDate || endDate) {
    where.requestedAt = {};
    if (startDate) {
      where.requestedAt.gte = new Date(startDate);
    }
    if (endDate) {
      where.requestedAt.lte = new Date(endDate);
    }
  }

  const [pending, processing, completed, failed, cancelled] = await Promise.all([
    prisma.withdrawal.count({ where: { ...where, status: 'PENDING' } }),
    prisma.withdrawal.count({ where: { ...where, status: 'PROCESSING' } }),
    prisma.withdrawal.count({ where: { ...where, status: 'COMPLETED' } }),
    prisma.withdrawal.count({ where: { ...where, status: 'FAILED' } }),
    prisma.withdrawal.count({ where: { ...where, status: 'CANCELLED' } }),
  ]);

  // Calculate total amounts
  const completedWithdrawals = await prisma.withdrawal.aggregate({
    where: { ...where, status: 'COMPLETED' },
    _sum: { amount: true, fee: true },
  });

  return {
    counts: {
      pending,
      processing,
      completed,
      failed,
      cancelled,
      total: pending + processing + completed + failed + cancelled,
    },
    amounts: {
      totalWithdrawn: koboToNaira(completedWithdrawals._sum.amount || 0),
      totalFees: koboToNaira(completedWithdrawals._sum.fee || 0),
    },
  };
};
