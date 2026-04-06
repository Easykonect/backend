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
 * - Atomic balance updates with optimistic locking
 * - Idempotency keys to prevent duplicate transactions
 * - Wallet locking during pending withdrawals
 * - Distributed locking via Redis for race condition prevention
 * - Amount validation to prevent overflow attacks
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { WalletTransactionType, WalletTransactionSource } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import RedisClient from '@/lib/redis';
import { captureWalletError, addBreadcrumb } from '@/lib/sentry';

// ==========================================
// Security Constants
// ==========================================

// Maximum allowed amount (₦100 million in kobo) - prevents overflow
const MAX_AMOUNT_KOBO = 10_000_000_000;

// Distributed lock TTL (30 seconds)
const LOCK_TTL_MS = 30000;

// Lock key prefixes
const WALLET_LOCK_PREFIX = 'wallet_lock:';
const WITHDRAWAL_LOCK_PREFIX = 'withdrawal_lock:';

// ==========================================
// Types
// ==========================================

interface CreditWalletInput {
  walletId: string;
  amount: number; // In kobo
  source: WalletTransactionSource;
  description: string;
  reference?: string; // Idempotency key
  bookingId?: string;
  paymentId?: string;
  withdrawalId?: string;
  adjustedBy?: string;
  adjustmentReason?: string;
}

interface DebitWalletInput {
  walletId: string;
  amount: number; // In kobo
  source: WalletTransactionSource;
  description: string;
  reference?: string;
  bookingId?: string;
  paymentId?: string;
  withdrawalId?: string;
}

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

// Dispute window: how long before earnings become withdrawable (48 hours)
export const DISPUTE_WINDOW_HOURS = 48;

// Transaction limits
const MAX_DAILY_WITHDRAWAL_KOBO = 500_000_000; // ₦5 million per day
const MAX_SINGLE_TRANSACTION_KOBO = 100_000_000; // ₦1 million per transaction
const MAX_ADMIN_ADJUSTMENT_KOBO = 10_000_000; // ₦100,000 for regular admin
const SUPER_ADMIN_ADJUSTMENT_LIMIT_KOBO = 100_000_000; // ₦1 million for super admin

// ==========================================
// Distributed Locking Functions
// ==========================================

/**
 * Get Redis client safely
 */
const getRedis = () => {
  try {
    return RedisClient.getInstance();
  } catch {
    return null;
  }
};

/**
 * Acquire a distributed lock for wallet operations
 * Prevents race conditions across multiple server instances
 */
const acquireWalletLock = async (walletId: string): Promise<boolean> => {
  const redis = getRedis();
  if (!redis) {
    // If Redis unavailable, use database-level locking via version field
    return true;
  }
  
  const lockKey = `${WALLET_LOCK_PREFIX}${walletId}`;
  const lockValue = `${Date.now()}_${uuidv4()}`;
  
  // SET NX with expiry - atomic operation
  const result = await redis.set(lockKey, lockValue, 'PX', LOCK_TTL_MS, 'NX');
  return result === 'OK';
};

/**
 * Release a distributed lock
 */
const releaseWalletLock = async (walletId: string): Promise<void> => {
  const redis = getRedis();
  if (!redis) return;
  
  const lockKey = `${WALLET_LOCK_PREFIX}${walletId}`;
  await redis.del(lockKey);
};

/**
 * Execute operation with distributed lock
 */
const withWalletLock = async <T>(
  walletId: string,
  operation: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> => {
  let retries = 0;
  
  while (retries < maxRetries) {
    const acquired = await acquireWalletLock(walletId);
    
    if (acquired) {
      try {
        return await operation();
      } finally {
        await releaseWalletLock(walletId);
      }
    }
    
    // Wait with exponential backoff
    await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, retries)));
    retries++;
  }
  
  throw new GraphQLError('Unable to process wallet operation. Please try again.', {
    extensions: { code: 'WALLET_BUSY' },
  });
};

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
 * Generate unique transaction reference
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
  createdAt: wallet.createdAt.toISOString(),
  updatedAt: wallet.updatedAt.toISOString(),
});

/**
 * Format wallet transaction for response
 */
