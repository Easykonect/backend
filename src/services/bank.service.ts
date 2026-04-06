/**
 * Bank Service
 * 
 * Handles bank account operations for providers.
 * 
 * Features:
 * - List Nigerian banks (cached)
 * - Verify bank account (resolve account name)
 * - Add/remove provider bank accounts
 * - Bank suggestion based on account number prefix
 */

import { GraphQLError } from 'graphql';
import prisma from '@/lib/prisma';
import { paystack } from '@/lib/paystack';
import RedisClient from '@/lib/redis';

// Get Redis client instance
const getRedis = () => {
  try {
    return RedisClient.getInstance();
  } catch {
    return null;
  }
};

// ==========================================
// Types
// ==========================================

interface AddBankAccountInput {
  bankCode: string;
  accountNumber: string;
}

interface PaginationInput {
  page: number;
  limit: number;
}

// ==========================================
// Constants
// ==========================================

const BANK_LIST_CACHE_KEY = 'nigerian_banks';
const BANK_LIST_CACHE_TTL = 86400; // 24 hours
const RATE_LIMIT_PREFIX = 'rate_limit:bank_verify:';
const RATE_LIMIT_MAX = 5; // 5 verifications per hour
const RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds

// Known bank account number prefixes (partial, not comprehensive)
const BANK_PREFIXES: Record<string, string[]> = {
  '044': ['Access Bank'],
  '063': ['Access Bank (Diamond)'],
  '050': ['Ecobank'],
  '070': ['Fidelity Bank'],
  '011': ['First Bank'],
  '214': ['First City Monument Bank'],
  '058': ['Guaranty Trust Bank'],
  '030': ['Heritage Bank'],
  '301': ['Jaiz Bank'],
  '082': ['Keystone Bank'],
  '526': ['Parallex Bank'],
  '076': ['Polaris Bank'],
  '101': ['Providus Bank'],
  '221': ['Stanbic IBTC'],
  '068': ['Standard Chartered'],
  '232': ['Sterling Bank'],
  '100': ['Suntrust Bank'],
  '032': ['Union Bank'],
  '033': ['United Bank for Africa'],
  '215': ['Unity Bank'],
  '035': ['Wema Bank'],
  '057': ['Zenith Bank'],
};

// ==========================================
// Helper Functions
// ==========================================

/**
 * Format bank for response
 */
const formatBank = (bank: any) => ({
  id: bank.id?.toString() || bank.code,
  name: bank.name,
  code: bank.code,
  slug: bank.slug,
  longcode: bank.longcode,
  gateway: bank.gateway,
  active: bank.active,
  country: bank.country,
  currency: bank.currency,
  type: bank.type,
});

/**
 * Format provider bank account for response
 */
const formatBankAccount = (account: any) => ({
  id: account.id,
  providerId: account.providerId,
  bankCode: account.bankCode,
  bankName: account.bankName,
  accountNumber: account.accountNumber,
  accountName: account.accountName,
  isDefault: account.isDefault,
  isVerified: account.isVerified,
  recipientCode: account.recipientCode,
  createdAt: account.createdAt.toISOString(),
  updatedAt: account.updatedAt.toISOString(),
});

// ==========================================
// Bank List Functions
// ==========================================

/**
 * Get list of Nigerian banks (cached)
 */
export const listBanks = async () => {
  const redis = getRedis();
  
  // Try to get from cache first
  if (redis) {
    try {
      const cached = await redis.get(BANK_LIST_CACHE_KEY);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      console.error('Redis cache error:', error);
    }
  }

  // Fetch from Paystack
  const response = await paystack.listBanks();

  if (!response.status) {
    throw new GraphQLError('Failed to fetch banks', {
      extensions: { code: 'PAYSTACK_ERROR' },
    });
  }

  const banks = response.data.map(formatBank);

  // Cache the result
  if (redis) {
    try {
      await redis.setex(BANK_LIST_CACHE_KEY, BANK_LIST_CACHE_TTL, JSON.stringify(banks));
    } catch (error) {
      console.error('Redis cache set error:', error);
    }
  }

  return banks;
};

/**
 * Get a specific bank by code
 */
export const getBankByCode = async (bankCode: string) => {
  const banks = await listBanks();
  return banks.find((bank: any) => bank.code === bankCode) || null;
};

/**
 * Suggest bank(s) based on account number prefix
 * Note: This is a heuristic and not always accurate
 */
