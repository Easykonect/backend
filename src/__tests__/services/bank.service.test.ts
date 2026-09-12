/**
 * Bank service: account verification (the hourly limit, reusing a recent
 * lookup, Paystack failures, a Redis outage), NUBAN bank suggestions and
 * removing an account
 *
 * The real rate limiter from src/lib/redis.ts runs here. Its Redis script
 * always fails, so limits are counted by its in-memory fallback, which is what
 * happens during a Redis outage.
 */

const cache = new Map<string, string>();

const mockRedis = {
  status: 'ready',
  on: jest.fn(),
  script: jest.fn(),
  evalsha: jest.fn(),
  get: jest.fn(),
  setex: jest.fn(),
};

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn(() => mockRedis) }));
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    providerBankAccount: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    withdrawal: { count: jest.fn() },
    payoutSchedule: { findFirst: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('@/lib/paystack', () => ({
  ...jest.requireActual('@/lib/paystack'),
  paystack: {
    listBanks: jest.fn(),
    resolveAccount: jest.fn(),
    createTransferRecipient: jest.fn(),
  },
}));

import prisma from '@/lib/prisma';
import { paystack, PaystackRequestError } from '@/lib/paystack';
import {
  addProviderBankAccount,
  deleteBankAccount,
  isValidNuban,
  suggestBankFromAccountNumber,
  verifyBankAccount,
} from '@/services/bank.service';

const PROVIDER_ID = '66e2b4c1f0a9d83b5c7e1a26';
const ACCOUNT_ID = '66e2b4c1f0a9d83b5c7e1a31';

const bank = (id: number, name: string, code: string) => ({
  id,
  name,
  code,
  slug: name.toLowerCase().replace(/\s+/g, '-'),
  longcode: '',
  gateway: 'emandate',
  active: true,
  country: 'Nigeria',
  currency: 'NGN',
  type: 'nuban',
});

// Paystack's codes: Globus and Parallex differ from their CBN codes, and
// Carbon and Kuda aren't banks with 3-digit CBN codes
const BANKS = [
  bank(1, 'Access Bank', '044'),
  bank(9, 'Guaranty Trust Bank', '058'),
  bank(21, 'Zenith Bank', '057'),
  bank(6, 'Fidelity Bank', '070'),
  bank(4, 'Ecobank Nigeria', '050'),
  bank(70, 'Globus Bank', '00103'),
  bank(112, 'Parallex Bank', '526'),
  bank(302, 'Carbon', '565'),
  bank(67, 'Kuda Bank', '50211'),
];

const resolved = (accountNumber: string) => ({
  status: true,
  message: 'Account number resolved',
  data: { account_number: accountNumber, account_name: 'CHIDINMA ADAEZE OKAFOR', bank_id: 9 },
});

// Five different valid-looking account numbers
const accounts = ['0123456785', '1234567890', '2345678901', '3456789012', '4567890123', '5678901234'];

let userCount = 0;
const newUser = () => `66e2b4c1f0a9d83b5c7e${(++userCount).toString(16).padStart(4, '0')}`;

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);

  cache.clear();
  mockRedis.get.mockReset().mockImplementation(async (key: string) => cache.get(key) ?? null);
  mockRedis.setex.mockReset().mockImplementation(async (key: string, _ttl: number, value: string) => {
    cache.set(key, value);
    return 'OK';
  });
  mockRedis.script.mockReset().mockRejectedValue(new Error('Connection is closed.'));
  mockRedis.evalsha.mockReset().mockRejectedValue(new Error('Connection is closed.'));

  (paystack.listBanks as jest.Mock).mockReset().mockResolvedValue({ status: true, message: 'Banks retrieved', data: BANKS });
  (paystack.resolveAccount as jest.Mock).mockReset().mockImplementation(async (accountNumber: string) => resolved(accountNumber));
  (paystack.createTransferRecipient as jest.Mock)
    .mockReset()
    .mockResolvedValue({ status: true, data: { recipient_code: 'RCP_1' } });

  (prisma.providerBankAccount.findFirst as jest.Mock).mockReset().mockResolvedValue(null);
  (prisma.providerBankAccount.count as jest.Mock).mockReset().mockResolvedValue(0);
  (prisma.providerBankAccount.create as jest.Mock).mockReset().mockImplementation(async ({ data }) => ({
    id: ACCOUNT_ID,
    ...data,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  (prisma.$transaction as jest.Mock).mockReset().mockImplementation(async (operations: unknown[]) => Promise.all(operations));
});

describe('verifyBankAccount', () => {
  it('returns the account name Paystack resolves, with the bank from the list', async () => {
    await expect(verifyBankAccount(newUser(), '0123456785', '058')).resolves.toEqual({
      accountNumber: '0123456785',
      accountName: 'CHIDINMA ADAEZE OKAFOR',
      bankId: 9,
      bankCode: '058',
      bankName: 'Guaranty Trust Bank',
      verified: true,
    });
    expect(paystack.resolveAccount).toHaveBeenCalledWith('0123456785', '058');
  });

  it('allows 5 lookups an hour, then refuses without calling Paystack', async () => {
    const userId = newUser();

    for (const accountNumber of accounts.slice(0, 5)) {
      await expect(verifyBankAccount(userId, accountNumber, '058')).resolves.toMatchObject({ verified: true });
    }

    await expect(verifyBankAccount(userId, accounts[5], '058')).rejects.toMatchObject({
      message: 'Rate limit exceeded. You can verify up to 5 accounts per hour.',
      extensions: { code: 'RATE_LIMIT_EXCEEDED', resetIn: expect.any(Number) },
    });
    expect(paystack.resolveAccount).toHaveBeenCalledTimes(5);

    // Another user has their own limit
    await expect(verifyBankAccount(newUser(), accounts[5], '058')).resolves.toMatchObject({ verified: true });
  });

  it('doesn’t count invalid input towards the limit', async () => {
    const userId = newUser();

    for (let i = 0; i < 6; i++) {
      await expect(verifyBankAccount(userId, '01234', '058')).rejects.toMatchObject({
        extensions: { code: 'INVALID_ACCOUNT_NUMBER' },
      });
      await expect(verifyBankAccount(userId, '0123456785', '999')).rejects.toMatchObject({
        extensions: { code: 'INVALID_BANK_CODE' },
      });
    }

    for (const accountNumber of accounts.slice(0, 5)) {
      await expect(verifyBankAccount(userId, accountNumber, '058')).resolves.toMatchObject({ verified: true });
    }
    expect(paystack.resolveAccount).toHaveBeenCalledTimes(5);
  });

  it('reuses a recent lookup of the same account without calling Paystack or counting it', async () => {
    const userId = newUser();

    for (let i = 0; i < 8; i++) {
      await expect(verifyBankAccount(userId, '0123456785', '058')).resolves.toMatchObject({
        accountName: 'CHIDINMA ADAEZE OKAFOR',
      });
    }

    expect(paystack.resolveAccount).toHaveBeenCalledTimes(1);
    expect(mockRedis.setex).toHaveBeenCalledWith(
      `bank_verified:${userId}:058:0123456785`,
      900,
      JSON.stringify({ accountNumber: '0123456785', accountName: 'CHIDINMA ADAEZE OKAFOR', bankId: 9 })
    );

    // The same number at another bank is a different lookup
    await verifyBankAccount(userId, '0123456785', '057');
    expect(paystack.resolveAccount).toHaveBeenCalledTimes(2);
  });

  it('keeps verifying, with the limit held in memory, while Redis is down', async () => {
    mockRedis.get.mockRejectedValue(new Error('Connection is closed.'));
    mockRedis.setex.mockRejectedValue(new Error('Connection is closed.'));
    const userId = newUser();

    for (const accountNumber of accounts.slice(0, 5)) {
      await expect(verifyBankAccount(userId, accountNumber, '058')).resolves.toMatchObject({ verified: true });
    }

    await expect(verifyBankAccount(userId, accounts[5], '058')).rejects.toMatchObject({
      extensions: { code: 'RATE_LIMIT_EXCEEDED' },
    });
  });

  it.each([
    ['can’t resolve the account (422)', new PaystackRequestError('Paystack request failed: Could not resolve account name. Check parameters or try again.', 422), 'VERIFICATION_FAILED'],
    ['rejects the request (400)', new PaystackRequestError('Paystack request failed: Unknown bank code: 058', 400), 'VERIFICATION_FAILED'],
    ['doesn’t answer', new PaystackRequestError('Paystack request failed: The operation was aborted due to timeout'), 'PAYSTACK_ERROR'],
    ['has a server error (502)', new PaystackRequestError('Paystack request failed: Paystack API error: 502', 502), 'PAYSTACK_ERROR'],
    ['refuses the platform’s key (401)', new PaystackRequestError('Paystack request failed: Invalid key', 401), 'PAYSTACK_ERROR'],
    ['rate limits the platform (429)', new PaystackRequestError('Paystack request failed: Too many requests', 429), 'PAYSTACK_ERROR'],
  ])('when Paystack %s, fails with %p', async (_label, error, code) => {
    (paystack.resolveAccount as jest.Mock).mockRejectedValue(error);
    const userId = newUser();

    const expected =
      code === 'VERIFICATION_FAILED'
        ? 'Could not verify this account. Check the account number and bank, then try again.'
        : 'Bank account verification is unavailable right now. Please try again shortly.';

    await expect(verifyBankAccount(userId, '0123456785', '058')).rejects.toMatchObject({
      message: expected,
      extensions: { code },
    });
    // Nothing is kept, so trying again calls Paystack again
    expect(mockRedis.setex).not.toHaveBeenCalledWith(expect.stringContaining('bank_verified'), expect.anything(), expect.anything());
  });

  it('fails with VERIFICATION_FAILED when Paystack answers without resolving the account', async () => {
    (paystack.resolveAccount as jest.Mock).mockResolvedValue({ status: false, message: 'Could not resolve account name', data: null });

    await expect(verifyBankAccount(newUser(), '0123456785', '058')).rejects.toMatchObject({
      extensions: { code: 'VERIFICATION_FAILED' },
    });
  });

  it('fails with PAYSTACK_ERROR when the bank list can’t be fetched', async () => {
    (paystack.listBanks as jest.Mock).mockRejectedValue(new PaystackRequestError('Paystack request failed: fetch failed'));

    await expect(verifyBankAccount(newUser(), '0123456785', '058')).rejects.toMatchObject({
      message: 'Failed to fetch banks',
      extensions: { code: 'PAYSTACK_ERROR' },
    });
    expect(paystack.resolveAccount).not.toHaveBeenCalled();
  });
});

describe('addProviderBankAccount', () => {
  it('saves an account verified moments before without looking it up or counting it again', async () => {
    const userId = newUser();

    await verifyBankAccount(userId, '0123456785', '058');
    const account = await addProviderBankAccount(PROVIDER_ID, { bankCode: '058', accountNumber: '0123456785' }, userId);

    expect(paystack.resolveAccount).toHaveBeenCalledTimes(1);
    expect(prisma.providerBankAccount.create).toHaveBeenCalledWith({
      data: {
        providerId: PROVIDER_ID,
        bankCode: '058',
        bankName: 'Guaranty Trust Bank',
        accountNumber: '0123456785',
        accountName: 'CHIDINMA ADAEZE OKAFOR',
        isDefault: true,
        isVerified: true,
        recipientCode: 'RCP_1',
      },
    });
    expect(account).toMatchObject({ id: ACCOUNT_ID, isDefault: true, isVerified: true });

    // Verifying and adding used one lookup, so four more are allowed
    for (const accountNumber of accounts.slice(1, 5)) {
      await expect(verifyBankAccount(userId, accountNumber, '058')).resolves.toMatchObject({ verified: true });
    }
    await expect(verifyBankAccount(userId, accounts[5], '058')).rejects.toMatchObject({
      extensions: { code: 'RATE_LIMIT_EXCEEDED' },
    });
  });

  it('refuses an account the provider already saved before looking it up', async () => {
    (prisma.providerBankAccount.findFirst as jest.Mock).mockResolvedValue({ id: ACCOUNT_ID });

    await expect(
      addProviderBankAccount(PROVIDER_ID, { bankCode: '058', accountNumber: '0123456785' }, newUser())
    ).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_ACCOUNT' } });

    expect(paystack.resolveAccount).not.toHaveBeenCalled();
    expect(prisma.providerBankAccount.create).not.toHaveBeenCalled();
  });

  it('answers DUPLICATE_ACCOUNT when the same account is added twice at once', async () => {
    const { Prisma } = jest.requireActual<typeof import('@prisma/client')>('@prisma/client');
    (prisma.providerBankAccount.create as jest.Mock).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.22.0' })
    );

    await expect(
      addProviderBankAccount(PROVIDER_ID, { bankCode: '058', accountNumber: '0123456785' }, newUser())
    ).rejects.toMatchObject({
      message: 'This bank account is already added',
      extensions: { code: 'DUPLICATE_ACCOUNT' },
    });
  });
});

