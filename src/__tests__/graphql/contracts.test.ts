/**
 * GraphQL contract tests
 *
 * Runs real operations through the executable schema (type definitions,
 * resolvers and services) with only the database, Redis and Paystack mocked,
 * so a resolver that returns the wrong shape fails here instead of in the app.
 */

import { graphql, type ExecutionResult } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';

jest.mock('@/lib/prisma', () => {
  const model = () => ({
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  });
  const client = {
    user: model(),
    wallet: model(),
    walletTransaction: model(),
    withdrawal: model(),
    serviceProvider: model(),
    providerBankAccount: model(),
    payment: model(),
    scheduledPayout: model(),
    payoutSchedule: model(),
    userSettings: model(),
    notification: model(),
    adminAuditLog: model(),
    providerLike: model(),
    review: model(),
    service: model(),
    booking: model(),
    dispute: model(),
    platformSettings: model(),
    userBlock: model(),
    report: model(),
    conversation: model(),
    message: model(),
    $transaction: jest.fn(),
  };
  client.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(client) : Promise.all(arg as unknown[])
  );
  return { __esModule: true, default: client };
});

// The Resend client throws at import time without an API key
jest.mock('@/lib/email', () => ({ __esModule: true, default: {} }));

jest.mock('@/lib/redis', () => {
  const client = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(0),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  };
  return {
    __esModule: true,
    default: { getInstance: () => client, connect: async () => client },
    rateLimit: { check: jest.fn().mockResolvedValue({ allowed: true, remaining: 1, resetIn: 1 }) },
  };
});

jest.mock('@/lib/paystack', () => ({
  ...jest.requireActual('@/lib/paystack'),
  paystack: { listBanks: jest.fn() },
}));

import prisma from '@/lib/prisma';
import { paystack } from '@/lib/paystack';
import { typeDefs, resolvers } from '@/graphql';

const schema = makeExecutableSchema({ typeDefs, resolvers });
const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

type Viewer = { userId: string; role: string };

const run = (source: string, viewer: Viewer | null): Promise<ExecutionResult> =>
  graphql({
    schema,
    source,
    contextValue: { user: viewer && { ...viewer, email: `${viewer.userId}@example.com` } },
  }) as Promise<ExecutionResult>;

const expectNoErrors = (result: ExecutionResult) => {
  expect(result.errors).toBeUndefined();
  return result.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const provider: Viewer = { userId: '66e2a0c0f0a9d83b5c7e0001', role: 'SERVICE_PROVIDER' };
const superAdmin: Viewer = { userId: '66e2a0c0f0a9d83b5c7e0004', role: 'SUPER_ADMIN' };

const now = new Date('2026-09-12T10:00:00Z');

const walletRecord = {
  id: '66e2a0c0f0a9d83b5c7e0003',
  userId: '66e2a0c0f0a9d83b5c7e0001',
  balance: 558_000,
  pendingBalance: 0,
  currency: 'NGN',
  isLocked: true,
  lockedReason: 'Pending withdrawal',
  createdAt: now,
  updatedAt: now,
};

const providerRecord = { id: '66e2a0c0f0a9d83b5c7e0002', userId: '66e2a0c0f0a9d83b5c7e0001' };

const withdrawalRecord = {
  id: '66e2a0c0f0a9d83b5c7e000a',
  walletId: '66e2a0c0f0a9d83b5c7e0003',
  providerId: '66e2a0c0f0a9d83b5c7e0002',
  amount: 300_000,
  fee: 5_000,
  netAmount: 295_000,
  status: 'PENDING',
  bankCode: '058',
  bankName: 'Guaranty Trust Bank',
  accountNumber: '0123456789',
  accountName: 'ADA OBI',
  transferCode: null,
  transferReference: 'WDR_1',
  requestedAt: now,
  processedAt: null,
  completedAt: null,
  failureReason: null,
  retryCount: 0,
  lastRetryAt: null,
  processedBy: null,
  createdAt: now,
  updatedAt: now,
};

beforeEach(() => {
  db.serviceProvider.findUnique.mockResolvedValue(providerRecord);
});

describe('platform settings', () => {
  const admin: Viewer = { userId: '66e2a0c0f0a9d83b5c7e0008', role: 'ADMIN' };

  beforeEach(() => {
    db.platformSettings.upsert.mockClear();
  });

  it('platformSettings shows admins the starting commission rate until one is set', async () => {
    db.platformSettings.findUnique.mockResolvedValue(null);

    const data = expectNoErrors(await run('{ platformSettings { commissionRate updatedAt updatedBy } }', admin));

    expect(data.platformSettings).toEqual({ commissionRate: 7, updatedAt: null, updatedBy: null });
  });

  it('updateCommissionRate lets a Super Admin set the rate for new bookings', async () => {
    db.platformSettings.findUnique.mockResolvedValue({ commissionRate: 0.07 });
    db.platformSettings.upsert.mockResolvedValue({
      id: '66e2a0c0f0a9d83b5c7e0017',
      key: 'platform',
      commissionRate: 0.125,
      updatedBy: superAdmin.userId,
      createdAt: now,
      updatedAt: now,
    });
    db.adminAuditLog.create.mockResolvedValue({ id: '66e2a0c0f0a9d83b5c7e0010' });

    const data = expectNoErrors(
      await run('mutation { updateCommissionRate(rate: 12.5) { commissionRate updatedAt updatedBy } }', superAdmin)
    );

    expect(data.updateCommissionRate).toEqual({
      commissionRate: 12.5,
      updatedAt: now.toISOString(),
      updatedBy: superAdmin.userId,
    });
    expect(db.platformSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { commissionRate: 0.125, updatedBy: superAdmin.userId } })
    );
  });

  it('updateCommissionRate is refused for an Admin', async () => {
    const result = await run('mutation { updateCommissionRate(rate: 12.5) { commissionRate } }', admin);

    expect(result.errors).toBeDefined();
    expect(db.platformSettings.upsert).not.toHaveBeenCalled();
  });
});