export const suggestBankFromAccountNumber = (accountNumber: string) => {
  if (accountNumber.length < 3) {
    return {
      suggestions: [],
      message: 'Please enter at least 3 digits',
    };
  }

  const prefix = accountNumber.substring(0, 3);
  const suggestions = BANK_PREFIXES[prefix] || [];

  return {
    prefix,
    suggestions,
    message: suggestions.length > 0
      ? `Possible bank(s): ${suggestions.join(', ')}`
      : 'Bank could not be determined from account number',
  };
};

// ==========================================
// Bank Account Verification
// ==========================================

// Track rate limit failures for fallback
let rateLimitFailureCount = 0;
const MAX_RATE_LIMIT_FAILURES = 10;

/**
 * Check rate limit for bank verification
 * SECURITY FIX: Fail CLOSED when Redis unavailable (after grace period)
 */
const checkRateLimit = async (userId: string): Promise<boolean> => {
  const redis = getRedis();
  
  if (!redis) {
    // Fail CLOSED after too many failures - prevent API abuse
    rateLimitFailureCount++;
    if (rateLimitFailureCount > MAX_RATE_LIMIT_FAILURES) {
      console.error('Rate limiting disabled due to Redis unavailability - blocking requests');
      return false;
    }
    console.warn(`Redis unavailable for rate limiting (failure ${rateLimitFailureCount}/${MAX_RATE_LIMIT_FAILURES})`);
    return true; // Allow during grace period
  }

  // Reset failure count when Redis is available
  rateLimitFailureCount = 0;

  const key = `${RATE_LIMIT_PREFIX}${userId}`;
  
  try {
    const count = await redis.incr(key);
    
    if (count === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW);
    }
    
    return count <= RATE_LIMIT_MAX;
  } catch (error) {
    console.error('Rate limit check error:', error);
    // FAIL CLOSED on Redis error - security over convenience
    return false;
  }
};

/**
 * Verify bank account and resolve account name
 * Rate limited to prevent API abuse
 */
export const verifyBankAccount = async (
  userId: string,
  accountNumber: string,
  bankCode: string
) => {
  // Check rate limit
  const allowed = await checkRateLimit(userId);
  if (!allowed) {
    throw new GraphQLError(
      'Rate limit exceeded. You can verify up to 5 accounts per hour.',
      { extensions: { code: 'RATE_LIMIT_EXCEEDED' } }
    );
  }

  // Validate account number format (10 digits for Nigerian banks)
  if (!/^\d{10}$/.test(accountNumber)) {
    throw new GraphQLError('Invalid account number. Must be 10 digits.', {
      extensions: { code: 'INVALID_ACCOUNT_NUMBER' },
    });
  }

  // Verify bank code exists
  const bank = await getBankByCode(bankCode);
  if (!bank) {
    throw new GraphQLError('Invalid bank code', {
      extensions: { code: 'INVALID_BANK_CODE' },
    });
  }

  // Call Paystack to resolve account
  const response = await paystack.resolveAccount(accountNumber, bankCode);

  if (!response.status) {
    throw new GraphQLError(
      response.message || 'Could not verify account. Please check the details.',
      { extensions: { code: 'VERIFICATION_FAILED' } }
    );
  }

  return {
    accountNumber: response.data.account_number,
    accountName: response.data.account_name,
    bankCode,
    bankName: bank.name,
    verified: true,
  };
};

// ==========================================
// Provider Bank Account Management
// ==========================================

/**
 * Add a bank account for a provider
 */
export const addProviderBankAccount = async (
  providerId: string,
  input: AddBankAccountInput,
  userId: string
) => {
  const { bankCode, accountNumber } = input;

  // Verify the account first
  const verification = await verifyBankAccount(userId, accountNumber, bankCode);

  // Check if account already exists for this provider
  const existing = await prisma.providerBankAccount.findFirst({
    where: {
      providerId,
      accountNumber,
      bankCode,
    },
  });

  if (existing) {
    throw new GraphQLError('This bank account is already added', {
      extensions: { code: 'DUPLICATE_ACCOUNT' },
    });
  }

  // Check if this is the first account (make it default)
  const accountCount = await prisma.providerBankAccount.count({
    where: { providerId },
  });

  const isDefault = accountCount === 0;

  // Create transfer recipient on Paystack
  let recipientCode: string | null = null;
  try {
    const recipientResponse = await paystack.createTransferRecipient({
      type: 'nuban',
      name: verification.accountName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: 'NGN',
    });
    
    if (recipientResponse.status) {
      recipientCode = recipientResponse.data.recipient_code;
    }
  } catch (error) {
    console.error('Failed to create Paystack recipient:', error);
    // Continue without recipient code - can be created later
  }

  // Create bank account record
  const bankAccount = await prisma.providerBankAccount.create({
    data: {
      providerId,
      bankCode,
      bankName: verification.bankName,
      accountNumber,
      accountName: verification.accountName,
      isDefault,
      isVerified: true,
      recipientCode,
    },
  });

  return formatBankAccount(bankAccount);
};