const formatTransaction = (transaction: any) => ({
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
 * Get or create wallet for a user
 */
export const getOrCreateWallet = async (userId: string) => {
  // Try to find existing wallet
  let wallet = await prisma.wallet.findUnique({
    where: { userId },
  });

  // Create if doesn't exist
  if (!wallet) {
    wallet = await prisma.wallet.create({
      data: {
        userId,
        balance: 0,
        pendingBalance: 0,
        currency: 'NGN',
      },
    });
  }

  return formatWallet(wallet);
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

  return formatWallet(wallet);
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
// Wallet Transactions
// ==========================================

/**
 * Credit wallet (add funds)
 * Uses distributed locking + atomic updates for race condition prevention
 */
export const creditWallet = async (input: CreditWalletInput) => {
  const {
    walletId,
    amount,
    source,
    description,
    reference = generateReference('CR'),
    bookingId,
    paymentId,
    withdrawalId,
    adjustedBy,
    adjustmentReason,
  } = input;

  // Validate amount to prevent overflow attacks
  validateAmount(amount, 'Credit wallet');

  // Check idempotency - if transaction with this reference exists, return it
  const existingTransaction = await prisma.walletTransaction.findUnique({
    where: { reference },
  });

  if (existingTransaction) {
    return formatTransaction(existingTransaction);
  }

  // Execute with distributed lock to prevent race conditions
  return withWalletLock(walletId, async () => {
    // Perform atomic credit operation
    const result = await prisma.$transaction(async (tx) => {
      // Get current wallet state
      const wallet = await tx.wallet.findUnique({
        where: { id: walletId },
      });

      if (!wallet) {
        throw new GraphQLError('Wallet not found', {
          extensions: { code: 'WALLET_NOT_FOUND' },
        });
      }

      const balanceBefore = wallet.balance;
      const balanceAfter = balanceBefore + amount;

      // Validate new balance doesn't overflow
      if (balanceAfter > MAX_AMOUNT_KOBO) {
        throw new GraphQLError('Credit would exceed maximum wallet balance', {
          extensions: { code: 'BALANCE_OVERFLOW' },
        });
      }

      // Atomic update with optimistic locking via updatedAt check
      const updateResult = await tx.wallet.updateMany({
        where: { 
          id: walletId,
          updatedAt: wallet.updatedAt, // Optimistic lock
        },
        data: { 
          balance: balanceAfter,
          updatedAt: new Date(),
        },
      });

      if (updateResult.count === 0) {
        throw new GraphQLError('Concurrent modification detected. Please retry.', {
          extensions: { code: 'CONCURRENT_MODIFICATION' },
        });
      }

      // Create transaction record
      const transaction = await tx.walletTransaction.create({
        data: {
          walletId,
          type: 'CREDIT',
          source,
          amount,
          balanceBefore,
          balanceAfter,
          description,
          reference,
          bookingId,
          paymentId,
          withdrawalId,
          adjustedBy,
          adjustmentReason,
        },
      });

      return transaction;
    });

    return formatTransaction(result);
  });
};

/**
 * Debit wallet (remove funds)
 * Uses distributed locking + atomic updates for race condition prevention
 * CRITICAL: This is the main function that prevents double-spending
 */
export const debitWallet = async (input: DebitWalletInput) => {
  const {
    walletId,
    amount,
    source,
    description,
    reference = generateReference('DR'),
    bookingId,
    paymentId,
    withdrawalId,
  } = input;

  // Validate amount to prevent overflow attacks
  validateAmount(amount, 'Debit wallet');

  // Enforce single transaction limit
  if (amount > MAX_SINGLE_TRANSACTION_KOBO) {
    throw new GraphQLError(
      `Transaction amount exceeds maximum allowed (₦${koboToNaira(MAX_SINGLE_TRANSACTION_KOBO)})`,
      { extensions: { code: 'AMOUNT_TOO_LARGE' } }
    );
  }

  // Check idempotency
  const existingTransaction = await prisma.walletTransaction.findUnique({
    where: { reference },
  });

  if (existingTransaction) {
    return formatTransaction(existingTransaction);
  }

  // Execute with distributed lock to prevent race conditions (double-spending)
  return withWalletLock(walletId, async () => {
    // Perform atomic debit operation with balance check in same query
    const result = await prisma.$transaction(async (tx) => {
      // ATOMIC: Check balance AND update in a single operation
      // This prevents race conditions where multiple requests pass balance check
      const updateResult = await tx.wallet.updateMany({
        where: { 
          id: walletId,
          isLocked: false, // Ensure wallet is not locked
          balance: { gte: amount }, // Atomic balance check
        },
        data: { 
          balance: { decrement: amount },
          updatedAt: new Date(),
        },
      });

      if (updateResult.count === 0) {
        // Determine why the update failed
        const wallet = await tx.wallet.findUnique({
          where: { id: walletId },
        });

        if (!wallet) {
          throw new GraphQLError('Wallet not found', {
            extensions: { code: 'WALLET_NOT_FOUND' },
          });
        }

        if (wallet.isLocked) {
          const error = new Error(`Wallet locked: ${wallet.lockedReason}`);
          captureWalletError(error, {
            walletId,
            operation: 'debit',
            amount,
          });
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

      // Get updated wallet to record balances
      const updatedWallet = await tx.wallet.findUnique({
        where: { id: walletId },
      });

      if (!updatedWallet) {
        const error = new Error('Wallet state error after debit');
        captureWalletError(error, {
          walletId,
          operation: 'debit',
          amount,
        });
        throw new GraphQLError('Wallet state error', {
          extensions: { code: 'WALLET_ERROR' },
        });
      }

      const balanceAfter = updatedWallet.balance;
      const balanceBefore = balanceAfter + amount;

      // Create transaction record
      const transaction = await tx.walletTransaction.create({
        data: {
          walletId,
          type: 'DEBIT',
          source,
          amount,
          balanceBefore,
          balanceAfter,
          description,
          reference,
          bookingId,
          paymentId,
          withdrawalId,
        },
      });

      return transaction;
    });

    return formatTransaction(result);
  });
};

/**
 * Get wallet transactions with filters
 */
export const getWalletTransactions = async (
  walletId: string,
  filters: WalletTransactionFilters,
  pagination: PaginationInput
) => {
  const { page, limit } = pagination;
  const skip = (page - 1) * limit;

  const where: any = { walletId };

  if (filters.source) {
    where.source = filters.source;
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

  return {
    transactions: transactions.map(formatTransaction),
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
// User-Specific Operations
// ==========================================

/**
 * Process refund to user's wallet
 * Called when a booking is cancelled or dispute is resolved in user's favor
 */
export const processRefundToWallet = async (
  userId: string,
  amountKobo: number,
  bookingId: string,
  paymentId: string,
  reason: string
) => {
  // Check if user is banned - if so, refund should go to original payment method
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (user?.bannedAt && (!user.bannedUntil || user.bannedUntil > new Date())) {
    throw new GraphQLError(
      'User is banned. Refund should be processed to original payment method.',
      { extensions: { code: 'USER_BANNED', suggestBankRefund: true } }
    );
  }

  // Get or create wallet
  const wallet = await getOrCreateWallet(userId);

  // Credit wallet
  const transaction = await creditWallet({
    walletId: wallet.id,
    amount: amountKobo,
    source: 'REFUND',
    description: `Refund: ${reason}`,
    reference: generateReference('RFD'),
    bookingId,
    paymentId,
  });

  return {
    success: true,
    transaction,
    newBalance: transaction.balanceAfter,
    message: `₦${koboToNaira(amountKobo)} has been refunded to your wallet.`,
  };
};

/**
 * Pay for booking using wallet balance
 * Only available for users (SERVICE_USER role)
 */
export const payWithWallet = async (
  userId: string,
  bookingId: string,
  amountKobo: number
) => {
  // Check user restrictions
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    throw new GraphQLError('User not found', {
      extensions: { code: 'USER_NOT_FOUND' },
    });
  }

  // Check if user is restricted
  if (user.restrictedAt && (!user.restrictedUntil || user.restrictedUntil > new Date())) {
    throw new GraphQLError(
      'Your account is restricted. You cannot make payments.',
      { extensions: { code: 'ACCOUNT_RESTRICTED' } }
    );
  }

  // Get wallet
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
  });

  if (!wallet) {
    throw new GraphQLError('Wallet not found. Please add funds first.', {
      extensions: { code: 'WALLET_NOT_FOUND' },
    });
  }

  // Check balance
  if (wallet.balance < amountKobo) {
    const shortfall = amountKobo - wallet.balance;
    throw new GraphQLError(
      `Insufficient wallet balance. You need ₦${koboToNaira(shortfall)} more.`,
      {
        extensions: {
          code: 'INSUFFICIENT_BALANCE',
          available: koboToNaira(wallet.balance),
          required: koboToNaira(amountKobo),
          shortfall: koboToNaira(shortfall),
        },
      }
    );
  }

  // Get booking
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true },
  });

  if (!booking) {
    throw new GraphQLError('Booking not found', {
      extensions: { code: 'BOOKING_NOT_FOUND' },
    });
  }

  if (booking.userId !== userId) {
    throw new GraphQLError('You can only pay for your own bookings', {
      extensions: { code: 'UNAUTHORIZED' },
    });
  }

  if (booking.status !== 'ACCEPTED') {
    throw new GraphQLError('Booking must be accepted before payment', {
      extensions: { code: 'INVALID_BOOKING_STATUS' },
    });
  }

  if (booking.payment?.status === 'COMPLETED') {
    throw new GraphQLError('This booking has already been paid for', {
      extensions: { code: 'ALREADY_PAID' },
    });
  }

  // Process wallet payment in transaction
  const result = await prisma.$transaction(async (tx) => {
    // Debit wallet
    const balanceBefore = wallet.balance;
    const balanceAfter = balanceBefore - amountKobo;

    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: balanceAfter },
    });

    // Create wallet transaction
    const walletTxn = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'DEBIT',
        source: 'BOOKING_PAYMENT',
        amount: amountKobo,
        balanceBefore,
        balanceAfter,
        description: `Payment for booking #${bookingId.substring(0, 8)}`,
        reference: generateReference('PAY'),
        bookingId,
      },
    });

    // Create or update payment record
    const payment = await tx.payment.upsert({
      where: { bookingId },
      create: {
        bookingId,
        amount: koboToNaira(amountKobo),
        commission: booking.commission,
        providerPayout: koboToNaira(amountKobo) - booking.commission,
        status: 'COMPLETED',
        paymentMethod: 'WALLET',
        transactionRef: walletTxn.reference,
        paidAt: new Date(),
        withdrawableAt: new Date(Date.now() + DISPUTE_WINDOW_HOURS * 60 * 60 * 1000),
        walletTransactionId: walletTxn.id,
      },
      update: {
        status: 'COMPLETED',
        paymentMethod: 'WALLET',
        transactionRef: walletTxn.reference,
        paidAt: new Date(),
        withdrawableAt: new Date(Date.now() + DISPUTE_WINDOW_HOURS * 60 * 60 * 1000),
        walletTransactionId: walletTxn.id,
      },
    });

    // Update booking status to IN_PROGRESS
    await tx.booking.update({
      where: { id: bookingId },
      data: { status: 'IN_PROGRESS' },
    });

    return { walletTxn, payment };
  });

  return {
    success: true,
    message: 'Payment successful',
    transaction: formatTransaction(result.walletTxn),
    payment: result.payment,
    newBalance: koboToNaira(result.walletTxn.balanceAfter),
  };
};