describe('wallet', () => {
  it('myWallet returns the lock reason', async () => {
    db.wallet.findUnique.mockResolvedValue(walletRecord);
    // The provider's share of paid bookings still held in escrow
    db.payment.aggregate.mockResolvedValueOnce({ _sum: { providerPayout: 13_950 } });

    const data = expectNoErrors(await run(
      '{ myWallet { id balance pendingBalance isLocked lockReason createdAt updatedAt } }',
      provider
    ));

    expect(data.myWallet).toMatchObject({ balance: 5580, pendingBalance: 13950, isLocked: true, lockReason: 'Pending withdrawal' });
  });

  it('myWalletTransactions reads the caller’s wallet', async () => {
    db.wallet.findUnique.mockResolvedValue(walletRecord);
    db.walletTransaction.findMany.mockResolvedValue([
      {
        id: '66e2a0c0f0a9d83b5c7e0015',
        walletId: '66e2a0c0f0a9d83b5c7e0003',
        type: 'CREDIT',
        source: 'SERVICE_EARNING',
        amount: 558_000,
        balanceBefore: 0,
        balanceAfter: 558_000,
        description: 'Earnings from booking',
        reference: 'ERN_1',
        createdAt: now,
      },
    ]);
    db.walletTransaction.count.mockResolvedValue(1);

    const data = expectNoErrors(await run(
      `{ myWalletTransactions {
          items { id type source amount balanceAfter description referenceId createdAt }
          total page totalPages hasNextPage
      } }`,
      provider
    ));

    expect(data.myWalletTransactions.items[0]).toMatchObject({ source: 'SERVICE_EARNING', amount: 5580 });
    expect(db.walletTransaction.findMany.mock.calls[0][0].where.walletId).toBe('66e2a0c0f0a9d83b5c7e0003');
  });

  it('adjustWalletBalance credits in a transaction, writes an audit log and returns the updated wallet', async () => {
    const adjusted = { ...walletRecord, balance: 559_999 };
    // Only an existing customer or provider account can be adjusted
    db.user.findUnique.mockResolvedValueOnce({ id: '66e2a0c0f0a9d83b5c7e0001', role: 'SERVICE_PROVIDER' });
    db.payment.aggregate.mockResolvedValueOnce({ _sum: { providerPayout: null } });
    db.wallet.findUnique
      .mockResolvedValueOnce(walletRecord) // before the adjustment
      .mockResolvedValueOnce(adjusted); // returned by the mutation
    db.walletTransaction.findUnique.mockResolvedValue(null);
    db.wallet.update.mockResolvedValue(adjusted);
    db.walletTransaction.create.mockResolvedValue({
      id: '66e2a0c0f0a9d83b5c7e0014',
      walletId: '66e2a0c0f0a9d83b5c7e0003',
      type: 'CREDIT',
      source: 'ADMIN_ADJUSTMENT',
      amount: 1_999,
      balanceBefore: 558_000,
      balanceAfter: 559_999,
      description: 'Admin adjustment',
      reference: 'ADJ_1',
      createdAt: now,
    });
    db.adminAuditLog.create.mockResolvedValue({
      id: '66e2a0c0f0a9d83b5c7e001b',
      action: 'ADJUST_WALLET',
      targetType: 'Wallet',
      targetId: '66e2a0c0f0a9d83b5c7e0003',
      performedBy: '66e2a0c0f0a9d83b5c7e0004',
      performedByRole: 'SUPER_ADMIN',
      previousValue: null,
      newValue: null,
      reason: 'Correction for booking 6a7cecc0',
      createdAt: now,
    });

    const data = expectNoErrors(await run(
      `mutation { adjustWalletBalance(userId: "66e2a0c0f0a9d83b5c7e0001", amount: 19.99, reason: "Correction for booking 6a7cecc0") {
          id balance isLocked lockReason
      } }`,
      superAdmin
    ));

    expect(data.adjustWalletBalance).toMatchObject({ id: '66e2a0c0f0a9d83b5c7e0003', balance: 5599.99 });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: '66e2a0c0f0a9d83b5c7e0003' }, data: { balance: { increment: 1_999 } } });
    expect(db.walletTransaction.create.mock.calls[0][0].data).toMatchObject({
      type: 'CREDIT',
      source: 'ADMIN_ADJUSTMENT',
      amount: 1_999,
      balanceBefore: 558_000,
      balanceAfter: 559_999,
      adjustedBy: '66e2a0c0f0a9d83b5c7e0004',
    });
    expect(db.adminAuditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'ADJUST_WALLET',
      targetType: 'Wallet',
      targetId: '66e2a0c0f0a9d83b5c7e0003',
      performedBy: '66e2a0c0f0a9d83b5c7e0004',
    });
  });
});

