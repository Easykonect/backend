/**
 * GraphQL contract tests for topEarningProviders and myEarnings: real
 * operations through the executable schema, request guards included, with only
 * the database, Redis and Paystack mocked
 */

import { graphql, type ExecutionResult } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';

jest.mock('@/lib/prisma', () => {
  const model = () => ({
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
  });
  return {
    __esModule: true,
    default: {
      walletTransaction: model(),
      wallet: model(),
      serviceProvider: model(),
      payment: model(),
      platformSettings: model(),
    },
  };
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
  };
  return {
    __esModule: true,
    default: { getInstance: () => client, connect: async () => client },
    rateLimit: { check: jest.fn().mockResolvedValue({ allowed: true, remaining: 1, resetIn: 1 }) },
  };
});

jest.mock('@/lib/paystack', () => ({
  ...jest.requireActual('@/lib/paystack'),
  paystack: {},
}));

import prisma from '@/lib/prisma';
import { typeDefs, resolvers } from '@/graphql';

const schema = makeExecutableSchema({ typeDefs, resolvers });
const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

type Viewer = { userId: string; role: string };

const run = (source: string, viewer: Viewer): Promise<ExecutionResult> =>
  graphql({
    schema,
    source,
    contextValue: { user: { ...viewer, email: `${viewer.userId}@example.com` } },
  }) as Promise<ExecutionResult>;

const admin: Viewer = { userId: '66e2a0c0f0a9d83b5c7e0008', role: 'ADMIN' };
const provider: Viewer = { userId: '66e2a0c0f0a9d83b5c7e0001', role: 'SERVICE_PROVIDER' };
const providerId = '66e2a0c0f0a9d83b5c7e0002';
const walletId = '66e2a0c0f0a9d83b5c7e0003';

describe('topEarningProviders', () => {
  beforeEach(() => {
    db.walletTransaction.groupBy.mockResolvedValue([
      { walletId, _sum: { amount: 5_580_000 }, _count: { _all: 4 } },
    ]);
    db.wallet.findMany.mockResolvedValue([{ id: walletId, userId: provider.userId }]);
    db.serviceProvider.findMany.mockResolvedValue([
      { id: providerId, userId: provider.userId, businessName: 'Ada Cleaning' },
    ]);
  });

  it('lists the earnings released to each provider for an admin, with limit capped at 100', async () => {
    const result = await run(
      '{ topEarningProviders(limit: 500, period: MONTHLY) { providerId businessName totalEarnings completedJobs } }',
      admin
    );

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      topEarningProviders: [{ providerId, businessName: 'Ada Cleaning', totalEarnings: 55_800, completedJobs: 4 }],
    });
    expect(db.walletTransaction.groupBy.mock.calls[0][0]).toMatchObject({
      where: { type: 'CREDIT', source: 'SERVICE_EARNING' },
      take: 100,
    });
    expect(db.walletTransaction.groupBy.mock.calls[0][0].where.createdAt).toHaveProperty('gte');
  });

  it('defaults to 10 providers over all time', async () => {
    const result = await run('{ topEarningProviders { providerId } }', admin);

    expect(result.errors).toBeUndefined();
    const args = db.walletTransaction.groupBy.mock.calls[0][0];
    expect(args.take).toBe(10);
    expect(args.where.createdAt).not.toHaveProperty('gte');
  });

  it('refuses a provider', async () => {
    const result = await run('{ topEarningProviders { providerId } }', provider);

    expect(result.errors?.[0].extensions?.code).toBe('UNAUTHORIZED');
    expect(db.walletTransaction.groupBy).not.toHaveBeenCalled();
  });
});

describe('myEarnings', () => {
  beforeEach(() => {
    db.serviceProvider.findUnique.mockResolvedValue({ id: providerId, userId: provider.userId });
    db.payment.count.mockResolvedValue(2);
  });

  it('reports the commission rate charged on the provider’s paid bookings, not the current rate', async () => {
    // ₦15,000 at 10% and ₦10,000 at 7% with ₦5,000 of it refunded:
    // ₦1,850 commission on the ₦20,000 kept
    db.payment.aggregate.mockImplementation(async ({ _sum }: { _sum: Record<string, boolean> }) =>
      _sum.amount
        ? { _sum: { providerPayout: 18_150, amount: 25_000, refundAmount: 5_000, commission: 1_850 } }
        : { _sum: { providerPayout: 4_650 } }
    );

    const result = await run('{ myEarnings { totalEarnings thisMonthEarnings completedJobs commissionRate } }', provider);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      myEarnings: { totalEarnings: 18_150, thisMonthEarnings: 4_650, completedJobs: 2, commissionRate: 9.25 },
    });
    expect(db.platformSettings.findUnique).not.toHaveBeenCalled();
  });

  it('falls back to the current rate for new bookings when nothing has been paid', async () => {
    db.payment.aggregate.mockResolvedValue({
      _sum: { providerPayout: null, amount: null, refundAmount: null, commission: null },
    });
    db.payment.count.mockResolvedValue(0);
    db.platformSettings.findUnique.mockResolvedValue({ commissionRate: 0.085 });

    const result = await run('{ myEarnings { totalEarnings completedJobs commissionRate } }', provider);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ myEarnings: { totalEarnings: 0, completedJobs: 0, commissionRate: 8.5 } });
  });
});
