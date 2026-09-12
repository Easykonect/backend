/**
 * Bank Service
 *
 * Handles bank account operations for providers.
 *
 * Features:
 * - List Nigerian banks (cached)
 * - Verify bank account (resolve account name), limited per user
 * - Add/remove provider bank accounts
 * - Bank suggestions from the account number's NUBAN check digit
 */

import { GraphQLError } from 'graphql';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import {
  paystack,
  PaystackRequestError,
  type PaystackBank,
  type PaystackBankListResponse,
  type PaystackResolveAccountResponse,
} from '@/lib/paystack';
import RedisClient, { rateLimit } from '@/lib/redis';

// ==========================================
// Types
// ==========================================

interface AddBankAccountInput {
  bankCode: string;
  accountNumber: string;
}

/** What Paystack resolved for an account number and bank */
interface ResolvedAccount {
  accountNumber: string;
  accountName: string;
  bankId: number | null;
}

// ==========================================
// Constants
// ==========================================

const BANK_LIST_CACHE_KEY = 'nigerian_banks';
const BANK_LIST_CACHE_TTL = 86400; // 24 hours

// Account lookups with Paystack allowed per user in any rolling hour
const VERIFY_LIMIT = 5;
const VERIFY_WINDOW_SECONDS = 3600;

// A successful lookup is reused for this long, so a provider can verify an
// account and then add it without a second lookup
const VERIFIED_ACCOUNT_TTL_SECONDS = 15 * 60;

// Paystack answers an account it can't resolve with a 4xx. These statuses are
// about our own integration instead, not the account.
const INTEGRATION_ERROR_STATUSES = new Set([401, 403, 429]);

/**
 * NUBAN check digit weights, applied to the 3-digit bank code followed by the
 * first nine digits of the account number
 */
const NUBAN_WEIGHTS = [3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3];

/**
 * Banks whose account numbers carry a check digit computed with a 3-digit CBN
 * bank code, mapped to the code(s) Paystack's bank list uses for each. They're
 * the same except for Globus and Parallex. Microfinance banks and mobile money
 * operators (e.g. Kuda, OPay, PalmPay, Moniepoint) compute theirs with longer
 * CBN institution codes that Paystack's list doesn't carry, so they're never
 * suggested.
 */
const NUBAN_BANKS: Record<string, string[]> = {
  '011': ['011'], // First Bank of Nigeria
  '023': ['023'], // Citibank Nigeria
  '030': ['030'], // Heritage Bank
  '032': ['032'], // Union Bank of Nigeria
  '033': ['033'], // United Bank for Africa
  '035': ['035'], // Wema Bank
  '044': ['044'], // Access Bank
  '050': ['050'], // Ecobank Nigeria
  '057': ['057'], // Zenith Bank
  '058': ['058'], // Guaranty Trust Bank
  '063': ['063'], // Access Bank (Diamond)
  '068': ['068'], // Standard Chartered Bank
  '070': ['070'], // Fidelity Bank
  '076': ['076'], // Polaris Bank
  '082': ['082'], // Keystone Bank
  '100': ['100'], // SunTrust Bank
  '101': ['101'], // Providus Bank
  '102': ['102'], // Titan Trust Bank
  '103': ['00103'], // Globus Bank
  '104': ['104', '526'], // Parallex Bank, which Paystack has listed as 526
  '105': ['105'], // PremiumTrust Bank
  '106': ['106'], // Signature Bank
  '107': ['107'], // Optimus Bank
  '214': ['214'], // First City Monument Bank
  '215': ['215'], // Unity Bank
  '221': ['221'], // Stanbic IBTC Bank
  '232': ['232'], // Sterling Bank
  '301': ['301'], // Jaiz Bank
  '302': ['302'], // TAJ Bank
  '303': ['303'], // Lotus Bank
};

// ==========================================
// Helper Functions
// ==========================================

/**
 * Format bank for response
 */