// ==========================================
// Provider-Specific Operations
// ==========================================

/**
 * Credit provider's wallet with service earnings
 * Called when payment is completed and service is delivered
 */
export const creditProviderEarnings = async (
  providerId: string,
  amountKobo: number,
  bookingId: string,
  paymentId: string
) => {
  // Get provider's user ID
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: providerId },
    select: { userId: true },
  });

  if (!provider) {
    throw new GraphQLError('Provider not found', {
      extensions: { code: 'PROVIDER_NOT_FOUND' },
    });
  }

  // Get or create wallet
  const wallet = await getOrCreateWallet(provider.userId);

  // Credit wallet
  const transaction = await creditWallet({
    walletId: wallet.id,
    amount: amountKobo,
    source: 'SERVICE_EARNING',
    description: `Earnings from booking #${bookingId.substring(0, 8)}`,
    reference: generateReference('ERN'),
    bookingId,
    paymentId,
  });

  // Update payment to link wallet transaction
  await prisma.payment.update({
    where: { id: paymentId },
    data: { walletTransactionId: transaction.id },
  });

  return {
    success: true,
    transaction,
    newBalance: transaction.balanceAfter,
  };
};

/**
 * Get provider's withdrawable balance
 * Only includes earnings that have passed the dispute window
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
 * Check and unlock stale locks (locks older than 1 hour)
 * Should be called by a background job
 */
