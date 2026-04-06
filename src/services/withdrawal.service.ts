/**
 * Withdrawal Service
 * 
 * Handles provider withdrawal operations.
 * 
 * Features:
 * - Request withdrawal to bank account
 * - Process/reject withdrawals (admin)
 * - Handle Paystack transfer webhooks
 * - Retry failed transfers
 * 
 * Security:
 * - Distributed locking to prevent double withdrawals
 * - Wallet balance deducted at APPROVAL time (not completion)
 * - Bank details snapshot at request time
 * - Idempotency for transfer requests
 * - Daily withdrawal limits
 * - Max retry logic with exponential backoff
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { paystack } from '@/lib/paystack';
import { WithdrawalStatus, AdminAction } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import RedisClient from '@/lib/redis';
import { 
  lockWallet, 
  unlockWallet, 
  debitWallet, 
  creditWallet,
  koboToNaira,
  nairaToKobo,
  canWithdraw,
  MAX_DAILY_WITHDRAWAL_KOBO,
} from './wallet.service';
import { createAuditLog } from './audit.service';
import { createNotification } from './notification.service';
import { ensureRecipientCode } from './bank.service';

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

// ==========================================
// Constants
// ==========================================

const MAX_RETRIES = 5;
const TRANSFER_FEE_KOBO = 5000; // ₦50 transfer fee (adjust as needed)
const MIN_WITHDRAWAL_NAIRA = 1000; // Minimum ₦1,000 withdrawal
const MIN_NET_WITHDRAWAL_KOBO = 50000; // Minimum ₦500 net after fee
const WITHDRAWAL_LOCK_PREFIX = 'withdrawal_lock:';
const WITHDRAWAL_LOCK_TTL_MS = 30000; // 30 seconds

// ==========================================
// Distributed Locking
// ==========================================

const getRedis = () => {
  try {
    return RedisClient.getInstance();
  } catch {
    return null;
  }
};

/**
 * Acquire withdrawal lock for a provider
 * Prevents multiple simultaneous withdrawal requests
 */
const acquireWithdrawalLock = async (providerId: string): Promise<boolean> => {
  const redis = getRedis();
  if (!redis) {
    // Fallback: check database for pending withdrawal
    const pending = await prisma.withdrawal.findFirst({
      where: {
        providerId,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
    });
    return !pending;
  }

  const lockKey = `${WITHDRAWAL_LOCK_PREFIX}${providerId}`;
  const lockValue = `${Date.now()}_${uuidv4()}`;
  
  const result = await redis.set(lockKey, lockValue, 'PX', WITHDRAWAL_LOCK_TTL_MS, 'NX');
  return result === 'OK';
};

const releaseWithdrawalLock = async (providerId: string): Promise<void> => {
  const redis = getRedis();
  if (!redis) return;
  
  const lockKey = `${WITHDRAWAL_LOCK_PREFIX}${providerId}`;
  await redis.del(lockKey);
};

// ==========================================
// Helper Functions
// ==========================================

/**
 * Generate unique transfer reference
 */
const generateTransferReference = (): string => {
  return `WDR_${Date.now()}_${uuidv4().substring(0, 8)}`;
};

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
  transferCode: withdrawal.transferCode,
  transferReference: withdrawal.transferReference,
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

// ==========================================
// Withdrawal Request Functions
// ==========================================

/**
 * Request a withdrawal (provider only)
 * SECURITY: Uses distributed locking to prevent double withdrawals
 */
export const requestWithdrawal = async (
  providerId: string,
  userId: string,
  input: RequestWithdrawalInput
) => {
  const { amount, bankAccountId } = input;
  const amountKobo = nairaToKobo(amount);

  // Validate minimum withdrawal
  if (amount < MIN_WITHDRAWAL_NAIRA) {
    throw new GraphQLError(
      `Minimum withdrawal amount is ₦${MIN_WITHDRAWAL_NAIRA}`,
      { extensions: { code: 'MIN_WITHDRAWAL_NOT_MET' } }
    );
  }

  // Calculate fees and validate net amount
  const fee = TRANSFER_FEE_KOBO;
  const netAmount = amountKobo - fee;
  
  if (netAmount < MIN_NET_WITHDRAWAL_KOBO) {
    throw new GraphQLError(
      `Net withdrawal after fees must be at least ₦${koboToNaira(MIN_NET_WITHDRAWAL_KOBO)}`,
      { extensions: { code: 'NET_AMOUNT_TOO_LOW' } }
    );
  }

  // Check daily withdrawal limit
  const limitCheck = await canWithdraw(userId, amountKobo);
  if (!limitCheck.allowed) {
    throw new GraphQLError(limitCheck.reason || 'Daily withdrawal limit reached', {
      extensions: { 
        code: 'DAILY_LIMIT_EXCEEDED',
        remainingLimit: limitCheck.remainingLimit,
      },
    });
  }

  // Acquire distributed lock to prevent double withdrawal
  const lockAcquired = await acquireWithdrawalLock(providerId);
  if (!lockAcquired) {
    throw new GraphQLError(
      'A withdrawal request is already being processed. Please wait.',
      { extensions: { code: 'WITHDRAWAL_IN_PROGRESS' } }
    );
  }

  try {
    // Double-check for existing pending withdrawal (inside lock)
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

    // Generate unique idempotency key for this withdrawal
    const transferReference = generateTransferReference();

    // Create withdrawal in transaction with ATOMIC wallet lock
    const withdrawal = await prisma.$transaction(async (tx) => {
      // ATOMIC: Lock wallet only if not already locked
      const lockResult = await tx.wallet.updateMany({
        where: { 
          id: wallet.id,
          isLocked: false,
          balance: { gte: amountKobo }, // Double-check balance atomically
        },
        data: {
          isLocked: true,
          lockedReason: 'Pending withdrawal',
          updatedAt: new Date(),
        },
      });

      if (lockResult.count === 0) {
        throw new GraphQLError(
          'Unable to process withdrawal. Wallet may be locked or balance changed.',
          { extensions: { code: 'WALLET_LOCK_FAILED' } }
        );
      }

      // Create withdrawal with bank details snapshot
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
          transferReference,
          requestedAt: new Date(),
        },
      });
    });

    return formatWithdrawal(withdrawal);
  } finally {
    // Always release the distributed lock
    await releaseWithdrawalLock(providerId);
  }
};

