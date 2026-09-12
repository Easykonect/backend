/**
 * Wallet Service
 *
 * Handles wallet operations for users and providers.
 *
 * Key Features:
 * - Users: Receive refunds, pay for bookings with wallet balance
 * - Providers: Receive service earnings, withdraw to bank account
 *
 * Security:
 * - All amounts stored in KOBO (integers) to avoid float precision issues
 * - Balance changes are atomic increments/decrements made in the same database
 *   transaction as the ledger entry that records them
 * - Every ledger entry has a unique reference derived from its business event
 *   (see LedgerReference), so a retried event never moves money twice
 * - Wallet locking during pending withdrawals
 * - Amount validation to prevent overflow attacks
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import {
  AdminAction,
  Prisma,
  type WalletTransaction,
  WalletTransactionType,
  WalletTransactionSource,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { withTransaction, type TransactionClient } from '@/lib/transaction';
import { captureException, captureWalletError } from '@/lib/sentry';
import { createAuditLog } from './audit.service';

// ==========================================
// Security Constants
// ==========================================

// Largest amount or balance (₦20 million in kobo). Wallet amounts are stored as
// 32-bit integers, which top out at 2,147,483,647 kobo.
const MAX_AMOUNT_KOBO = 2_000_000_000;

// A lock this old with no open withdrawal behind it was left over by a failure
const STALE_LOCK_MINUTES = 10;

const LAGOS_UTC_OFFSET_MS = 60 * 60 * 1000;

// ==========================================
// Types
// ==========================================

interface LedgerEntryInput {
  walletId: string;
  amount: number; // In kobo
  source: WalletTransactionSource;
  description: string;
  reference: string; // Idempotency key for the business event
  bookingId?: string;
  paymentId?: string;
  withdrawalId?: string;
  adjustedBy?: string;
  adjustmentReason?: string;
}

type CreditWalletInput = Omit<LedgerEntryInput, 'reference'> & { reference?: string };

type DebitWalletInput = CreditWalletInput;

interface WalletTransactionFilters {
  source?: WalletTransactionSource;
  type?: WalletTransactionType;
  startDate?: string;
  endDate?: string;
}

interface PaginationInput {
  page: number;
  limit: number;
}

// ==========================================
// Constants
// ==========================================

// Transaction limits
const MAX_DAILY_WITHDRAWAL_KOBO = 500_000_000; // ₦5 million per day
const MAX_SINGLE_TRANSACTION_KOBO = 100_000_000; // ₦1 million per transaction
const MAX_ADMIN_ADJUSTMENT_KOBO = 10_000_000; // ₦100,000 for regular admin
const SUPER_ADMIN_ADJUSTMENT_LIMIT_KOBO = 100_000_000; // ₦1 million for super admin

/**
 * Validate amount to prevent overflow and negative values
 */
const validateAmount = (amount: number, context: string): void => {
  if (!Number.isInteger(amount)) {
    throw new GraphQLError(`${context}: Amount must be a whole number (kobo)`, {
      extensions: { code: 'INVALID_AMOUNT' },
    });
  }

  if (amount <= 0) {
    throw new GraphQLError(`${context}: Amount must be positive`, {
      extensions: { code: 'INVALID_AMOUNT' },
    });
  }

  if (amount > MAX_AMOUNT_KOBO) {
    throw new GraphQLError(`${context}: Amount exceeds maximum allowed`, {
      extensions: { code: 'AMOUNT_TOO_LARGE' },
    });
  }
};

// ==========================================
// Helper Functions
// ==========================================

/**
 * Convert kobo to naira for display
 */
export const koboToNaira = (kobo: number): number => {
  return kobo / 100;
};

/**
 * Convert naira to kobo for storage
 */
export const nairaToKobo = (naira: number): number => {
  return Math.round(naira * 100);
};

/**
 * Generate a unique reference for events that can't be repeated by design
 * (e.g. an admin adjustment)
 */
const generateReference = (prefix: string = 'TXN'): string => {
  return `${prefix}_${Date.now()}_${uuidv4().substring(0, 8)}`;
};