/**
 * Get all bank accounts for a provider
 */
export const getProviderBankAccounts = async (providerId: string) => {
  const accounts = await prisma.providerBankAccount.findMany({
    where: { providerId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });

  return accounts.map(formatBankAccount);
};

/**
 * Get a specific bank account
 */
export const getBankAccountById = async (accountId: string, providerId: string) => {
  const account = await prisma.providerBankAccount.findFirst({
    where: {
      id: accountId,
      providerId,
    },
  });

  if (!account) {
    throw new GraphQLError('Bank account not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  return formatBankAccount(account);
};

/**
 * Set a bank account as default
 */
export const setDefaultBankAccount = async (accountId: string, providerId: string) => {
  // Verify account belongs to provider
  const account = await prisma.providerBankAccount.findFirst({
    where: {
      id: accountId,
      providerId,
    },
  });

  if (!account) {
    throw new GraphQLError('Bank account not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Update in transaction
  await prisma.$transaction([
    // Remove default from all accounts
    prisma.providerBankAccount.updateMany({
      where: { providerId },
      data: { isDefault: false },
    }),
    // Set new default
    prisma.providerBankAccount.update({
      where: { id: accountId },
      data: { isDefault: true },
    }),
  ]);

  // Return updated account
  const updated = await prisma.providerBankAccount.findUnique({
    where: { id: accountId },
  });

  return formatBankAccount(updated);
};

/**
 * Delete a bank account
 */
export const deleteBankAccount = async (accountId: string, providerId: string) => {
  // Verify account belongs to provider
  const account = await prisma.providerBankAccount.findFirst({
    where: {
      id: accountId,
      providerId,
    },
  });

  if (!account) {
    throw new GraphQLError('Bank account not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  // Check if there are pending withdrawals using this account
  const pendingWithdrawals = await prisma.withdrawal.count({
    where: {
      providerId,
      accountNumber: account.accountNumber,
      bankCode: account.bankCode,
      status: { in: ['PENDING', 'PROCESSING'] },
    },
  });

  if (pendingWithdrawals > 0) {
    throw new GraphQLError(
      'Cannot delete this account. There are pending withdrawals.',
      { extensions: { code: 'PENDING_WITHDRAWALS' } }
    );
  }

  // Check if it's used in payout schedule
  const payoutSchedule = await prisma.payoutSchedule.findUnique({
    where: { providerId },
  });

  if (payoutSchedule?.bankAccountId === accountId) {
    throw new GraphQLError(
      'Cannot delete this account. It is set for scheduled payouts.',
      { extensions: { code: 'IN_USE_BY_PAYOUT_SCHEDULE' } }
    );
  }

  // Delete the account
  await prisma.providerBankAccount.delete({
    where: { id: accountId },
  });

  // If this was the default, set another account as default
  if (account.isDefault) {
    const remainingAccounts = await prisma.providerBankAccount.findMany({
      where: { providerId },
      orderBy: { createdAt: 'asc' },
      take: 1,
    });

    if (remainingAccounts.length > 0) {
      await prisma.providerBankAccount.update({
        where: { id: remainingAccounts[0].id },
        data: { isDefault: true },
      });
    }
  }

  return {
    success: true,
    message: 'Bank account deleted successfully',
  };
};

/**
 * Get provider's default bank account
 */
export const getDefaultBankAccount = async (providerId: string) => {
  const account = await prisma.providerBankAccount.findFirst({
    where: {
      providerId,
      isDefault: true,
    },
  });

  return account ? formatBankAccount(account) : null;
};

/**
 * Ensure provider has Paystack recipient code
 * Creates one if missing (for older accounts)
 */
export const ensureRecipientCode = async (accountId: string) => {
  const account = await prisma.providerBankAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    throw new GraphQLError('Bank account not found', {
      extensions: { code: 'NOT_FOUND' },
    });
  }

  if (account.recipientCode) {
    return account.recipientCode;
  }

  // Create recipient on Paystack
  const response = await paystack.createTransferRecipient({
    type: 'nuban',
    name: account.accountName,
    account_number: account.accountNumber,
    bank_code: account.bankCode,
    currency: 'NGN',
  });

  if (!response.status) {
    throw new GraphQLError('Failed to create transfer recipient', {
      extensions: { code: 'PAYSTACK_ERROR' },
    });
  }

  // Update account with recipient code
  await prisma.providerBankAccount.update({
    where: { id: accountId },
    data: { recipientCode: response.data.recipient_code },
  });

  return response.data.recipient_code;
};