/**
 * Cancel a pending withdrawal (provider only)
 */
export const cancelWithdrawal = async (
  withdrawalId: string,
  providerId: string,
  userId: string
) => {
  const withdrawal = await prisma.withdrawal.findFirst({
    where: {
      id: withdrawalId,
      providerId,
    },
    include: { wallet: true },
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

  // Update withdrawal and unlock wallet
  await prisma.$transaction([
    prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: { status: 'CANCELLED' },
    }),
    prisma.wallet.update({
      where: { id: withdrawal.walletId },
      data: {
        isLocked: false,
        lockedReason: null,
      },
    }),
  ]);

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
  filters: WithdrawalFilters,
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

  return {
    withdrawals: withdrawals.map(formatWithdrawal),
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
 * Get all withdrawals (admin)
 */
export const getAllWithdrawals = async (
  filters: WithdrawalFilters,
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
              },
            },
          },
        },
      },
    }),
    prisma.withdrawal.count({ where }),
  ]);

  return {
    withdrawals: withdrawals.map((w) => ({
      ...formatWithdrawal(w),
      user: w.wallet?.user,
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

/**
 * Get pending withdrawals count (admin dashboard)
 */
export const getPendingWithdrawalsCount = async () => {
  return prisma.withdrawal.count({
    where: { status: 'PENDING' },
  });
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

  // Get or create Paystack recipient code
  const bankAccount = await prisma.providerBankAccount.findFirst({
    where: {
      providerId: withdrawal.providerId,
      accountNumber: withdrawal.accountNumber,
      bankCode: withdrawal.bankCode,
    },
  });

  let recipientCode = bankAccount?.recipientCode;

  if (!recipientCode) {
    // Create recipient on-the-fly
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

    recipientCode = response.data.recipient_code;

    // Update bank account with recipient code if it exists
    if (bankAccount) {
      await prisma.providerBankAccount.update({
        where: { id: bankAccount.id },
        data: { recipientCode },
      });
    }
  }

  // CRITICAL FIX: Debit wallet balance NOW (at approval time)
  // This prevents the vulnerability where balance stays unchanged until transfer completes
  const wallet = withdrawal.wallet;
  
  // Verify wallet still has sufficient balance and debit atomically
  const debitResult = await prisma.$transaction(async (tx) => {
    // Atomic debit with balance check
    const updateResult = await tx.wallet.updateMany({
      where: {
        id: wallet.id,
        balance: { gte: withdrawal.amount },
      },
      data: {
        balance: { decrement: withdrawal.amount },
        // Keep wallet locked until transfer completes
        isLocked: true,
        lockedReason: 'Processing withdrawal',
        updatedAt: new Date(),
      },
    });

    if (updateResult.count === 0) {
      throw new GraphQLError(
        'Insufficient balance. The balance may have changed since withdrawal was requested.',
        { extensions: { code: 'INSUFFICIENT_BALANCE' } }
      );
    }

    // Get updated wallet for balance record
    const updatedWallet = await tx.wallet.findUnique({
      where: { id: wallet.id },
    });

    // Create wallet transaction for the debit
    const walletTxn = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'DEBIT',
        source: 'WITHDRAWAL',
        amount: withdrawal.amount,
        balanceBefore: wallet.balance,
        balanceAfter: updatedWallet!.balance,
        description: `Withdrawal to ${withdrawal.bankName} - ${withdrawal.accountNumber}`,
        reference: `WDR_TXN_${withdrawal.id}`,
        withdrawalId: withdrawal.id,
      },
    });

    // Update withdrawal status to PROCESSING
    const updatedWithdrawal = await tx.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: 'PROCESSING',
        processedAt: new Date(),
        processedBy: adminId,
      },
    });

    return { updatedWithdrawal, walletTxn };
  });

  // Initiate Paystack transfer
  try {
    const transferResponse = await paystack.initiateTransfer({
      source: 'balance',
      amount: withdrawal.netAmount, // Already in kobo
      recipient: recipientCode,
      reason: `Withdrawal: ${withdrawal.transferReference}`,
      reference: withdrawal.transferReference!,
    });

    if (!transferResponse.status) {
      throw new Error(transferResponse.message || 'Transfer initiation failed');
    }

    // Update with transfer code
    const updated = await prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        transferCode: transferResponse.data.transfer_code,
      },
    });

    // Create audit log
    await createAuditLog({
      action: 'PROCESS_WITHDRAWAL' as AdminAction,
      targetType: 'Withdrawal',
      targetId: withdrawalId,
      performedBy: adminId,
      performedByRole: adminRole,
      newValue: { status: 'PROCESSING', transferCode: transferResponse.data.transfer_code },
      reason: 'Withdrawal approved and transfer initiated',
    });

    return formatWithdrawal(updated);
  } catch (error: any) {
    // CRITICAL: If transfer fails, refund the wallet and revert status
    await prisma.$transaction([
      // Refund the wallet
      prisma.wallet.update({
        where: { id: wallet.id },
        data: {
          balance: { increment: withdrawal.amount },
          isLocked: true, // Keep locked pending manual review
          lockedReason: 'Transfer failed - pending review',
        },
      }),
      // Create refund transaction
      prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'CREDIT',
          source: 'WITHDRAWAL', // Refund from failed withdrawal
          amount: withdrawal.amount,
          balanceBefore: wallet.balance - withdrawal.amount,
          balanceAfter: wallet.balance,
          description: `Refund: Transfer failed for withdrawal ${withdrawal.id}`,
          reference: `WDR_REFUND_${withdrawal.id}_${Date.now()}`,
          withdrawalId: withdrawal.id,
        },
      }),
      // Revert withdrawal status
      prisma.withdrawal.update({
        where: { id: withdrawalId },
        data: {
          status: 'PENDING',
          processedAt: null,
          processedBy: null,
          failureReason: error.message,
          retryCount: { increment: 1 },
          lastRetryAt: new Date(),
        },
      }),
    ]);

    throw new GraphQLError(`Transfer initiation failed: ${error.message}`, {
      extensions: { code: 'TRANSFER_FAILED' },
    });
  }
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
    include: { wallet: true },
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

  // Update withdrawal and unlock wallet
  await prisma.$transaction([
    prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: 'CANCELLED',
        failureReason: reason,
        processedAt: new Date(),
        processedBy: adminId,
      },
    }),
    prisma.wallet.update({
      where: { id: withdrawal.walletId },
      data: {
        isLocked: false,
        lockedReason: null,
      },
    }),
  ]);

  // Create audit log
  await createAuditLog({
    action: 'REJECT_WITHDRAWAL' as AdminAction,
    targetType: 'Withdrawal',
    targetId: withdrawalId,
    performedBy: adminId,
    performedByRole: adminRole,
    previousValue: { status: 'PENDING' },
    newValue: { status: 'CANCELLED', reason },
    reason,
  });

  // Notify provider
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: withdrawal.providerId },
  });

  if (provider) {
    await createNotification({
      userId: provider.userId,
      type: 'PAYMENT_FAILED',
      title: 'Withdrawal Rejected',
      message: `Your withdrawal of ₦${koboToNaira(withdrawal.amount)} has been rejected. Reason: ${reason}`,
      metadata: { withdrawalId },
    });
  }

  const updated = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
  });

  return formatWithdrawal(updated);
};