/**
 * Format wallet for response
 */
const formatWallet = (wallet: any) => ({
  id: wallet.id,
  userId: wallet.userId,
  balance: koboToNaira(wallet.balance),
  balanceKobo: wallet.balance,
  pendingBalance: koboToNaira(wallet.pendingBalance),
  pendingBalanceKobo: wallet.pendingBalance,
  currency: wallet.currency,
  isLocked: wallet.isLocked,
  lockedReason: wallet.lockedReason,
  lockReason: wallet.lockedReason,
  createdAt: wallet.createdAt.toISOString(),
  updatedAt: wallet.updatedAt.toISOString(),
});

/**
 * Format wallet transaction for response
 */
export const formatTransaction = (transaction: WalletTransaction) => ({
  id: transaction.id,
  walletId: transaction.walletId,
  type: transaction.type,
  source: transaction.source,
  amount: koboToNaira(transaction.amount),
  amountKobo: transaction.amount,
  balanceBefore: koboToNaira(transaction.balanceBefore),
  balanceAfter: koboToNaira(transaction.balanceAfter),
  description: transaction.description,
  reference: transaction.reference,
  referenceId: transaction.reference,
  bookingId: transaction.bookingId,
  paymentId: transaction.paymentId,
  withdrawalId: transaction.withdrawalId,
  adjustedBy: transaction.adjustedBy,
  adjustmentReason: transaction.adjustmentReason,
  createdAt: transaction.createdAt.toISOString(),
});

// ==========================================
// Wallet Management
// ==========================================

/**
 * Find the user's wallet, creating it if needed. Call this before a
 * transaction that moves money: a failed create inside a MongoDB transaction
 * aborts the whole transaction.
 */
export const ensureWallet = async (userId: string) => {
  const existing = await prisma.wallet.findUnique({ where: { userId } });
  if (existing) return existing;

  try {
    return await prisma.wallet.create({
      data: {
        userId,
        balance: 0,
        pendingBalance: 0,
        currency: 'NGN',
      },
    });
  } catch (error) {
    // Another request created it first
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const created = await prisma.wallet.findUnique({ where: { userId } });
      if (created) return created;
    }
    throw error;
  }
};

/**
 * Payments still held in escrow: paid, and not yet released to the provider's
 * wallet. Releases before walletTransactionId was recorded only set payoutAt.
 */
export const HELD_IN_ESCROW = {
  status: 'COMPLETED',
  AND: [
    { OR: [{ payoutAt: null }, { payoutAt: { isSet: false } }] },
    { OR: [{ walletTransactionId: null }, { walletTransactionId: { isSet: false } }] },
  ],
} satisfies Prisma.PaymentWhereInput;

/**
 * A provider's share of their paid bookings still held in escrow, in kobo:
 * earned but not yet released to their wallet, after any partial refunds. 0
 * for an account without a provider profile. The API's Wallet.pendingBalance
 * is this; the stored wallet field isn't used.
 */
export const getEscrowedEarningsKobo = async (userId: string): Promise<number> => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!provider) return 0;

  const held = await prisma.payment.aggregate({
    where: { booking: { providerId: provider.id }, ...HELD_IN_ESCROW },
    _sum: { providerPayout: true },
  });

  return nairaToKobo(held._sum.providerPayout ?? 0);
};

/**
 * Get or create wallet for a user
 */
export const getOrCreateWallet = async (userId: string) => {
  const [wallet, pendingKobo] = await Promise.all([ensureWallet(userId), getEscrowedEarningsKobo(userId)]);
  return formatWallet({ ...wallet, pendingBalance: pendingKobo });
};

/**
 * Get wallet by user ID
 */
export const getWalletByUserId = async (userId: string) => {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
  });

  if (!wallet) {
    return null;
  }

  return formatWallet({ ...wallet, pendingBalance: await getEscrowedEarningsKobo(userId) });
};

/**
 * Get wallet balance (in naira)
 */