describe('withdrawals', () => {
  it('myWithdrawals and withdrawal(id) return the bank snapshot', async () => {
    db.withdrawal.findMany.mockResolvedValue([withdrawalRecord]);
    db.withdrawal.count.mockResolvedValue(1);
    db.withdrawal.findFirst.mockResolvedValue(withdrawalRecord);

    const list = expectNoErrors(await run(
      `{ myWithdrawals {
          items { id amount fee netAmount status bankAccountSnapshot { bankName accountNumber } transferRef retryCount createdAt updatedAt }
          total page totalPages hasNextPage
      } }`,
      provider
    ));
    const single = expectNoErrors(await run(
      '{ withdrawal(id: "66e2a0c0f0a9d83b5c7e000a") { id amount bankAccountSnapshot { bankCode } } }',
      provider
    ));

    expect(list.myWithdrawals.items[0]).toMatchObject({ amount: 3000, transferRef: 'WDR_1' });
    expect(single.withdrawal).toMatchObject({ amount: 3000, bankAccountSnapshot: { bankCode: '058' } });
  });

  it('pendingWithdrawals works for admins', async () => {
    db.withdrawal.findMany.mockResolvedValue([
      { ...withdrawalRecord, wallet: { user: { id: '66e2a0c0f0a9d83b5c7e0001', email: 'p@example.com', firstName: 'Ada', lastName: 'Obi' } } },
    ]);
    db.withdrawal.count.mockResolvedValue(1);

    const data = expectNoErrors(await run(
      '{ pendingWithdrawals { items { id amount status bankAccountSnapshot { accountName } } total hasNextPage } }',
      superAdmin
    ));

    expect(data.pendingWithdrawals.total).toBe(1);
  });

  it('requestWithdrawal returns a result with the withdrawal', async () => {
    db.user.findUnique.mockResolvedValue({ bannedAt: null, bannedUntil: null, restrictedAt: null, restrictedUntil: null });
    db.walletTransaction.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    db.withdrawal.findFirst.mockResolvedValue(null);
    db.wallet.findUnique.mockResolvedValue({ ...walletRecord, isLocked: false, lockedReason: null });
    db.providerBankAccount.findFirst.mockResolvedValue({
      id: '66e2a0c0f0a9d83b5c7e0011',
      bankCode: '058',
      bankName: 'Guaranty Trust Bank',
      accountNumber: '0123456789',
      accountName: 'ADA OBI',
    });
    db.wallet.updateMany.mockResolvedValue({ count: 1 });
    db.withdrawal.create.mockResolvedValue(withdrawalRecord);

    const data = expectNoErrors(await run(
      `mutation { requestWithdrawal(input: { amount: 3000, bankAccountId: "66e2a0c0f0a9d83b5c7e0011" }) {
          success message withdrawal { id amount status bankAccountSnapshot { bankName } }
      } }`,
      provider
    ));

    expect(data.requestWithdrawal).toMatchObject({ success: true, withdrawal: { id: '66e2a0c0f0a9d83b5c7e000a', amount: 3000 } });
    // The account's ban and restriction, then today's withdrawals and reversals
    expect(db.user.findUnique.mock.calls[0][0].where).toEqual({ id: '66e2a0c0f0a9d83b5c7e0001' });
    expect(db.walletTransaction.aggregate).toHaveBeenCalledTimes(2);
  });
});