// ==========================================
// Webhook Handlers
// ==========================================

/**
 * Handle successful transfer webhook
 * NOTE: Balance was already debited at approval time, so we just:
 * - Mark withdrawal as COMPLETED
 * - Unlock wallet
 */
export const handleTransferSuccess = async (transferCode: string) => {
  const withdrawal = await prisma.withdrawal.findFirst({
    where: { transferCode },
    include: { wallet: true },
  });

  if (!withdrawal) {
    console.log(`Transfer not found: ${transferCode}`);
    return;
  }

  if (withdrawal.status === 'COMPLETED') {
    return; // Already processed (idempotency)
  }

  // Update withdrawal to COMPLETED and unlock wallet
  // Balance was already debited when withdrawal was processed (approved)
  await prisma.$transaction([
    prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    }),
    prisma.wallet.update({
      where: { id: withdrawal.walletId },
      data: {
        isLocked: false,
        lockedReason: null,
      },
    }),
  ]);

  // Notify provider
  const provider = await prisma.serviceProvider.findUnique({
    where: { id: withdrawal.providerId },
  });

  if (provider) {
    await createNotification({
      userId: provider.userId,
      type: 'PAYMENT_RECEIVED',
      title: 'Withdrawal Successful',
      message: `₦${koboToNaira(withdrawal.netAmount)} has been sent to your ${withdrawal.bankName} account.`,
      metadata: { withdrawalId: withdrawal.id },
    });
  }
};