const formatBank = (bank: PaystackBank) => ({
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

type Bank = ReturnType<typeof formatBank>;

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

/**
 * Read a cached value. A Redis failure counts as a cache miss.
 */
const readCache = async (key: string): Promise<string | null> => {
  try {
    return await RedisClient.getInstance().get(key);
  } catch (error) {
    console.error('Redis cache error:', error);
    return null;
  }
};

const writeCache = async (key: string, ttlSeconds: number, value: string): Promise<void> => {
  try {
    await RedisClient.getInstance().setex(key, ttlSeconds, value);
  } catch (error) {
    console.error('Redis cache set error:', error);
  }
};

const banksUnavailable = () =>
  new GraphQLError('Failed to fetch banks', {
    extensions: { code: 'PAYSTACK_ERROR' },
  });

// ==========================================
// Bank List Functions
// ==========================================

/**
 * Get list of Nigerian banks (cached)
 */
export const listBanks = async (): Promise<Bank[]> => {
  const cached = await readCache(BANK_LIST_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as Bank[];
    } catch {
      // Fetch a fresh list instead
    }
  }

  let response: PaystackBankListResponse;
  try {
    response = await paystack.listBanks();
  } catch (error) {
    console.error('Failed to fetch banks from Paystack:', error);
    throw banksUnavailable();
  }

  if (!response.status) {
    throw banksUnavailable();
  }

  const banks = response.data.map(formatBank);

  await writeCache(BANK_LIST_CACHE_KEY, BANK_LIST_CACHE_TTL, JSON.stringify(banks));

  return banks;
};

/**
 * Get a specific bank by code
 */
export const getBankByCode = async (bankCode: string) => {
  const banks = await listBanks();
  return banks.find((bank) => bank.code === bankCode) || null;
};

/**
 * Whether a 10-digit account number's check digit is valid for a 3-digit CBN
 * bank code (the NUBAN standard)
 */
export const isValidNuban = (accountNumber: string, cbnBankCode: string): boolean => {
  if (!/^\d{10}$/.test(accountNumber) || !/^\d{3}$/.test(cbnBankCode)) {
    return false;
  }

  const digits = `${cbnBankCode}${accountNumber.slice(0, 9)}`;
  const sum = [...digits].reduce((total, digit, index) => total + Number(digit) * NUBAN_WEIGHTS[index], 0);

  return (10 - (sum % 10)) % 10 === Number(accountNumber[9]);
};

/**
 * Suggest the banks a 10-digit account number can belong to: those whose bank
 * code gives it a valid NUBAN check digit
 */
export const suggestBankFromAccountNumber = async (accountNumber: string) => {
  if (!/^\d{10}$/.test(accountNumber)) {
    return {
      possibleBanks: [],
      confidence: 'NONE',
      message: 'Enter the full 10-digit account number',
    };
  }

  const paystackCodes = new Set(
    Object.entries(NUBAN_BANKS)
      .filter(([cbnCode]) => isValidNuban(accountNumber, cbnCode))
      .flatMap(([, codes]) => codes)
  );

  const possibleBanks =
    paystackCodes.size > 0 ? (await listBanks()).filter((bank) => paystackCodes.has(bank.code)) : [];

  // A check digit only rules banks out, and microfinance banks can't be
  // checked, so confidence is never HIGH
  const confidence = possibleBanks.length === 0 ? 'NONE' : possibleBanks.length === 1 ? 'MEDIUM' : 'LOW';

  return {
    possibleBanks,
    confidence,
    message:
      possibleBanks.length > 0
        ? `Possible bank(s): ${possibleBanks.map((bank) => bank.name).join(', ')}`
        : 'Bank could not be determined from account number',
  };
};

// ==========================================
// Bank Account Verification
// ==========================================

const verificationFailed = () =>
  new GraphQLError('Could not verify this account. Check the account number and bank, then try again.', {
    extensions: { code: 'VERIFICATION_FAILED' },
  });

const verificationUnavailable = () =>
  new GraphQLError('Bank account verification is unavailable right now. Please try again shortly.', {
    extensions: { code: 'PAYSTACK_ERROR' },
  });

const verifiedAccountKey = (userId: string, bankCode: string, accountNumber: string) =>
  `bank_verified:${userId}:${bankCode}:${accountNumber}`;

const isResolvedAccount = (value: unknown): value is ResolvedAccount =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ResolvedAccount).accountNumber === 'string' &&
  typeof (value as ResolvedAccount).accountName === 'string';