export const getWalletBalance = async (userId: string) => {
  const wallet = await getOrCreateWallet(userId);
  return {
    balance: wallet.balance,
    pendingBalance: wallet.pendingBalance,
    totalBalance: wallet.balance + wallet.pendingBalance,
    currency: wallet.currency,
    isLocked: wallet.isLocked,
  };
};

/**
 * Check if wallet has sufficient balance
 */
export const hasSufficientBalance = async (
  userId: string,
  amountKobo: number
): Promise<boolean> => {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
  });

  if (!wallet) return false;
  return wallet.balance >= amountKobo;
};

// ==========================================
// Ledger
// ==========================================

/**
 * Return the entry already written for this reference, if any
 */
const findExistingEntry = async (
  tx: TransactionClient,
  entry: LedgerEntryInput,
  type: WalletTransactionType
) => {
  const existing = await tx.walletTransaction.findUnique({
    where: { reference: entry.reference },
  });

  if (!existing) return null;

  if (existing.walletId !== entry.walletId || existing.type !== type || existing.amount !== entry.amount) {
    captureWalletError(new Error(`Wallet reference ${entry.reference} reused for a different entry`), {
      walletId: entry.walletId,
      operation: type === 'CREDIT' ? 'credit' : 'debit',
      amount: entry.amount,
    });
    throw new GraphQLError('This transaction reference has already been used', {
      extensions: { code: 'DUPLICATE_REFERENCE' },
    });
  }

  return existing;
};

/**
 * Credit a wallet inside a transaction. Returns the ledger entry; if the
 * reference was already credited, returns that entry without crediting again.
 */
export const applyWalletCredit = async (tx: TransactionClient, entry: LedgerEntryInput) => {
  validateAmount(entry.amount, 'Credit wallet');

  const existing = await findExistingEntry(tx, entry, 'CREDIT');
  if (existing) return existing;

  const wallet = await tx.wallet.update({
    where: { id: entry.walletId },
    data: { balance: { increment: entry.amount } },
  });

  if (wallet.balance > MAX_AMOUNT_KOBO) {
    throw new GraphQLError('Credit would exceed maximum wallet balance', {
      extensions: { code: 'BALANCE_OVERFLOW' },
    });
  }

  return tx.walletTransaction.create({
    data: {
      walletId: entry.walletId,
      type: 'CREDIT',
      source: entry.source,
      amount: entry.amount,
      balanceBefore: wallet.balance - entry.amount,
      balanceAfter: wallet.balance,
      description: entry.description,
      reference: entry.reference,
      bookingId: entry.bookingId,
      paymentId: entry.paymentId,
      withdrawalId: entry.withdrawalId,
      adjustedBy: entry.adjustedBy,
      adjustmentReason: entry.adjustmentReason,
    },
  });
};

/**
 * Debit a wallet inside a transaction. The balance check and the decrement are
 * one statement, so concurrent debits can't spend the same money.
 * `allowLocked` is only for the withdrawal that holds the lock.
 */
export const applyWalletDebit = async (
  tx: TransactionClient,
  entry: LedgerEntryInput & { allowLocked?: boolean }
) => {
  validateAmount(entry.amount, 'Debit wallet');

  const existing = await findExistingEntry(tx, entry, 'DEBIT');
  if (existing) return existing;

  const { count } = await tx.wallet.updateMany({
    where: {
      id: entry.walletId,
      balance: { gte: entry.amount },
      ...(entry.allowLocked ? {} : { isLocked: false }),
    },
    data: { balance: { decrement: entry.amount } },
  });

  const wallet = await tx.wallet.findUnique({
    where: { id: entry.walletId },
  });

  if (!wallet) {
    throw new GraphQLError('Wallet not found', {
      extensions: { code: 'WALLET_NOT_FOUND' },
    });
  }

  if (count === 0) {
    if (!entry.allowLocked && wallet.isLocked) {
      throw new GraphQLError(
        `Wallet is locked: ${wallet.lockedReason || 'Pending operation'}`,
        { extensions: { code: 'WALLET_LOCKED' } }
      );
    }

    // Don't reveal exact balance in error (security)
    throw new GraphQLError(
      'Insufficient wallet balance for this transaction',
      { extensions: { code: 'INSUFFICIENT_BALANCE' } }
    );
  }

  return tx.walletTransaction.create({
    data: {
      walletId: entry.walletId,
      type: 'DEBIT',
      source: entry.source,
      amount: entry.amount,
      balanceBefore: wallet.balance + entry.amount,
      balanceAfter: wallet.balance,
      description: entry.description,
      reference: entry.reference,
      bookingId: entry.bookingId,
      paymentId: entry.paymentId,
      withdrawalId: entry.withdrawalId,
      adjustedBy: entry.adjustedBy,
      adjustmentReason: entry.adjustmentReason,
    },
  });
};

