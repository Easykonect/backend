/**
 * GraphQL: who a withdrawal belongs to, the providerId filter, and the payout
 * schedule and scheduled payout fields, run through the executable schema
 */

import { graphql, type ExecutionResult } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';

jest.mock('@/lib/prisma', () => {
  const model = () => ({
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  });
  return {
    __esModule: true,
    default: {
      serviceProvider: model(),
      withdrawal: model(),
      payoutSchedule: model(),
      scheduledPayout: model(),
    },
  };
});

// The Resend client throws at import time without an API key
jest.mock('@/lib/email', () => ({ __esModule: true, default: {} }));

jest.mock('@/lib/redis', () => ({
  __esModule: true,
  default: { getInstance: () => ({ get: jest.fn().mockResolvedValue(null), setex: jest.fn() }) },
  rateLimit: { check: jest.fn().mockResolvedValue({ allowed: true, remaining: 1, resetIn: 1 }) },
}));

import prisma from '@/lib/prisma';
import { typeDefs, resolvers } from '@/graphql';

const schema = makeExecutableSchema({ typeDefs, resolvers });
const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

type Viewer = { userId: string; role: string };

const run = (source: string, viewer: Viewer) =>
  graphql({
    schema,
    source,
    contextValue: { user: { ...viewer, email: `${viewer.userId}@example.com` } },
  }) as Promise<ExecutionResult>;

const dataOf = (result: ExecutionResult) => {
  expect(result.errors).toBeUndefined();
  return result.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const PROVIDER_USER_ID = '66e2a0c0f0a9d83b5c7e0001';
const PROVIDER_ID = '66e2a0c0f0a9d83b5c7e0002';
const OTHER_PROVIDER_ID = '66e2a0c0f0a9d83b5c7e0009';

const provider: Viewer = { userId: PROVIDER_USER_ID, role: 'SERVICE_PROVIDER' };
const superAdmin: Viewer = { userId: '66e2a0c0f0a9d83b5c7e0004', role: 'SUPER_ADMIN' };

const requestedAt = new Date('2026-09-10T08:00:00Z');
const completedAt = new Date('2026-09-10T09:30:00Z');

const withdrawalRecord = {
  id: '66e2a0c0f0a9d83b5c7e000a',
  walletId: '66e2a0c0f0a9d83b5c7e0003',
  providerId: PROVIDER_ID,
  amount: 300_000,
  fee: 5_000,
  netAmount: 295_000,
  status: 'COMPLETED',
  bankCode: '058',
  bankName: 'Guaranty Trust Bank',
  accountNumber: '0123456785',
  accountName: 'ADA OBI',
  transferCode: 'TRF_1',
  transferReference: 'wdr_66e2a0c0f0a9d83b5c7e000a_0',
  requestedAt,
  processedAt: requestedAt,
  completedAt,
  failureReason: null,
  retryCount: 0,
  lastRetryAt: null,
  processedBy: superAdmin.userId,
  scheduledPayoutId: null,
  createdAt: requestedAt,
  updatedAt: completedAt,
};

const summary = {
  id: PROVIDER_ID,
  userId: PROVIDER_USER_ID,
  businessName: 'Ada Cleaning Services',
  firstName: 'Ada',
  lastName: 'Obi',
  email: 'ada@example.com',
};

const WITHDRAWAL_FIELDS = `id providerId requestedAt completedAt provider { id userId businessName firstName lastName email }`;

describe('Withdrawal', () => {
  it('lists withdrawals for admins with who asked, filtered by provider', async () => {
    db.withdrawal.findMany.mockResolvedValue([
      {
        ...withdrawalRecord,
        wallet: {
          user: {
            id: PROVIDER_USER_ID,
            email: 'ada@example.com',
            firstName: 'Ada',
            lastName: 'Obi',
            provider: { businessName: 'Ada Cleaning Services' },
          },
        },
      },
    ]);
    db.withdrawal.count.mockResolvedValue(1);

    const data = dataOf(
      await run(
        `{ allWithdrawals(filters: { providerId: "${PROVIDER_ID}" }) { items { ${WITHDRAWAL_FIELDS} } total } }`,
        superAdmin
      )
    );

    expect(data.allWithdrawals.items).toEqual([
      {
        id: withdrawalRecord.id,
        providerId: PROVIDER_ID,
        requestedAt: requestedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        provider: summary,
      },
    ]);
    expect(db.withdrawal.findMany.mock.calls[0][0].where).toEqual({ providerId: PROVIDER_ID });
    // Loaded with the list, not once per withdrawal
    expect(db.serviceProvider.findUnique).not.toHaveBeenCalled();
  });

  it('shows a provider themselves on their own withdrawals, and ignores a providerId filter', async () => {
    db.serviceProvider.findUnique.mockImplementation(async ({ select }: { select?: object }) =>
      select
        ? {
            businessName: 'Ada Cleaning Services',
            user: { id: PROVIDER_USER_ID, email: 'ada@example.com', firstName: 'Ada', lastName: 'Obi' },
          }
        : { id: PROVIDER_ID, userId: PROVIDER_USER_ID }
    );
    db.withdrawal.findMany.mockResolvedValue([withdrawalRecord]);
    db.withdrawal.count.mockResolvedValue(1);

    const data = dataOf(
      await run(
        `{ myWithdrawals(filters: { providerId: "${OTHER_PROVIDER_ID}" }) { items { ${WITHDRAWAL_FIELDS} } } }`,
        provider
      )
    );

    expect(data.myWithdrawals.items[0].provider).toEqual(summary);
    expect(db.withdrawal.findMany.mock.calls[0][0].where).toEqual({ providerId: PROVIDER_ID });
    expect(db.serviceProvider.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PROVIDER_ID } })
    );
  });
});