const readVerifiedAccount = async (key: string): Promise<ResolvedAccount | null> => {
  const cached = await readCache(key);
  if (!cached) return null;

  try {
    const parsed: unknown = JSON.parse(cached);
    return isResolvedAccount(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Check the account number and bank code before anything is counted
 */
const validateAccountDetails = async (accountNumber: string, bankCode: string) => {
  if (!/^\d{10}$/.test(accountNumber)) {
    throw new GraphQLError('Invalid account number. Must be 10 digits.', {
      extensions: { code: 'INVALID_ACCOUNT_NUMBER' },
    });
  }

  const bank = await getBankByCode(bankCode);
  if (!bank) {
    throw new GraphQLError('Invalid bank code', {
      extensions: { code: 'INVALID_BANK_CODE' },
    });
  }

  return bank;
};

/**
 * Look the account up with Paystack, or reuse this user's lookup of the same
 * account from the last 15 minutes. Only a real lookup counts towards the
 * hourly limit, which is enforced in memory while Redis is unavailable.
 */
const resolveAccount = async (
  userId: string,
  accountNumber: string,
  bankCode: string
): Promise<ResolvedAccount> => {
  const cacheKey = verifiedAccountKey(userId, bankCode, accountNumber);

  const recent = await readVerifiedAccount(cacheKey);
  if (recent) {
    return recent;
  }

  const limit = await rateLimit.check(`bank_verify:${userId}`, VERIFY_LIMIT, VERIFY_WINDOW_SECONDS);
  if (!limit.allowed) {
    throw new GraphQLError('Rate limit exceeded. You can verify up to 5 accounts per hour.', {
      extensions: { code: 'RATE_LIMIT_EXCEEDED', resetIn: limit.resetIn },
    });
  }

  let response: PaystackResolveAccountResponse;
  try {
    response = await paystack.resolveAccount(accountNumber, bankCode);
  } catch (error) {
    const accountRejected =
      error instanceof PaystackRequestError &&
      error.httpStatus !== undefined &&
      error.httpStatus >= 400 &&
      error.httpStatus < 500 &&
      !INTEGRATION_ERROR_STATUSES.has(error.httpStatus);

    if (accountRejected) {
      throw verificationFailed();
    }

    // No answer, a Paystack server error, or a problem with our integration
    console.error('Paystack account lookup failed:', error);
    throw verificationUnavailable();
  }

  if (!response.status || !response.data?.account_name) {
    throw verificationFailed();
  }

  const account: ResolvedAccount = {
    accountNumber: response.data.account_number || accountNumber,
    accountName: response.data.account_name,
    bankId: response.data.bank_id ?? null,
  };

  await writeCache(cacheKey, VERIFIED_ACCOUNT_TTL_SECONDS, JSON.stringify(account));

  return account;
};

/**
 * Verify bank account and resolve account name
 */
export const verifyBankAccount = async (
  userId: string,
  accountNumber: string,
  bankCode: string
) => {
  const bank = await validateAccountDetails(accountNumber, bankCode);
  const account = await resolveAccount(userId, accountNumber, bankCode);

  return {
    ...account,
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

  const bank = await validateAccountDetails(accountNumber, bankCode);

  // Checked before the lookup, so adding an account twice doesn't use a verification
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

  // Reuses a verifyBankAccount lookup of this account from the last 15 minutes
  const verification = await resolveAccount(userId, accountNumber, bankCode);

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
  let bankAccount;
  try {
    bankAccount = await prisma.providerBankAccount.create({
      data: {
        providerId,
        bankCode,
        bankName: bank.name,
        accountNumber,
        accountName: verification.accountName,
        isDefault,
        isVerified: true,
        recipientCode,
      },
    });
  } catch (error) {
    // Two requests adding the same account at once: the unique index stops the second
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new GraphQLError('This bank account is already added', {
        extensions: { code: 'DUPLICATE_ACCOUNT' },
      });
    }
    throw error;
  }

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

  // Only an active payout schedule keeps its account
  const activeSchedule = await prisma.payoutSchedule.findFirst({
    where: { providerId, bankAccountId: accountId, isActive: true },
  });

  if (activeSchedule) {
    throw new GraphQLError(
      'Cannot delete this account. It is set for scheduled payouts.',
      { extensions: { code: 'IN_USE_BY_PAYOUT_SCHEDULE' } }
    );
  }

  await prisma.$transaction([
    // A paused schedule that named this account uses the default account if it's turned back on
    prisma.payoutSchedule.updateMany({
      where: { providerId, bankAccountId: accountId },
      data: { bankAccountId: null },
    }),
    prisma.providerBankAccount.delete({
      where: { id: accountId },
    }),
  ]);

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