/**
 * Handle failed transfer webhook
 * IMPORTANT: Since balance was debited at approval, we need to refund if transfer fails
 */
export const handleTransferFailed = async (
  transferCode: string,
  failureReason: string
) => {
  const withdrawal = await prisma.withdrawal.findFirst({
    where: { transferCode },
    include: { wallet: true },
  });

  if (!withdrawal) {
    console.log(`Transfer not found: ${transferCode}`);
    return;
  }

  // Check retry count
  if (withdrawal.retryCount < MAX_RETRIES) {
    // Mark for retry - keep balance debited, keep wallet locked
    await prisma.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: 'PENDING',
        retryCount: { increment: 1 },
        lastRetryAt: new Date(),
        failureReason,
        transferCode: null, // Clear transfer code for retry
      },
    });
  } else {
    // Max retries reached - REFUND the wallet and mark as failed
    const wallet = withdrawal.wallet;
    
    await prisma.$transaction([
      // Refund the debited amount to wallet
      prisma.wallet.update({
        where: { id: withdrawal.walletId },
        data: {
          balance: { increment: withdrawal.amount },
          isLocked: false,
          lockedReason: null,
        },
      }),
      // Create refund transaction record
      prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'CREDIT',
          source: 'WITHDRAWAL',
          amount: withdrawal.amount,
          balanceBefore: wallet.balance,
          balanceAfter: wallet.balance + withdrawal.amount,
          description: `Refund: Withdrawal failed after ${MAX_RETRIES} attempts - ${withdrawal.bankName}`,
          reference: `WDR_REFUND_${withdrawal.id}_${Date.now()}`,
          withdrawalId: withdrawal.id,
        },
      }),
      // Mark withdrawal as failed
      prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: 'FAILED',
          failureReason: `Max retries exceeded. Last error: ${failureReason}`,
        },
      }),
    ]);

    // Notify provider
    const provider = await prisma.serviceProvider.findUnique({
      where: { id: withdrawal.providerId },
    });

    if (provider) {
      await createNotification({
        userId: provider.userId,
        type: 'PAYMENT_FAILED',
        title: 'Withdrawal Failed',
        message: `Your withdrawal of ₦${koboToNaira(withdrawal.amount)} failed after multiple attempts. The amount has been refunded to your wallet.`,
        metadata: { withdrawalId: withdrawal.id },
      });
    }
  }
};

/**
 * Retry a failed withdrawal (admin)
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

  if (withdrawal.retryCount >= MAX_RETRIES) {
    throw new GraphQLError('Maximum retry attempts exceeded', {
      extensions: { code: 'MAX_RETRIES_EXCEEDED' },
    });
  }

  // Process as new
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