describe('isValidNuban', () => {
  it.each([
    ['0123456785', '058', true],
    ['0123456785', '057', false],
    ['0123456782', '103', true],
    ['012345678', '058', false],
    ['0123456785', '58', false],
  ])('%s at bank code %s is %p', (accountNumber, code, valid) => {
    expect(isValidNuban(accountNumber, code)).toBe(valid);
  });
});

describe('suggestBankFromAccountNumber', () => {
  const names = (result: { possibleBanks: { name: string }[] }) => result.possibleBanks.map((b) => b.name);

  it.each([
    // Also valid for Titan Trust (102), which isn't in the list
    ['0123456785', ['Guaranty Trust Bank', 'Fidelity Bank'], 'LOW'],
    // Globus's CBN code is 103; Paystack lists it as 00103. Carbon's 565 would
    // pass the check digit too, but it isn't a bank with a 3-digit CBN code.
    ['0123456782', ['Globus Bank'], 'MEDIUM'],
    // Parallex's CBN code is 104; this Paystack list has it as 526
    ['0123456789', ['Ecobank Nigeria', 'Parallex Bank'], 'LOW'],
    // Only valid for Optimus (107), which isn't in the list
    ['0123456780', [], 'NONE'],
  ])('suggests the listed banks %s is valid for', async (accountNumber, expected, confidence) => {
    const result = await suggestBankFromAccountNumber(accountNumber);

    expect(names(result)).toEqual(expected);
    expect(result.confidence).toBe(confidence);
  });

  it.each([['012345678'], ['01234567851'], ['01234a6785'], ['']])(
    'returns NONE for %p without fetching the bank list',
    async (accountNumber) => {
      await expect(suggestBankFromAccountNumber(accountNumber)).resolves.toMatchObject({
        possibleBanks: [],
        confidence: 'NONE',
      });
      expect(paystack.listBanks).not.toHaveBeenCalled();
    }
  );
});