describe('payouts and bank accounts', () => {
  it('myPendingEarnings returns the schema fields', async () => {
    db.payment.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    db.wallet.findUnique.mockResolvedValueOnce({ balance: 558_000, isLocked: false });

    const data = expectNoErrors(await run(
      '{ myPendingEarnings { totalPending availableNow pendingClearance nextAvailableDate } }',
      provider
    ));

    // availableNow is the withdrawable wallet balance
    expect(data.myPendingEarnings).toEqual({ totalPending: 0, availableNow: 5580, pendingClearance: 0, nextAvailableDate: null });
  });

  it('myScheduledPayouts includes fee and net amount', async () => {
    db.scheduledPayout.findMany.mockResolvedValue([
      {
        id: '66e2a0c0f0a9d83b5c7e0016',
        providerId: '66e2a0c0f0a9d83b5c7e0002',
        amount: 600_000,
        paymentIds: [],
        scheduledFor: now,
        status: 'PENDING',
        withdrawalId: null,
        processedAt: null,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    db.scheduledPayout.count.mockResolvedValue(1);

    const data = expectNoErrors(await run(
      '{ myScheduledPayouts { items { id amount fee netAmount status scheduledFor createdAt } total hasNextPage } }',
      provider
    ));

    expect(data.myScheduledPayouts.items[0]).toMatchObject({ amount: 6000, fee: 50, netAmount: 5950 });
  });

  it('setPayoutSchedule accepts a weekly schedule with a day', async () => {
    db.userSettings.findUnique.mockResolvedValue(null);
    db.payoutSchedule.upsert.mockResolvedValue({
      id: '66e2a0c0f0a9d83b5c7e0018',
      providerId: '66e2a0c0f0a9d83b5c7e0002',
      frequency: 'WEEKLY',
      dayOfWeek: 1,
      dayOfMonth: null,
      minimumAmount: 500_000,
      timezone: 'Africa/Lagos',
      isActive: true,
      bankAccountId: null,
      createdAt: now,
      updatedAt: now,
    });

    const data = expectNoErrors(await run(
      `mutation { setPayoutSchedule(input: { frequency: WEEKLY, dayOfWeek: 1, minimumAmount: 5000 }) {
          id frequency minimumAmount isActive createdAt updatedAt
      } }`,
      provider
    ));

    expect(data.setPayoutSchedule).toMatchObject({ frequency: 'WEEKLY', minimumAmount: 5000 });
  });

  it('suggestBankFromAccountNumber returns matching banks', async () => {
    (paystack.listBanks as jest.Mock).mockResolvedValue({
      status: true,
      data: [
        { id: 9, name: 'Guaranty Trust Bank', code: '058', slug: 'guaranty-trust-bank', active: true, country: 'Nigeria', currency: 'NGN', type: 'nuban' },
        { id: 21, name: 'Zenith Bank', code: '057', slug: 'zenith-bank', active: true, country: 'Nigeria', currency: 'NGN', type: 'nuban' },
      ],
    });

    const data = expectNoErrors(await run(
      // NUBAN check digit valid for GTBank (058), not Zenith (057)
      '{ suggestBankFromAccountNumber(accountNumber: "0123456785") { possibleBanks { id name code } confidence } }',
      provider
    ));

    expect(data.suggestBankFromAccountNumber).toEqual({
      possibleBanks: [{ id: 9, name: 'Guaranty Trust Bank', code: '058' }],
      confidence: 'MEDIUM',
    });
  });
});

const userRecord = {
  id: '66e2a0c0f0a9d83b5c7e0001',
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Obi',
  phone: null,
  profilePhoto: null,
  role: 'SERVICE_PROVIDER',
  status: 'ACTIVE',
  isEmailVerified: true,
  bannedAt: null,
  bannedUntil: null,
  banReason: null,
  restrictedAt: null,
  restrictedUntil: null,
  restrictionReason: null,
  lastLoginAt: now,
  createdAt: now,
  updatedAt: now,
};

const providerRow = {
  id: '66e2a0c0f0a9d83b5c7e0002',
  userId: '66e2a0c0f0a9d83b5c7e0001',
  businessName: 'Ada Cleaning',
  businessDescription: 'Home cleaning',
  verificationStatus: 'VERIFIED',
  address: '1 Marina',
  city: 'Lagos',
  state: 'Lagos',
  country: 'Nigeria',
  latitude: 6.45,
  longitude: 3.4,
  images: [],
  documents: [],
  createdAt: now,
  updatedAt: now,
  user: { id: '66e2a0c0f0a9d83b5c7e0001', firstName: 'Ada', lastName: 'Obi', profilePhoto: null },
  services: [],
  _count: { reviews: 2, likes: 4 },
};

describe('admin user management and audit logs', () => {
  const managedUserFields = 'id email role accountStatus isBanned isRestricted provider { id businessName verificationStatus } createdAt';

  it('managedUsers maps the dashboard filters and returns ManagedUser items', async () => {
    db.user.findMany.mockResolvedValue([
      {
        ...userRecord,
        provider: { id: '66e2a0c0f0a9d83b5c7e0002', businessName: 'Ada Cleaning', verificationStatus: 'VERIFIED' },
        _count: { bookingsAsUser: 2, reviews: 1 },
      },
    ]);
    db.user.count.mockResolvedValue(1);

    const data = expectNoErrors(await run(
      `{ managedUsers(filters: { accountStatus: ACTIVE, searchTerm: "ada" }) {
          items { ${managedUserFields} } total page totalPages hasNextPage
      } }`,
      superAdmin
    ));

    expect(data.managedUsers.items[0]).toMatchObject({ accountStatus: 'ACTIVE', isBanned: false, provider: { id: '66e2a0c0f0a9d83b5c7e0002' } });
    const where = db.user.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('ACTIVE');
    expect(where.OR).toHaveLength(4);
  });

  it('managedUser returns one user', async () => {
    db.user.findUnique.mockResolvedValue({
      ...userRecord,
      provider: null,
      bookingsAsUser: [],
      reviews: [],
      wallet: null,
      _count: { bookingsAsUser: 0, reviews: 0, favourites: 0 },
    });
    db.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    const data = expectNoErrors(await run(`{ managedUser(id: "66e2a0c0f0a9d83b5c7e0001") { ${managedUserFields} } }`, superAdmin));

    expect(data.managedUser).toMatchObject({ id: '66e2a0c0f0a9d83b5c7e0001', isRestricted: false, provider: null });
  });

  it('managedProviders returns providers as ManagedUser items', async () => {
    db.serviceProvider.findMany.mockResolvedValue([
      { ...providerRow, user: userRecord, _count: { services: 3, bookings: 5, reviews: 2 } },
    ]);
    db.serviceProvider.count.mockResolvedValue(1);
    db.review.aggregate.mockResolvedValue({ _avg: { rating: 4.5 } });
    db.wallet.findMany.mockResolvedValue([{ id: '66e2a0c0f0a9d83b5c7e0009', userId: providerRow.userId }]);
    db.walletTransaction.groupBy.mockResolvedValue([{ walletId: '66e2a0c0f0a9d83b5c7e0009', _sum: { amount: 1500000 } }]);

    const data = expectNoErrors(await run(
      `{ managedProviders { items { ${managedUserFields} provider { totalServices averageRating totalEarnings } } total } }`,
      superAdmin
    ));

    expect(data.managedProviders.items[0].provider).toMatchObject({ id: '66e2a0c0f0a9d83b5c7e0002', totalServices: 3, averageRating: 4.5, totalEarnings: 15000 });
  });

  it('auditLogs and auditLogsForTarget return entries with the admin email', async () => {
    db.adminAuditLog.findMany.mockResolvedValue([
      {
        id: '66e2a0c0f0a9d83b5c7e0010',
        action: 'UNRESTRICT_USER',
        targetType: 'User',
        targetId: '66e2a0c0f0a9d83b5c7e0001',
        performedBy: '66e2a0c0f0a9d83b5c7e0004',
        performedByRole: 'SUPER_ADMIN',
        previousValue: '{"restrictedAt":"2026-09-01"}',
        newValue: null,
        reason: 'Appeal accepted',
        ipAddress: null,
        userAgent: null,
        createdAt: now,
      },
    ]);
    db.adminAuditLog.count.mockResolvedValue(1);
    db.user.findMany.mockResolvedValue([{ id: '66e2a0c0f0a9d83b5c7e0004', email: 'super@example.com' }]);

    const fields = 'items { id adminId adminEmail action targetType targetId metadata createdAt } total hasNextPage';
    const all = expectNoErrors(await run(`{ auditLogs(filters: { adminId: "66e2a0c0f0a9d83b5c7e0004" }) { ${fields} } }`, superAdmin));
    const forTarget = expectNoErrors(await run(`{ auditLogsForTarget(targetId: "66e2a0c0f0a9d83b5c7e0001") { ${fields} } }`, superAdmin));

    expect(all.auditLogs.items[0]).toMatchObject({ action: 'UNRESTRICT_USER', adminEmail: 'super@example.com' });
    expect(forTarget.auditLogsForTarget.total).toBe(1);
    expect(db.adminAuditLog.findMany.mock.calls[0][0].where.performedBy).toBe('66e2a0c0f0a9d83b5c7e0004');
    expect(db.adminAuditLog.findMany.mock.calls[1][0].where.targetId).toBe('66e2a0c0f0a9d83b5c7e0001');
  });
});

describe('notifications, browse and likes', () => {
  it('notificationStats returns counts per type as a JSON string', async () => {
    db.notification.count.mockResolvedValueOnce(5).mockResolvedValueOnce(2);
    db.notification.groupBy.mockResolvedValue([{ type: 'NEW_MESSAGE', _count: 3 }]);

    const data = expectNoErrors(await run('{ notificationStats { total unread read byType } }', provider));

    expect(JSON.parse(data.notificationStats.byType)).toEqual({ NEW_MESSAGE: 3 });
  });

  const paginationFields = 'total page limit totalPages hasNextPage hasPreviousPage';

  it('providers returns pagination fields when only the page is given', async () => {
    db.serviceProvider.findMany.mockResolvedValue([providerRow]);
    db.serviceProvider.count.mockResolvedValue(1);
    db.review.groupBy.mockResolvedValue([]);

    const data = expectNoErrors(await run(
      `{ providers(input: { pagination: { page: 1 } }) { items { __typename } ${paginationFields} } }`,
      null
    ));

    expect(data.providers).toMatchObject({ total: 1, page: 1, limit: 10, totalPages: 1 });
  });

  it('nearbyProviders returns pagination fields and the search location', async () => {
    db.serviceProvider.findMany.mockResolvedValue([providerRow]);
    db.review.groupBy.mockResolvedValue([]);

    const data = expectNoErrors(await run(
      `{ nearbyProviders(input: { latitude: 6.45, longitude: 3.4 }) {
          items { __typename } ${paginationFields} radiusKm searchLocation { latitude longitude }
      } }`,
      null
    ));

    expect(data.nearbyProviders).toMatchObject({ total: 1, searchLocation: { latitude: 6.45, longitude: 3.4 } });
  });

  it('myLikedProviders returns pagination fields', async () => {
    db.providerLike.findMany.mockResolvedValue([]);
    db.providerLike.count.mockResolvedValue(0);

    const data = expectNoErrors(await run(`{ myLikedProviders { items { __typename } ${paginationFields} } }`, provider));

    expect(data.myLikedProviders).toMatchObject({ total: 0, page: 1, hasNextPage: false });
  });
});

describe('payment analytics', () => {
  const paymentRow = {
    id: '66e2a0c0f0a9d83b5c7e0007',
    amount: 6000,
    commission: 420,
    providerPayout: 5580,
    paystackFee: 0,
    paidAt: now,
    createdAt: now,
    booking: {
      serviceId: '66e2a0c0f0a9d83b5c7e0009',
      service: { id: '66e2a0c0f0a9d83b5c7e0009', name: 'Deep Cleaning' },
      provider: { id: '66e2a0c0f0a9d83b5c7e0002', businessName: 'Ada Cleaning' },
    },
  };

  it('myEarningsReport returns the report fields', async () => {
    db.payment.findMany
      .mockResolvedValueOnce([paymentRow]) // completed payments in the period
      .mockResolvedValueOnce([]); // refunds in the period
    db.wallet.findUnique.mockResolvedValue(walletRecord);
    db.withdrawal.aggregate.mockResolvedValue({ _sum: { amount: 300_000 } });

    const data = expectNoErrors(await run(
      `{ myEarningsReport(input: { period: ALL_TIME }) {
          period startDate endDate totalEarnings completedJobs commissionPaid netEarnings
          withdrawnAmount pendingBalance breakdown { date earnings jobs }
      } }`,
      provider
    ));

    expect(data.myEarningsReport).toMatchObject({
      // What the customer paid, then the provider's share after commission
      totalEarnings: 6000,
      completedJobs: 1,
      commissionPaid: 420,
      netEarnings: 5580,
      withdrawnAmount: 3000,
      // Not yet released to the wallet
      pendingBalance: 5580,
      breakdown: [{ earnings: 5580, jobs: 1 }],
    });
  });

  it('adminPaymentAnalytics returns totals and a status breakdown', async () => {
    db.payment.findMany.mockResolvedValueOnce([paymentRow]).mockResolvedValueOnce([]);
    db.payment.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

    const data = expectNoErrors(await run(
      `{ adminPaymentAnalytics(input: { period: MONTHLY }) {
          period totalTransactions totalVolume totalCommission totalRefunds netRevenue averageTransactionValue
          transactionsByStatus { completed pending failed refunded }
      } }`,
      superAdmin
    ));

    expect(data.adminPaymentAnalytics).toMatchObject({
      totalTransactions: 1,
      totalCommission: 420,
      transactionsByStatus: { completed: 1, pending: 2, failed: 1, refunded: 0 },
    });
  });

  it('refundStats returns counts, amounts and reasons', async () => {
    db.payment.findMany.mockResolvedValueOnce([
      { ...paymentRow, refundAmount: null, refundedVia: null, refundReason: null, refundedAt: now, booking: { ...paymentRow.booking, dispute: null } },
    ]);
    db.payment.count.mockResolvedValueOnce(3);

    const data = expectNoErrors(await run(
      `{ refundStats(period: ALL_TIME) {
          totalRefunds totalRefundAmount refundRate averageRefundAmount refundsByReason { reason count amount }
      } }`,
      superAdmin
    ));

    expect(data.refundStats).toMatchObject({
      totalRefunds: 1,
      totalRefundAmount: 6000,
      refundRate: 25,
      refundsByReason: [{ reason: 'MANUAL', count: 1, amount: 6000 }],
    });
  });
});

describe('payments and disputes', () => {
  type CreateArgs = { data: Record<string, unknown> };

  const customer: Viewer = { userId: '66e2a0c0f0a9d83b5c7e0005', role: 'SERVICE_USER' };
  const admin: Viewer = { userId: '66e2a0c0f0a9d83b5c7e0008', role: 'ADMIN' };

  const customerWallet = {
    ...walletRecord,
    id: '66e2a0c0f0a9d83b5c7e000f',
    userId: '66e2a0c0f0a9d83b5c7e0005',
    balance: 1_000_000,
    isLocked: false,
    lockedReason: null,
  };

  const bookingRow = {
    id: '66e2a0c0f0a9d83b5c7e0006',
    userId: '66e2a0c0f0a9d83b5c7e0005',
    providerId: '66e2a0c0f0a9d83b5c7e0002',
    serviceId: '66e2a0c0f0a9d83b5c7e0009',
    status: 'ACCEPTED',
    scheduledDate: now,
    scheduledTime: '10:00',
    servicePrice: 6000,
    commission: 420,
    totalAmount: 6000,
    completedAt: null,
    paymentReleasedAt: null,
    createdAt: now,
    updatedAt: now,
    user: { ...userRecord, id: '66e2a0c0f0a9d83b5c7e0005', email: 'chi@example.com', firstName: 'Chi', lastName: 'Eze', role: 'SERVICE_USER' },
    provider: {
      ...providerRecord,
      businessName: 'Ada Cleaning',
      user: { id: '66e2a0c0f0a9d83b5c7e0001', firstName: 'Ada', lastName: 'Obi', email: 'ada@example.com' },
    },
    service: { id: '66e2a0c0f0a9d83b5c7e0009', name: 'Deep Cleaning', price: 6000 },
  };

  const paidBooking = { ...bookingRow, status: 'COMPLETED', completedAt: now };

  const paymentRecord = {
    id: '66e2a0c0f0a9d83b5c7e0007',
    bookingId: '66e2a0c0f0a9d83b5c7e0006',
    amount: 6000,
    commission: 420,
    providerPayout: 5580,
    paystackFee: 0,
    status: 'COMPLETED',
    paymentMethod: 'card',
    transactionRef: 'EK_1',
    transactionRefs: ['EK_1'],
    paidAt: now,
    refundedAt: null,
    payoutAt: null,
    refundAmount: null,
    refundReason: null,
    refundedVia: null,
    createdAt: now,
    updatedAt: now,
  };

  beforeEach(() => {
    // No registered device, so notifications don't try to send a push
    db.user.findUnique.mockResolvedValue(null);
    db.walletTransaction.findUnique.mockResolvedValue(null);
    db.walletTransaction.create.mockImplementation(async ({ data }: CreateArgs) => ({ id: '66e2a0c0f0a9d83b5c7e0013', createdAt: now, ...data }));
    db.adminAuditLog.create.mockImplementation(async ({ data }: CreateArgs) => ({ id: '66e2a0c0f0a9d83b5c7e001a', createdAt: now, ...data }));
  });

  it('payWithWallet debits the wallet and returns the ledger entry', async () => {
    db.booking.findUnique.mockResolvedValue({ ...bookingRow, payment: null });
    db.wallet.findUnique
      .mockResolvedValueOnce(customerWallet) // balance check
      .mockResolvedValueOnce({ ...customerWallet, balance: 400_000 }); // after the debit
    db.booking.updateMany.mockResolvedValue({ count: 1 });
    db.payment.findUnique.mockResolvedValue(null);
    db.wallet.updateMany.mockResolvedValue({ count: 1 });
    db.payment.create.mockImplementation(async ({ data }: CreateArgs) => ({ id: '66e2a0c0f0a9d83b5c7e0019', createdAt: now, updatedAt: now, ...data }));

    const data = expectNoErrors(await run(
      `mutation { payWithWallet(input: { bookingId: "66e2a0c0f0a9d83b5c7e0006" }) {
          success message remainingBalance transaction { amount source referenceId }
      } }`,
      customer
    ));

    expect(data.payWithWallet).toEqual({
      success: true,
      message: 'Payment successful',
      remainingBalance: 4000,
      transaction: { amount: 6000, source: 'BOOKING_PAYMENT', referenceId: 'WPAY_66e2a0c0f0a9d83b5c7e0006' },
    });
    expect(db.wallet.updateMany.mock.calls[0][0].data).toEqual({ balance: { decrement: 600_000 } });
    expect(db.payment.create.mock.calls[0][0].data).toMatchObject({
      status: 'COMPLETED',
      paymentMethod: 'wallet',
      amount: 6000,
      providerPayout: 5580,
    });
  });

  it('processRefund refunds part of a payment to the wallet and returns the payment', async () => {
    const withBooking = { ...paymentRecord, booking: paidBooking };
    db.payment.findUnique
      .mockResolvedValueOnce(withBooking) // loaded by processRefund
      .mockResolvedValueOnce(withBooking) // read again inside the transaction
      .mockResolvedValueOnce({ ...withBooking, refundAmount: 2000, refundReason: 'Late arrival', refundedAt: now, providerPayout: 3720, commission: 280 });
    db.wallet.findUnique.mockResolvedValue(customerWallet);
    db.payment.updateMany.mockResolvedValue({ count: 1 });
    db.wallet.update.mockResolvedValue({ ...customerWallet, balance: 1_200_000 });
    // The booking write only matches a booking that isn't disputed
    db.booking.updateMany.mockResolvedValue({ count: 1 });

    const data = expectNoErrors(await run(
      `mutation { processRefund(input: { paymentId: "66e2a0c0f0a9d83b5c7e0007", amount: 2000, reason: "Late arrival" }) {
          success message payment { status refundAmount }
      } }`,
      superAdmin
    ));

    expect(data.processRefund).toEqual({
      success: true,
      message: expect.stringContaining('has been refunded to the customer\'s wallet'),
      payment: { status: 'COMPLETED', refundAmount: 2000 },
    });
    expect(db.payment.updateMany.mock.calls[0][0].data).toMatchObject({
      refundAmount: 2000,
      providerPayout: 3720,
      commission: 280,
      refundedVia: 'MANUAL',
      refundedBy: '66e2a0c0f0a9d83b5c7e0004',
    });
    expect(db.walletTransaction.create.mock.calls[0][0].data).toMatchObject({
      walletId: '66e2a0c0f0a9d83b5c7e000f',
      amount: 200_000,
      source: 'REFUND',
      reference: 'RFD_66e2a0c0f0a9d83b5c7e0007',
    });
    expect(db.booking.updateMany.mock.calls[0][0].where).toEqual({ id: '66e2a0c0f0a9d83b5c7e0006', status: { not: 'DISPUTED' } });
  });

  it('resolveDispute with a partial refund returns the resolved dispute', async () => {
    const disputeRecord = {
      id: '66e2a0c0f0a9d83b5c7e000d',
      bookingId: '66e2a0c0f0a9d83b5c7e0006',
      raisedById: '66e2a0c0f0a9d83b5c7e0005',
      raisedByRole: 'SERVICE_USER',
      reason: 'Poor service',
      description: 'Half of the rooms were not cleaned.',
      evidence: [],
      status: 'UNDER_REVIEW',
      previousBookingStatus: 'COMPLETED',
      resolution: null,
      resolutionNotes: null,
      resolvedById: null,
      resolvedAt: null,
      refundAmount: null,
      createdAt: now,
      updatedAt: now,
    };
    const disputedBooking = { ...paidBooking, status: 'DISPUTED' };
    db.dispute.findUnique.mockResolvedValue({ ...disputeRecord, booking: { ...disputedBooking, payment: paymentRecord } });
    db.wallet.findUnique.mockResolvedValue(customerWallet);
    db.dispute.updateMany.mockResolvedValue({ count: 1 });
    db.payment.findUnique.mockResolvedValue({ ...paymentRecord, booking: disputedBooking });
    db.payment.updateMany.mockResolvedValue({ count: 1 });
    db.wallet.update.mockResolvedValue({ ...customerWallet, balance: 1_150_000 });
    db.dispute.findUniqueOrThrow.mockResolvedValue({
      ...disputeRecord,
      status: 'RESOLVED',
      resolution: 'REFUND_PARTIAL',
      resolutionNotes: 'Half of the rooms were not cleaned',
      refundAmount: 1500,
      resolvedById: '66e2a0c0f0a9d83b5c7e0008',
      resolvedAt: now,
      booking: paidBooking,
    });

    const data = expectNoErrors(await run(
      `mutation { resolveDispute(disputeId: "66e2a0c0f0a9d83b5c7e000d", input: {
          resolution: REFUND_PARTIAL, resolutionNotes: "Half of the rooms were not cleaned", refundAmount: 1500
      }) { id status resolution refundAmount resolvedAt booking { id status } } }`,
      admin
    ));

    expect(data.resolveDispute).toMatchObject({
      id: '66e2a0c0f0a9d83b5c7e000d',
      status: 'RESOLVED',
      resolution: 'REFUND_PARTIAL',
      refundAmount: 1500,
      booking: { id: '66e2a0c0f0a9d83b5c7e0006', status: 'COMPLETED' },
    });
    expect(db.dispute.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'RESOLVED', refundAmount: 1500, resolvedById: '66e2a0c0f0a9d83b5c7e0008' });
    expect(db.walletTransaction.create.mock.calls[0][0].data).toMatchObject({ amount: 150_000, source: 'REFUND', reference: 'RFD_66e2a0c0f0a9d83b5c7e0007' });
    expect(db.booking.update.mock.calls[0][0].data).toMatchObject({ status: 'COMPLETED', paymentReleaseAt: expect.any(Date) });
  });

  it('payment(id) is readable by an admin', async () => {
    db.payment.findUnique.mockResolvedValue({ ...paymentRecord, booking: paidBooking });

    const data = expectNoErrors(await run(
      '{ payment(id: "66e2a0c0f0a9d83b5c7e0007") { id bookingId amount status paidAt booking { id status } } }',
      admin
    ));

    expect(data.payment).toMatchObject({ id: '66e2a0c0f0a9d83b5c7e0007', amount: 6000, status: 'COMPLETED', booking: { id: '66e2a0c0f0a9d83b5c7e0006', status: 'COMPLETED' } });
  });

  it('paymentByBooking is refused for an unrelated user', async () => {
    db.payment.findUnique.mockResolvedValue({ ...paymentRecord, booking: paidBooking });

    const result = await run(
      '{ paymentByBooking(bookingId: "66e2a0c0f0a9d83b5c7e0006") { id amount } }',
      { userId: '66e2a0c0f0a9d83b5c7e0012', role: 'SERVICE_USER' }
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0].extensions.code).toBe('UNAUTHORIZED');
    expect(result.data?.paymentByBooking).toBeNull();
    expect(db.payment.findUnique.mock.calls[0][0].where).toEqual({ bookingId: '66e2a0c0f0a9d83b5c7e0006' });
  });
});

describe('moderation', () => {
  const customer: Viewer = { userId: '66e2a0c0f0a9d83b5c7e0005', role: 'SERVICE_USER' };

  it('the schema defines the blocking, reporting and community terms operations', () => {
    const queries = Object.keys(schema.getQueryType()?.getFields() ?? {});
    const mutations = Object.keys(schema.getMutationType()?.getFields() ?? {});

    expect(queries).toEqual(expect.arrayContaining([
      'myBlockedUsers',
      'myReports',
      'termsStatus',
      'reports',
      'report',
      'reportedConversationMessages',
    ]));
    expect(mutations).toEqual(expect.arrayContaining([
      'blockUser',
      'unblockUser',
      'createReport',
      'acceptTerms',
      'resolveReport',
    ]));
  });

  it('review(id) keeps a hidden review’s rating but returns no text', async () => {
    db.review.findUnique.mockResolvedValue({
      id: '66e2a0c0f0a9d83b5c7e000c',
      rating: 2,
      comment: 'Abusive comment',
      response: 'Angry reply',
      isHidden: true,
      respondedAt: now,
      createdAt: now,
      updatedAt: now,
      user: null,
      provider: null,
      booking: null,
    });

    const data = expectNoErrors(await run('{ review(id: "66e2a0c0f0a9d83b5c7e000c") { id rating comment response isHidden } }', null));

    expect(data.review).toEqual({ id: '66e2a0c0f0a9d83b5c7e000c', rating: 2, comment: null, response: null, isHidden: true });
  });

  it('review(id) shows the text of a review stored without isHidden', async () => {
    db.review.findUnique.mockResolvedValue({
      id: '66e2a0c0f0a9d83b5c7e000b',
      rating: 5,
      comment: 'Spotless work',
      response: null,
      respondedAt: null,
      createdAt: now,
      updatedAt: now,
      user: null,
      provider: null,
      booking: null,
    });

    const data = expectNoErrors(await run('{ review(id: "66e2a0c0f0a9d83b5c7e000b") { id rating comment response isHidden } }', null));

    expect(data.review).toEqual({ id: '66e2a0c0f0a9d83b5c7e000b', rating: 5, comment: 'Spotless work', response: null, isHidden: false });
  });

  it('reports and resolveReport are refused for a provider without reading or changing reports', async () => {
    const list = await run('{ reports { total } }', provider);
    const decision = await run(
      'mutation { resolveReport(id: "507f1f77bcf86cd799439011", input: { action: DISMISS, notes: "No breach found" }) { id } }',
      provider
    );

    expect(list.errors?.[0].extensions.code).toBe('UNAUTHORIZED');
    expect(decision.errors?.[0].extensions.code).toBe('UNAUTHORIZED');
    expect(db.report.findMany).not.toHaveBeenCalled();
    expect(db.report.findUnique).not.toHaveBeenCalled();
    expect(db.report.updateMany).not.toHaveBeenCalled();
  });

  it('myBlockedUsers lists the people the signed-in user blocked', async () => {
    db.userBlock.findMany.mockResolvedValue([
      { id: '66e2a0c0f0a9d83b5c7e000e', blockerId: '66e2a0c0f0a9d83b5c7e0005', blockedId: '66e2a0c0f0a9d83b5c7e0001', reason: 'Spam', createdAt: now },
    ]);
    db.userBlock.count.mockResolvedValue(1);
    db.user.findMany.mockResolvedValue([{ id: '66e2a0c0f0a9d83b5c7e0001', firstName: 'Ada', lastName: 'Obi', profilePhoto: null }]);

    const data = expectNoErrors(await run(
      '{ myBlockedUsers { items { id reason blockedAt user { id firstName lastName } } total hasNextPage } }',
      customer
    ));

    expect(data.myBlockedUsers).toEqual({
      items: [
        {
          id: '66e2a0c0f0a9d83b5c7e000e',
          reason: 'Spam',
          blockedAt: now.toISOString(),
          user: { id: '66e2a0c0f0a9d83b5c7e0001', firstName: 'Ada', lastName: 'Obi' },
        },
      ],
      total: 1,
      hasNextPage: false,
    });
    expect(db.userBlock.findMany.mock.calls[0][0].where).toEqual({ blockerId: '66e2a0c0f0a9d83b5c7e0005' });
  });

  it('blockUser blocks as the signed-in user', async () => {
    const blockerId = '507f1f77bcf86cd799439031';
    const blockedId = '507f1f77bcf86cd799439032';
    // Both the person blocked and the person blocking are looked up
    const roles: Record<string, string> = { [blockerId]: 'SERVICE_USER', [blockedId]: 'SERVICE_PROVIDER' };
    db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      roles[where.id] ? { role: roles[where.id] } : null
    );
    db.userBlock.upsert.mockResolvedValue({ id: '66e2a0c0f0a9d83b5c7e000e' });

    const data = expectNoErrors(await run(
      `mutation { blockUser(userId: "${blockedId}", reason: "Spam") { success message } }`,
      { userId: blockerId, role: 'SERVICE_USER' }
    ));

    expect(data.blockUser).toEqual({ success: true, message: 'User blocked' });
    expect(db.userBlock.upsert).toHaveBeenCalledWith({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      create: { blockerId, blockedId, reason: 'Spam' },
      update: {},
    });
  });

  it('termsStatus reads the signed-in user', async () => {
    db.user.findUnique.mockResolvedValue({ acceptedTermsVersion: null, acceptedTermsAt: null });

    const data = expectNoErrors(await run('{ termsStatus { currentVersion acceptedVersion acceptedAt mustAccept } }', customer));

    expect(data.termsStatus).toEqual({
      currentVersion: expect.any(String),
      acceptedVersion: null,
      acceptedAt: null,
      mustAccept: true,
    });
    expect(db.user.findUnique.mock.calls[0][0].where).toEqual({ id: '66e2a0c0f0a9d83b5c7e0005' });
  });
});
