/**
 * Payment analytics: refunds, full and partial, in the provider earnings
 * report, the admin payment analytics and the refund stats; and the top
 * earning providers
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn(), count: jest.fn() },
    serviceProvider: { findUnique: jest.fn(), findMany: jest.fn() },
    wallet: { findUnique: jest.fn(), findMany: jest.fn() },
    walletTransaction: { groupBy: jest.fn() },
    withdrawal: { aggregate: jest.fn() },
  },
}));

import prisma from '@/lib/prisma';
import {
  getAdminPaymentAnalytics,
  getProviderEarningsReport,
  getRefundStats,
  getTopEarningProviders,
} from '@/services/payment-analytics.service';

const findMany = prisma.payment.findMany as jest.Mock;

const startDate = '2026-09-01T00:00:00.000Z';
const endDate = '2026-09-30T23:59:59.999Z';
const refundedInPeriod = { gte: new Date(startDate), lte: new Date(endDate) };
const refundedPayments = [{ status: 'REFUNDED' }, { refundAmount: { gt: 0 } }];

// Amounts on a payment are in naira
const payment = {
  amount: 10_000,
  commission: 700,
  providerPayout: 9_300,
  paystackFee: 150,
  status: 'COMPLETED',
  refundAmount: null,
  refundedVia: null,
  paidAt: new Date('2026-09-05T10:00:00Z'),
  createdAt: new Date('2026-09-05T09:00:00Z'),
  booking: { providerId: 'provider-1', provider: { id: 'provider-1', businessName: 'Sparkle' } },
};
const completed = { ...payment, id: 'pay-1' };
// Still COMPLETED, with the split already reduced to the ₦15,000 kept
const partiallyRefunded = {
  ...payment,
  id: 'pay-2',
  amount: 20_000,
  refundAmount: 5_000,
  commission: 1_050,
  providerPayout: 13_950,
  refundedVia: 'DISPUTE',
};
const fullyRefunded = {
  ...payment,
  id: 'pay-3',
  amount: 8_000,
  refundAmount: 8_000,
  commission: 0,
  providerPayout: 0,
  status: 'REFUNDED',
  refundedVia: 'DISPUTE',
};
// Refunded before refund amounts were stored
const legacyRefunded = { ...payment, id: 'pay-4', amount: 4_000, status: 'REFUNDED', refundedVia: null };

// Answers each payment query by its filter; the refund query is the only one
// not limited to COMPLETED
const mockPayments = ({ completed: paid = [] as object[], refunds = [] as object[] }) =>
  findMany.mockImplementation(async ({ where }: { where: { status?: string } }) =>
    where.status !== 'COMPLETED' ? refunds : paid
  );

const refundQuery = () => findMany.mock.calls.map(([args]) => args).find((args) => args.where.status !== 'COMPLETED');

beforeEach(() => {
  mockPayments({
    completed: [completed, partiallyRefunded],
    refunds: [partiallyRefunded, fullyRefunded, legacyRefunded],
  });
  (prisma.payment.count as jest.Mock).mockResolvedValue(0);
  (prisma.serviceProvider.findUnique as jest.Mock).mockResolvedValue({ userId: 'provider-user-1' });
  (prisma.wallet.findUnique as jest.Mock).mockResolvedValue({ balance: 500_000 });
  (prisma.withdrawal.aggregate as jest.Mock).mockResolvedValue({ _sum: { amount: null } });
});

describe('getProviderEarningsReport', () => {
  it('queries full and partial refunds in the period', async () => {
    await getProviderEarningsReport('provider-1', 'MONTHLY', startDate, endDate);

    expect(refundQuery().where).toEqual({
      booking: { providerId: 'provider-1' },
      OR: refundedPayments,
      refundedAt: refundedInPeriod,
    });
  });

  it('adds refund amounts, counting a legacy REFUNDED payment at its full amount', async () => {
    const report = await getProviderEarningsReport('provider-1', 'MONTHLY', startDate, endDate);

    expect(report.summary).toMatchObject({ totalRefunds: 5_000 + 8_000 + 4_000, refundCount: 3 });
  });

  it('reports what customers paid, the commission, and the provider’s share after refunds as net earnings', async () => {
    const report = await getProviderEarningsReport('provider-1', 'MONTHLY', startDate, endDate);

    // ₦10,000 and ₦20,000 paid; ₦5,000 of the second refunded
    expect(report).toMatchObject({
      totalEarnings: 30_000,
      commissionPaid: 700 + 1_050,
      netEarnings: 9_300 + 13_950,
      completedJobs: 2,
    });
    expect(report.totalEarnings - report.commissionPaid - 5_000).toBe(report.netEarnings);
    expect(report.summary).toMatchObject({ grossEarnings: 30_000, refundedOnPayments: 5_000, netEarnings: 23_250 });
  });

  it('breaks net earnings down by period', async () => {
    const report = await getProviderEarningsReport('provider-1', 'MONTHLY', startDate, endDate);

    expect(report.breakdown).toEqual([{ date: '2026-09', earnings: 23_250, jobs: 2 }]);
  });

  it('counts only the period’s payments not yet released in pendingBalance', async () => {
    const released = { ...partiallyRefunded, payoutAt: new Date('2026-09-08T10:00:00Z'), walletTransactionId: 'txn-9' };
    // Paid out before walletTransactionId was recorded
    const releasedEarlier = {
      ...completed,
      id: 'pay-6',
      amount: 2_000,
      commission: 140,
      providerPayout: 1_860,
      payoutAt: new Date('2026-09-07T10:00:00Z'),
    };
    mockPayments({ completed: [completed, released, releasedEarlier], refunds: [] });

    const report = await getProviderEarningsReport('provider-1', 'MONTHLY', startDate, endDate);

    expect(report.pendingBalance).toBe(9_300);
    // Only the period's payments and its refunds are read, not every held payment
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});

describe('getAdminPaymentAnalytics', () => {
  it('queries full and partial refunds in the period for the provider', async () => {
    await getAdminPaymentAnalytics({ period: 'MONTHLY', startDate, endDate, providerId: 'provider-1' });

    expect(refundQuery().where).toEqual({
      OR: refundedPayments,
      refundedAt: refundedInPeriod,
      booking: { providerId: 'provider-1' },
    });
  });

  it('queries refunds up to now for all time', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-12T09:00:00Z') });

    try {
      await getAdminPaymentAnalytics({ period: 'ALL_TIME' });
    } finally {
      jest.useRealTimers();
    }

    expect(refundQuery().where).toEqual({
      OR: refundedPayments,
      refundedAt: { lte: new Date('2026-09-12T09:00:00Z') },
    });
  });

  it('adds refund amounts, counting a legacy REFUNDED payment at its full amount', async () => {
    const analytics = await getAdminPaymentAnalytics({ period: 'MONTHLY', startDate, endDate });

    expect(analytics.totalRefunds).toBe(17_000);
    expect(analytics.summary).toMatchObject({ totalRefunds: 17_000, refundCount: 3 });
  });

  it('nets refunds out of totalVolume, so it equals the commission plus the providers’ share', async () => {
    const analytics = await getAdminPaymentAnalytics({ period: 'MONTHLY', startDate, endDate });

    // ₦10,000, and ₦20,000 less the ₦5,000 refunded
    expect(analytics.totalVolume).toBe(25_000);
    expect(analytics.totalVolume).toBe(analytics.totalCommission + analytics.summary.totalProviderPayouts);
    expect(analytics.averageTransactionValue).toBe(12_500);
    expect(analytics.netRevenue).toBe(1_750 - 300);
  });

  it('counts only fully refunded payments as refunded and rates refunds over every settled payment', async () => {
    const analytics = await getAdminPaymentAnalytics({ period: 'MONTHLY', startDate, endDate });

    // The partly refunded payment is still COMPLETED, so it isn't also counted as refunded
    expect(analytics.transactionsByStatus).toMatchObject({ completed: 2, refunded: 2 });
    // 3 refunds over 2 completed + 2 fully refunded payments
    expect(analytics.summary.refundRate).toBe(75);
  });

  it.each([
    ['MONTHLY', '2026-09'],
    ['DAILY', '2026-09-05'],
  ] as const)('puts the commission on its row of a %s breakdown', async (period, date) => {
    const analytics = await getAdminPaymentAnalytics({ period, startDate, endDate });

    expect(analytics.dailyBreakdown).toEqual([
      expect.objectContaining({ date, amount: 25_000, count: 2, commission: 700 + 1_050 }),
    ]);
  });
});

describe('getRefundStats', () => {
  const partialCancellation = {
    ...payment,
    id: 'pay-5',
    amount: 6_000,
    refundAmount: 1_500,
    refundedVia: 'CANCELLATION',
  };

  beforeEach(() => {
    mockPayments({ refunds: [fullyRefunded, legacyRefunded, partiallyRefunded, partialCancellation] });
    // Includes both partially refunded payments
    (prisma.payment.count as jest.Mock).mockResolvedValue(10);
  });

  it('queries full and partial refunds in the period', async () => {
    await getRefundStats('MONTHLY', startDate, endDate);

    expect(refundQuery().where).toEqual({ OR: refundedPayments, refundedAt: refundedInPeriod });
    expect(prisma.payment.count).toHaveBeenCalledWith({ where: { status: 'COMPLETED', paidAt: refundedInPeriod } });
  });

  it('counts full and partial refunds separately and groups them by refundedVia', async () => {
    const stats = await getRefundStats('MONTHLY', startDate, endDate);

    expect(stats).toMatchObject({ totalRefunds: 4, totalRefundAmount: 8_000 + 4_000 + 5_000 + 1_500 });
    expect(stats.summary).toMatchObject({ totalCount: 4, fullRefundCount: 2, partialRefundCount: 2 });
    expect(stats.refundsByReason).toEqual([
      { reason: 'DISPUTE', count: 2, amount: 13_000 },
      { reason: 'MANUAL', count: 1, amount: 4_000 },
      { reason: 'CANCELLATION', count: 1, amount: 1_500 },
    ]);
  });

  it('rates refunds against fully refunded plus completed payments, not counting partial refunds twice', async () => {
    const stats = await getRefundStats('MONTHLY', startDate, endDate);

    // 4 refunds out of 2 fully refunded + 10 completed
    expect(stats.refundRate).toBeCloseTo((4 / 12) * 100);
  });

  it('rates nothing when nothing was settled', async () => {
    mockPayments({ refunds: [] });
    (prisma.payment.count as jest.Mock).mockResolvedValue(0);

    const stats = await getRefundStats('MONTHLY', startDate, endDate);

    expect(stats.refundRate).toBe(0);
  });
});

describe('getTopEarningProviders', () => {
  const groupBy = prisma.walletTransaction.groupBy as jest.Mock;
  const now = new Date('2026-09-12T09:00:00Z');

  beforeEach(() => {
    // Highest first, as the database orders them; amounts in kobo
    groupBy.mockResolvedValue([
      { walletId: 'wallet-b', _sum: { amount: 5_580_000 }, _count: { _all: 4 } },
      { walletId: 'wallet-a', _sum: { amount: 1_395_050 }, _count: { _all: 1 } },
      { walletId: 'wallet-gone', _sum: { amount: 100_000 }, _count: { _all: 1 } },
    ]);
    (prisma.wallet.findMany as jest.Mock).mockResolvedValue([
      { id: 'wallet-a', userId: 'user-a' },
      { id: 'wallet-b', userId: 'user-b' },
      { id: 'wallet-gone', userId: 'user-gone' },
    ]);
    (prisma.serviceProvider.findMany as jest.Mock).mockResolvedValue([
      { id: 'provider-a', userId: 'user-a', businessName: 'Sparkle' },
      { id: 'provider-b', userId: 'user-b', businessName: 'Ada Cleaning' },
    ]);
  });

  afterEach(() => jest.useRealTimers());

  it('adds up the earnings released to each provider’s wallet in the period, highest first', async () => {
    jest.useFakeTimers({ now });

    const top = await getTopEarningProviders(5, 'WEEKLY');

    expect(groupBy).toHaveBeenCalledWith({
      by: ['walletId'],
      where: {
        type: 'CREDIT',
        source: 'SERVICE_EARNING',
        createdAt: { gte: new Date('2026-09-05T09:00:00Z'), lte: now },
      },
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: [{ _sum: { amount: 'desc' } }, { walletId: 'asc' }],
      take: 5,
    });
    expect(prisma.wallet.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['wallet-b', 'wallet-a', 'wallet-gone'] } },
      select: { id: true, userId: true },
    });
    // Kobo to naira; a wallet with no provider profile left is left out
    expect(top).toEqual([
      { providerId: 'provider-b', businessName: 'Ada Cleaning', totalEarnings: 55_800, completedJobs: 4 },
      { providerId: 'provider-a', businessName: 'Sparkle', totalEarnings: 13_950.5, completedJobs: 1 },
    ]);
  });

  it('covers all time by default', async () => {
    jest.useFakeTimers({ now });

    await getTopEarningProviders();

    expect(groupBy.mock.calls[0][0]).toMatchObject({
      where: { type: 'CREDIT', source: 'SERVICE_EARNING', createdAt: { lte: now } },
      take: 10,
    });
  });

  it.each([
    [500, 100],
    [0, 10],
    [-3, 10],
  ])('asks for at most 100 providers (limit %p gives %p)', async (limit, take) => {
    await getTopEarningProviders(limit, 'MONTHLY');

    expect(groupBy.mock.calls[0][0].take).toBe(take);
  });

  it('returns an empty list without further lookups when nothing was released', async () => {
    groupBy.mockResolvedValue([]);

    await expect(getTopEarningProviders(10, 'MONTHLY')).resolves.toEqual([]);

    expect(prisma.wallet.findMany).not.toHaveBeenCalled();
    expect(prisma.serviceProvider.findMany).not.toHaveBeenCalled();
  });
});