describe('payout schedules', () => {
  beforeEach(() => {
    db.serviceProvider.findUnique.mockResolvedValue({ id: PROVIDER_ID, userId: PROVIDER_USER_ID });
    jest.useFakeTimers({ now: new Date('2026-09-12T09:00:00Z'), doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  });

  afterEach(() => jest.useRealTimers());

  it('myPayoutSchedule returns the day, the bank account and the next payout date', async () => {
    db.payoutSchedule.findUnique.mockResolvedValue({
      id: '66e2a0c0f0a9d83b5c7e0018',
      providerId: PROVIDER_ID,
      frequency: 'WEEKLY',
      dayOfWeek: 5,
      dayOfMonth: null,
      minimumAmount: 2_000_000,
      timezone: 'Africa/Lagos',
      isActive: true,
      bankAccountId: '66e2a0c0f0a9d83b5c7e0011',
      createdAt: requestedAt,
      updatedAt: requestedAt,
    });

    const data = dataOf(
      await run('{ myPayoutSchedule { frequency minimumAmount dayOfWeek dayOfMonth bankAccountId nextPayoutDate } }', provider)
    );

    expect(data.myPayoutSchedule).toEqual({
      frequency: 'WEEKLY',
      minimumAmount: 20_000,
      dayOfWeek: 5,
      dayOfMonth: null,
      bankAccountId: '66e2a0c0f0a9d83b5c7e0011',
      nextPayoutDate: '2026-09-18T07:00:00.000Z',
    });
  });

  it('myScheduledPayouts shows why a payout day was skipped, with no fee', async () => {
    db.scheduledPayout.findMany.mockResolvedValue([
      {
        id: '66e2a0c0f0a9d83b5c7e0016',
        providerId: PROVIDER_ID,
        amount: 230_000,
        paymentIds: [],
        scheduledFor: requestedAt,
        status: 'CANCELLED',
        skipReason: 'BELOW_MINIMUM',
        withdrawalId: null,
        processedAt: requestedAt,
        failureReason: 'Scheduled payout skipped because your balance of ₦2,300 is below your minimum of ₦5,000.',
        createdAt: requestedAt,
        updatedAt: requestedAt,
      },
    ]);
    db.scheduledPayout.count.mockResolvedValue(1);

    const data = dataOf(
      await run('{ myScheduledPayouts { items { amount fee netAmount status skipReason failureReason } } }', provider)
    );

    expect(data.myScheduledPayouts.items[0]).toEqual({
      amount: 2_300,
      fee: 0,
      netAmount: 0,
      status: 'CANCELLED',
      skipReason: 'BELOW_MINIMUM',
      failureReason: 'Scheduled payout skipped because your balance of ₦2,300 is below your minimum of ₦5,000.',
    });
  });
});