/**
 * Credit wallet (add funds)
 */
export const creditWallet = async (input: CreditWalletInput) => {
  // Fixed before the transaction so a retry reuses it
  const reference = input.reference ?? generateReference('CR');

  const transaction = await withTransaction((tx) =>
    applyWalletCredit(tx, { ...input, reference })
  );

  return formatTransaction(transaction);
};

/**
 * Debit wallet (remove funds)
 */
export const debitWallet = async (input: DebitWalletInput) => {
  // Enforce single transaction limit
  if (input.amount > MAX_SINGLE_TRANSACTION_KOBO) {
    throw new GraphQLError(
      `Transaction amount exceeds maximum allowed (₦${koboToNaira(MAX_SINGLE_TRANSACTION_KOBO)})`,
      { extensions: { code: 'AMOUNT_TOO_LARGE' } }
    );
  }

  const reference = input.reference ?? generateReference('DR');

  const transaction = await withTransaction((tx) =>
    applyWalletDebit(tx, { ...input, reference })
  );

  return formatTransaction(transaction);
};

// Older GraphQL enum names still accepted in filters
const LEGACY_TRANSACTION_SOURCES: Record<string, WalletTransactionSource> = {
  EARNING: 'SERVICE_EARNING',
  PAYOUT: 'WITHDRAWAL',
};

/**
 * Get wallet transactions with filters
 */
export const getWalletTransactions = async (
  walletId: string,
  filters: WalletTransactionFilters = {},
  pagination: PaginationInput
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const where: any = { walletId };

  if (filters.source) {
    where.source = LEGACY_TRANSACTION_SOURCES[filters.source] ?? filters.source;
  }

  if (filters.type) {
    where.type = filters.type;
  }

  if (filters.startDate || filters.endDate) {
    where.createdAt = {};
    if (filters.startDate) {
      where.createdAt.gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      where.createdAt.lte = new Date(filters.endDate);
    }
  }

  const [transactions, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.walletTransaction.count({ where }),
  ]);

  const items = transactions.map(formatTransaction);

  return {
    items,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    hasNextPage: page * limit < total,
    transactions: items,
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
// Provider-Specific Operations
// ==========================================

/**
 * Get provider's withdrawable balance
 */
export const getProviderWithdrawableBalance = async (providerId: string) => {
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
    select: { userId: true },
  });

  if (!provider) {
    throw new GraphQLError('Provider not found', {
      extensions: { code: 'PROVIDER_NOT_FOUND' },
    });
  }

  const wallet = await prisma.wallet.findUnique({
    where: { userId: provider.userId },
  });

  if (!wallet) {
    return {
      withdrawableBalance: 0,
      pendingBalance: 0,
      totalBalance: 0,
      currency: 'NGN',
    };
  }

  return {
    withdrawableBalance: koboToNaira(wallet.balance),
    pendingBalance: koboToNaira(wallet.pendingBalance),
    totalBalance: koboToNaira(wallet.balance + wallet.pendingBalance),
    currency: wallet.currency,
    isLocked: wallet.isLocked,
  };
};

// ==========================================
// Wallet Lock/Unlock (for withdrawals)
// ==========================================

/**
 * Lock wallet (during pending withdrawal)
 * Uses atomic operation to prevent race conditions
 */