export const unlockStaleWallets = async (): Promise<number> => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  
  const result = await prisma.wallet.updateMany({
    where: {
      isLocked: true,
      updatedAt: { lt: oneHourAgo },
    },
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
 * - All adjustments are logged with admin ID and reason
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

  const wallet = await getOrCreateWallet(userId);

  if (type === 'CREDIT') {
    return creditWallet({
      walletId: wallet.id,
      amount: amountKobo,
      source: 'ADMIN_ADJUSTMENT',
      description: `Admin adjustment: ${reason}`,
      reference: generateReference('ADJ'),
      adjustedBy: adminId,
      adjustmentReason: reason,
    });
  } else {
    return debitWallet({
      walletId: wallet.id,
      amount: amountKobo,
      source: 'ADMIN_ADJUSTMENT',
      description: `Admin adjustment: ${reason}`,
      reference: generateReference('ADJ'),
    });
  }
};

/**
 * Get daily withdrawal total for a user
 */
export const getDailyWithdrawalTotal = async (userId: string): Promise<number> => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const result = await prisma.walletTransaction.aggregate({
    where: {
      wallet: { userId },
      type: 'DEBIT',
      source: 'WITHDRAWAL',
      createdAt: { gte: startOfDay },
    },
    _sum: { amount: true },
  });

  return result._sum.amount || 0;
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