describe('deleteBankAccount', () => {
  beforeEach(() => {
    (prisma.providerBankAccount.findFirst as jest.Mock).mockResolvedValue({
      id: ACCOUNT_ID,
      providerId: PROVIDER_ID,
      accountNumber: '0123456785',
      bankCode: '058',
      isDefault: false,
    });
    (prisma.withdrawal.count as jest.Mock).mockReset().mockResolvedValue(0);
    (prisma.payoutSchedule.findFirst as jest.Mock).mockReset().mockResolvedValue(null);
    (prisma.payoutSchedule.updateMany as jest.Mock).mockReset().mockResolvedValue({ count: 1 });
    (prisma.providerBankAccount.delete as jest.Mock).mockReset().mockResolvedValue({ id: ACCOUNT_ID });
  });

  it('removes an account a paused schedule names, and takes it off the schedule', async () => {
    await expect(deleteBankAccount(ACCOUNT_ID, PROVIDER_ID)).resolves.toMatchObject({ success: true });

    expect(prisma.payoutSchedule.findFirst).toHaveBeenCalledWith({
      where: { providerId: PROVIDER_ID, bankAccountId: ACCOUNT_ID, isActive: true },
    });
    expect(prisma.payoutSchedule.updateMany).toHaveBeenCalledWith({
      where: { providerId: PROVIDER_ID, bankAccountId: ACCOUNT_ID },
      data: { bankAccountId: null },
    });
    expect(prisma.providerBankAccount.delete).toHaveBeenCalledWith({ where: { id: ACCOUNT_ID } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('refuses while an active schedule names the account', async () => {
    (prisma.payoutSchedule.findFirst as jest.Mock).mockResolvedValue({ id: 'schedule1', isActive: true });

    await expect(deleteBankAccount(ACCOUNT_ID, PROVIDER_ID)).rejects.toMatchObject({
      message: 'Cannot delete this account. It is set for scheduled payouts.',
      extensions: { code: 'IN_USE_BY_PAYOUT_SCHEDULE' },
    });

    expect(prisma.providerBankAccount.delete).not.toHaveBeenCalled();
    expect(prisma.payoutSchedule.updateMany).not.toHaveBeenCalled();
  });
});