export const lockWallet = async (walletId: string, reason: string): Promise<boolean> => {
  // Atomic lock - only succeeds if wallet is not already locked
  const result = await prisma.wallet.updateMany({
    where: {
      id: walletId,
      isLocked: false, // Only lock if not already locked
    },
    data: {
      isLocked: true,
      lockedReason: reason,
      updatedAt: new Date(),
    },
  });

  return result.count > 0;
};

/**
 * Unlock wallet (after withdrawal completes/fails/cancelled)
 */
export const unlockWallet = async (walletId: string) => {
  const wallet = await prisma.wallet.update({
    where: { id: walletId },
    data: {
      isLocked: false,
      lockedReason: null,
    },
  });

  return formatWallet(wallet);
};

/**
 * Release locks left behind by a failure. Wallets are only locked while a
 * withdrawal is pending or processing, so a lock with no open withdrawal is
 * stale; a lock that still has one is left alone however old it is.
 * Called by a background job.
 */
export const unlockStaleWallets = async (): Promise<number> => {
  const cutoff = new Date(Date.now() - STALE_LOCK_MINUTES * 60 * 1000);

  const locked = await prisma.wallet.findMany({
    where: { isLocked: true, updatedAt: { lt: cutoff } },
    select: { id: true },
    take: 500,
  });

  if (locked.length === 0) return 0;

  const walletIds = locked.map((wallet) => wallet.id);
  const openWithdrawals = await prisma.withdrawal.findMany({
    where: { walletId: { in: walletIds }, status: { in: ['PENDING', 'PROCESSING'] } },
    select: { walletId: true },
  });

  const inUse = new Set(openWithdrawals.map((withdrawal) => withdrawal.walletId));
  const stale = walletIds.filter((id) => !inUse.has(id));

  if (stale.length === 0) return 0;

  // A locked wallet can't start a new withdrawal, so nothing can take these
  // locks between the check above and this update
  const result = await prisma.wallet.updateMany({
    where: { id: { in: stale }, isLocked: true },
    data: {
      isLocked: false,
      lockedReason: null,
    },
  });

  if (result.count > 0) {
    console.warn(`Unlocked ${result.count} stale wallet locks`);
  }

  return result.count;
};

// ==========================================
// Admin Operations
// ==========================================

/**
 * Admin wallet balance adjustment
 * For manual corrections or compensations
 *
 * SECURITY:
 * - Regular admins limited to ₦100,000 adjustments
 * - Super admins limited to ₦1,000,000 adjustments
 * - Every adjustment records the admin and reason, and writes an audit log
 */
export const adjustWalletBalance = async (
  userId: string,
  amountKobo: number,
  type: 'CREDIT' | 'DEBIT',
  reason: string,
  adminId: string,
  adminRole: string = 'ADMIN'
) => {
  // Validate amount
  validateAmount(amountKobo, 'Admin adjustment');

  // Enforce role-based limits
  const limit = adminRole === 'SUPER_ADMIN'
    ? SUPER_ADMIN_ADJUSTMENT_LIMIT_KOBO
    : MAX_ADMIN_ADJUSTMENT_KOBO;

  if (amountKobo > limit) {
    const limitNaira = koboToNaira(limit);
    throw new GraphQLError(
      `Adjustment amount exceeds your limit (₦${limitNaira.toLocaleString()}). Contact a higher authority.`,
      { extensions: { code: 'ADJUSTMENT_LIMIT_EXCEEDED' } }
    );
  }

  // Validate reason is provided and meaningful
  if (!reason || reason.trim().length < 10) {
    throw new GraphQLError(
      'Please provide a detailed reason for this adjustment (min 10 characters)',
      { extensions: { code: 'INVALID_REASON' } }
    );
  }

  // Only an existing customer or provider account has a use for wallet money
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
    throw new GraphQLError('Wallet adjustments can only be made to customer and provider accounts', {
      extensions: { code: 'FORBIDDEN' },
    });
  }

  const wallet = await ensureWallet(userId);

  const entry: LedgerEntryInput = {
    walletId: wallet.id,
    amount: amountKobo,
    source: 'ADMIN_ADJUSTMENT',
    description: `Admin adjustment: ${reason}`,
    reference: generateReference('ADJ'),
    adjustedBy: adminId,
    adjustmentReason: reason,
  };

  const transaction = await withTransaction((tx) =>
    type === 'CREDIT' ? applyWalletCredit(tx, entry) : applyWalletDebit(tx, entry)
  );

  // The balance has already changed; a failed audit write must not report the
  // adjustment as failed, or the admin may repeat it
  try {
    await createAuditLog({
      action: AdminAction.ADJUST_WALLET,
      targetType: 'Wallet',
      targetId: wallet.id,
      performedBy: adminId,
      performedByRole: adminRole,
      previousValue: { balance: koboToNaira(transaction.balanceBefore) },
      newValue: {
        balance: koboToNaira(transaction.balanceAfter),
        type,
        amount: koboToNaira(amountKobo),
        reference: transaction.reference,
      },
      reason,
    });
  } catch (error) {
    captureException(error as Error, { tags: { area: 'wallet' }, extra: { walletId: wallet.id, reference: transaction.reference } });
  }

  return formatTransaction(transaction);
};

/**
 * Get today's withdrawal total for a user, net of transfers that failed and
 * were returned to the wallet
 */
export const getDailyWithdrawalTotal = async (userId: string): Promise<number> => {
  // The day starts at midnight in Lagos (UTC+1 all year), whatever the server's timezone
  const lagosNow = new Date(Date.now() + LAGOS_UTC_OFFSET_MS);
  lagosNow.setUTCHours(0, 0, 0, 0);
  const startOfDay = new Date(lagosNow.getTime() - LAGOS_UTC_OFFSET_MS);

  const [debits, reversals] = await Promise.all([
    prisma.walletTransaction.aggregate({
      where: {
        wallet: { userId },
        type: 'DEBIT',
        source: 'WITHDRAWAL',
        createdAt: { gte: startOfDay },
      },
      _sum: { amount: true },
    }),
    prisma.walletTransaction.aggregate({
      where: {
        wallet: { userId },
        type: 'CREDIT',
        source: 'WITHDRAWAL_REVERSAL',
        createdAt: { gte: startOfDay },
      },
      _sum: { amount: true },
    }),
  ]);

  return Math.max((debits._sum.amount || 0) - (reversals._sum.amount || 0), 0);
};

/**
 * Check if user can withdraw specified amount (within daily limit)
 */
export const canWithdraw = async (userId: string, amountKobo: number): Promise<{
  allowed: boolean;
  reason?: string;
  remainingLimit?: number;
}> => {
  const dailyTotal = await getDailyWithdrawalTotal(userId);
  const remaining = MAX_DAILY_WITHDRAWAL_KOBO - dailyTotal;

  if (amountKobo > remaining) {
    return {
      allowed: false,
      reason: `Daily withdrawal limit reached. Remaining: ₦${koboToNaira(remaining).toLocaleString()}`,
      remainingLimit: remaining,
    };
  }

  return { allowed: true, remainingLimit: remaining };
};

/**
 * Get all wallets (admin)
 */
export const getAllWallets = async (pagination: PaginationInput) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const [wallets, total] = await Promise.all([
    prisma.wallet.findMany({
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
          },
        },
      },
      orderBy: { balance: 'desc' },
      skip,
      take: limit,
    }),
    prisma.wallet.count(),
  ]);

  return {
    wallets: wallets.map((w) => ({
      ...formatWallet(w),
      user: w.user,
    })),
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

// Export constants for use in other services
export {
  MAX_DAILY_WITHDRAWAL_KOBO,
  MAX_SINGLE_TRANSACTION_KOBO,
  MAX_ADMIN_ADJUSTMENT_KOBO,
  SUPER_ADMIN_ADJUSTMENT_LIMIT_KOBO,
  MAX_AMOUNT_KOBO,
};
