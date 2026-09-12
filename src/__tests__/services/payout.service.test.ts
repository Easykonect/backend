/**
 * Payout service: pending earnings, payout schedules, the next payout date and
 * scheduled payouts (including the days the job skips)
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn() },
    payoutSchedule: { findMany: jest.fn(), upsert: jest.fn() },
    scheduledPayout: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    wallet: { findUnique: jest.fn() },
    providerBankAccount: { findFirst: jest.fn() },
    userSettings: { findUnique: jest.fn() },
  },
}));
jest.mock('@/lib/redis', () => ({ __esModule: true, default: { getInstance: jest.fn() } }));
jest.mock('@/lib/sentry', () => ({ captureException: jest.fn(), captureWalletError: jest.fn() }));
// Pulled in by the withdrawal service; they would load socket.io and OneSignal
jest.mock('@/services/notification.service', () => ({ createNotification: jest.fn() }));
jest.mock('@/services/push.service', () => ({ sendPushToUser: jest.fn() }));
// Only the request is mocked: the transfer fee and minimum withdrawal stay real
jest.mock('@/services/withdrawal.service', () => ({
  ...jest.requireActual('@/services/withdrawal.service'),
  requestWithdrawal: jest.fn(),
}));
jest.mock('@/services/bank.service', () => ({ getDefaultBankAccount: jest.fn() }));

import type { PayoutSchedule } from '@prisma/client';
import prisma from '@/lib/prisma';
import { createNotification } from '@/services/notification.service';
import { getDefaultBankAccount } from '@/services/bank.service';
import { requestWithdrawal } from '@/services/withdrawal.service';
import {
  getNextPayoutDate,
  getProviderPendingEarnings,
  processScheduledPayouts,
  setPayoutSchedule,
} from '@/services/payout.service';

describe('getProviderPendingEarnings', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const yesterday = new Date(Date.now() - DAY_MS);
  const tomorrow = new Date(Date.now() + DAY_MS);
  const booking = { providerId: 'provider1' };

  // A field a payment never had written is absent, as on MongoDB
  const payments: Record<string, unknown>[] = [
    // Released by the earlier code, which only set payoutAt
    { id: 'released-old', status: 'COMPLETED', booking, providerPayout: 9_300, payoutAt: yesterday, withdrawableAt: yesterday },
    {
      id: 'released',
      status: 'COMPLETED',
      booking,
      providerPayout: 4_650,
      payoutAt: yesterday,
      walletTransactionId: '66e2b4c1f0a9d83b5c7e1a50',
      withdrawableAt: yesterday,
    },
    // Due: the release job credits it within minutes
    { id: 'due', status: 'COMPLETED', booking, providerPayout: 5_580, payoutAt: null, walletTransactionId: null, withdrawableAt: yesterday },
    { id: 'held', status: 'COMPLETED', booking, providerPayout: 930, withdrawableAt: tomorrow },
    { id: 'unconfirmed', status: 'COMPLETED', booking, providerPayout: 1_200, withdrawableAt: null },
    { id: 'refunded', status: 'REFUNDED', booking, providerPayout: 7_000 },
    { id: 'other-provider', status: 'COMPLETED', booking: { providerId: 'provider2' }, providerPayout: 50_000 },
  ];

  /** Enough of Prisma's MongoDB filter rules for these queries */
  const matches = (doc: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, condition]) => {
      if (key === 'AND') return (condition as Record<string, unknown>[]).every((c) => matches(doc, c));
      if (key === 'OR') return (condition as Record<string, unknown>[]).some((c) => matches(doc, c));

      const value = doc[key];
      if (condition === null) return value === null;
      if (typeof condition !== 'object') return value === condition;

      const filter = condition as Record<string, unknown>;
      const time = value instanceof Date ? value.getTime() : null;
      if ('isSet' in filter) return (value !== undefined) === filter.isSet;
      if ('lte' in filter) return time !== null && time <= (filter.lte as Date).getTime();
      if ('gt' in filter) return time !== null && time > (filter.gt as Date).getTime();
      return typeof value === 'object' && value !== null && matches(value as Record<string, unknown>, filter);
    });

  beforeEach(() => {
    (prisma.payment.findMany as jest.Mock).mockImplementation(async ({ where }) =>
      payments.filter((payment) => matches(payment, where))
    );
  });

  it('counts only earnings still in escrow, not ones released the old way, and the wallet balance as available now', async () => {
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValue({ balance: 1_250_050, isLocked: false });

    const result = await getProviderPendingEarnings('provider1', 'user1');

    expect(result).toMatchObject({
      availableNow: 12_500.5,
      // due + held + unconfirmed
      totalPending: 7_710,
      pendingClearance: 2_130,
      nextAvailableDate: tomorrow.toISOString(),
    });
    expect(result.releasedPaymentIds).toEqual(['due']);
    expect(result.pendingPayments.map((p) => p.id)).toEqual(['held', 'unconfirmed']);
    expect(prisma.wallet.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user1' },
      select: { balance: true, isLocked: true },
    });
  });

  it.each([
    ['a withdrawal holds the wallet', { balance: 900_000, isLocked: true }],
    ['the provider has no wallet', null],
  ])('reports nothing available now when %s', async (_label, wallet) => {
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValue(wallet);

    const result = await getProviderPendingEarnings('provider1', 'user1');

    expect(result).toMatchObject({ availableNow: 0, pendingClearance: 2_130, totalPending: 7_710 });
  });
});

describe('setPayoutSchedule', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-12T09:00:00Z') });
    (prisma.userSettings.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.providerBankAccount.findFirst as jest.Mock).mockResolvedValue({ id: 'bank1' });
    (prisma.payoutSchedule.upsert as jest.Mock).mockImplementation(async ({ create }) => ({
      id: 'schedule1',
      ...create,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  });

  afterEach(() => jest.useRealTimers());

  it.each([[999.99], [1_000_000.01], [-5_000]])(
    'refuses a minimum of %p naira, which no payout could meet',
    async (minimumAmount) => {
      await expect(
        setPayoutSchedule('provider1', 'user1', { frequency: 'DAILY', minimumAmount })
      ).rejects.toMatchObject({
        message: 'Minimum payout amount must be between ₦1,000 and ₦1,000,000',
        extensions: { code: 'INVALID_INPUT' },
      });

      expect(prisma.payoutSchedule.upsert).not.toHaveBeenCalled();
    }
  );

  it.each([
    [1_000, 100_000],
    [1_000_000, 100_000_000],
    [7_500.25, 750_025],
    [null, 500_000],
    [0, 500_000],
    [undefined, 500_000],
  ])('saves a minimum of %p naira as %p kobo', async (minimumAmount, kobo) => {
    const schedule = await setPayoutSchedule('provider1', 'user1', { frequency: 'DAILY', minimumAmount });

    expect((prisma.payoutSchedule.upsert as jest.Mock).mock.calls[0][0].create.minimumAmount).toBe(kobo);
    expect(schedule.minimumAmount).toBe(kobo / 100);
  });

  it('returns the saved day, bank account and next payout date', async () => {
    const schedule = await setPayoutSchedule('provider1', 'user1', {
      frequency: 'WEEKLY',
      dayOfWeek: 5,
      dayOfMonth: 12,
      bankAccountId: 'bank1',
    });

    expect(schedule).toMatchObject({
      frequency: 'WEEKLY',
      dayOfWeek: 5,
      dayOfMonth: null,
      bankAccountId: 'bank1',
      isActive: true,
      // Friday 18 September, 08:00 in Lagos
      nextPayoutDate: '2026-09-18T07:00:00.000Z',
    });
  });
});

describe('getNextPayoutDate', () => {
  const schedule = (overrides: Partial<PayoutSchedule> = {}) => ({
    frequency: 'DAILY' as PayoutSchedule['frequency'],
    dayOfWeek: null,
    dayOfMonth: null,
    timezone: 'Africa/Lagos',
    isActive: true,
    ...overrides,
  });

  // Saturday 12 September 2026, 10:00 in Lagos (UTC+1)
  const saturdayMorning = new Date('2026-09-12T09:00:00Z');

  it.each([
    ['before today’s 08:00 run', '2026-09-12T06:59:59Z', '2026-09-12T07:00:00.000Z'],
    ['at today’s run', '2026-09-12T07:00:00Z', '2026-09-13T07:00:00.000Z'],
    ['after today’s run', '2026-09-12T09:00:00Z', '2026-09-13T07:00:00.000Z'],
  ])('gives a DAILY schedule the next 08:00 Lagos run %s', (_label, now, expected) => {
    expect(getNextPayoutDate(schedule(), new Date(now))?.toISOString()).toBe(expected);
  });

  it.each([
    ['WEEKLY on Fridays', { frequency: 'WEEKLY', dayOfWeek: 5 }, '2026-09-18T07:00:00.000Z'],
    ['BIWEEKLY on Mondays', { frequency: 'BIWEEKLY', dayOfWeek: 1 }, '2026-09-21T07:00:00.000Z'],
    ['MONTHLY on the 1st', { frequency: 'MONTHLY', dayOfMonth: 1 }, '2026-10-01T07:00:00.000Z'],
    ['MONTHLY on the 12th, already run today', { frequency: 'MONTHLY', dayOfMonth: 12 }, '2026-10-12T07:00:00.000Z'],
  ] as const)('finds the next run for %s', (_label, overrides, expected) => {
    expect(getNextPayoutDate(schedule(overrides), saturdayMorning)?.toISOString()).toBe(expected);
  });

  it('works out the day in the schedule’s time zone', () => {
    // The 07:00 UTC run is 21:00 the day before in Honolulu, so Friday there
    // is the Saturday run
    const honolulu = schedule({ frequency: 'WEEKLY', dayOfWeek: 5, timezone: 'Pacific/Honolulu' });

    expect(getNextPayoutDate(honolulu, saturdayMorning)?.toISOString()).toBe('2026-09-19T07:00:00.000Z');
  });

  it('uses Lagos for a time zone that isn’t valid', () => {
    const invalid = schedule({ frequency: 'WEEKLY', dayOfWeek: 5, timezone: 'Mars/Olympus_Mons' });

    expect(getNextPayoutDate(invalid, saturdayMorning)?.toISOString()).toBe('2026-09-18T07:00:00.000Z');
  });

  it.each([
    ['paused', { isActive: false }],
    ['MANUAL', { frequency: 'MANUAL' }],
  ] as const)('is null for a %s schedule', (_label, overrides) => {
    expect(getNextPayoutDate(schedule(overrides), saturdayMorning)).toBeNull();
  });
});

describe('processScheduledPayouts', () => {
  const now = new Date('2026-09-12T09:00:00Z');
  const schedule = {
    id: 'schedule1',
    providerId: 'provider1',
    frequency: 'DAILY',
    dayOfWeek: null,
    dayOfMonth: null,
    minimumAmount: 500_000, // ₦5,000
    timezone: 'Africa/Lagos',
    isActive: true,
    bankAccountId: 'bank1',
    provider: { id: 'provider1', userId: 'user1', user: { id: 'user1' } },
  };
  const wallet = { id: 'wallet1', userId: 'user1', balance: 750_000, isLocked: false };

  const withSchedules = (...schedules: object[]) =>
    (prisma.payoutSchedule.findMany as jest.Mock).mockResolvedValue(schedules);

  const created = () =>
    (prisma.scheduledPayout.create as jest.Mock).mock.calls.map(([args]) => args.data as Record<string, unknown>);

  beforeEach(() => {
    jest.useFakeTimers({ now });
    withSchedules(schedule);
    (prisma.scheduledPayout.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValue(wallet);
    (prisma.scheduledPayout.create as jest.Mock).mockResolvedValue({ id: 'sp1' });
    (prisma.scheduledPayout.update as jest.Mock).mockResolvedValue({});
    (requestWithdrawal as jest.Mock).mockResolvedValue({ id: 'wd1' });
  });

  afterEach(() => jest.useRealTimers());

  it('withdraws the wallet balance and links the withdrawal to the scheduled payout', async () => {
    const result = await processScheduledPayouts();

    expect(prisma.wallet.findUnique).toHaveBeenCalledWith({ where: { userId: 'user1' } });
    expect(prisma.scheduledPayout.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ providerId: 'provider1', amount: 750_000, status: 'PENDING' }),
    });
    expect(requestWithdrawal).toHaveBeenCalledWith(
      'provider1',
      'user1',
      { amount: 7_500, bankAccountId: 'bank1' },
      { scheduledPayoutId: 'sp1' }
    );
    expect(prisma.scheduledPayout.update).toHaveBeenCalledWith({
      where: { id: 'sp1' },
      data: { status: 'PROCESSING', withdrawalId: 'wd1' },
    });
    expect(result).toMatchObject({ processed: 1, successful: 1, skipped: 0, failed: 0 });
  });

  it('caps the amount at ₦1,000,000', async () => {
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValue({ ...wallet, balance: 250_000_000 });

    await processScheduledPayouts();

    expect((requestWithdrawal as jest.Mock).mock.calls[0][2]).toEqual({ amount: 1_000_000, bankAccountId: 'bank1' });
    expect((prisma.scheduledPayout.create as jest.Mock).mock.calls[0][0].data.amount).toBe(100_000_000);
  });

  it('records a skipped day, without a notification, when the balance is below the minimum', async () => {
    withSchedules(
      schedule,
      {
        ...schedule,
        providerId: 'provider2',
        minimumAmount: 10_000, // ₦100, below the ₦1,000 minimum withdrawal
        provider: { id: 'provider2', userId: 'user2', user: { id: 'user2' } },
      },
      {
        ...schedule,
        providerId: 'provider3',
        provider: { id: 'provider3', userId: 'user3', user: { id: 'user3' } },
      }
    );
    (prisma.wallet.findUnique as jest.Mock)
      .mockResolvedValueOnce({ ...wallet, balance: 499_999 })
      .mockResolvedValueOnce({ ...wallet, id: 'wallet2', userId: 'user2', balance: 99_999 })
      .mockResolvedValueOnce(null);

    const result = await processScheduledPayouts();

    expect(requestWithdrawal).not.toHaveBeenCalled();
    expect(created()).toEqual([
      {
        providerId: 'provider1',
        amount: 499_999,
        paymentIds: [],
        scheduledFor: now,
        status: 'CANCELLED',
        skipReason: 'BELOW_MINIMUM',
        failureReason:
          'Scheduled payout skipped because your balance of ₦4,999.99 is below your minimum of ₦5,000.',
        processedAt: now,
      },
      expect.objectContaining({
        providerId: 'provider2',
        amount: 99_999,
        skipReason: 'BELOW_MINIMUM',
        failureReason: expect.stringContaining('below your minimum of ₦1,000'),
      }),
      // No wallet yet counts as a zero balance
      expect.objectContaining({ providerId: 'provider3', amount: 0, skipReason: 'BELOW_MINIMUM' }),
    ]);
    expect(createNotification).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 3, successful: 0, skipped: 3 });
    expect(result.results[0]).toEqual({
      providerId: 'provider1',
      success: false,
      skipped: 'BELOW_MINIMUM',
      message: expect.stringContaining('below your minimum'),
    });
  });

  it('skips a provider with a scheduled payout in the last 20 hours', async () => {
    (prisma.scheduledPayout.findFirst as jest.Mock).mockResolvedValue({ id: 'sp0' });

    const result = await processScheduledPayouts();

    expect((prisma.scheduledPayout.findFirst as jest.Mock).mock.calls[0][0].where).toEqual({
      providerId: 'provider1',
      scheduledFor: { gte: new Date('2026-09-11T13:00:00Z') },
    });
    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.scheduledPayout.create).not.toHaveBeenCalled();
    expect(requestWithdrawal).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
  });

  it.each([
    [
      'a locked wallet',
      'WALLET_LOCKED',
      () => (prisma.wallet.findUnique as jest.Mock).mockResolvedValue({ ...wallet, isLocked: true }),
      'Scheduled payout skipped because your wallet is locked by a withdrawal that is still open.',
    ],
    [
      'no bank account',
      'NO_BANK_ACCOUNT',
      () => {
        withSchedules({ ...schedule, bankAccountId: null });
        (getDefaultBankAccount as jest.Mock).mockResolvedValue(null);
      },
      'Scheduled payout skipped because you have no bank account for payouts. Add one, or set a default account.',
    ],
  ])('records %s and tells the provider', async (_label, skipReason, arrange, message) => {
    arrange();

    await processScheduledPayouts();

    expect(requestWithdrawal).not.toHaveBeenCalled();
    expect(created()).toEqual([
      expect.objectContaining({ providerId: 'provider1', status: 'CANCELLED', skipReason, failureReason: message }),
    ]);
    expect(createNotification).toHaveBeenCalledWith({
      userId: 'user1',
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Scheduled payout skipped',
      message,
      entityType: 'scheduledPayout',
      entityId: 'sp1',
      metadata: { scheduledPayoutId: 'sp1', skipReason },
    });
  });

  it('records a skip again but doesn’t notify when the last payout was skipped for the same reason', async () => {
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValue({ ...wallet, isLocked: true });
    // Nothing in the last 20 hours; the latest payout is last week's skip
    (prisma.scheduledPayout.findFirst as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ skipReason: 'WALLET_LOCKED' });

    await processScheduledPayouts();

    expect(created()).toEqual([expect.objectContaining({ skipReason: 'WALLET_LOCKED' })]);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('writes at most one record per provider when the job runs twice', async () => {
    const payouts: { id: string; providerId: string; scheduledFor: Date; skipReason?: string }[] = [];
    (prisma.wallet.findUnique as jest.Mock).mockResolvedValue({ ...wallet, isLocked: true });
    (prisma.scheduledPayout.create as jest.Mock).mockImplementation(async ({ data }) => {
      const payout = { id: `sp${payouts.length + 1}`, ...data };
      payouts.push(payout);
      return payout;
    });
    (prisma.scheduledPayout.findFirst as jest.Mock).mockImplementation(async ({ where }) =>
      payouts
        .filter((p) => p.providerId === where.providerId)
        .filter((p) => !where.scheduledFor || p.scheduledFor >= where.scheduledFor.gte)
        .at(-1) ?? null
    );

    await processScheduledPayouts();
    await processScheduledPayouts();

    expect(payouts).toHaveLength(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('pays on the date getNextPayoutDate gives, and not the day before', async () => {
    const monthly = { ...schedule, frequency: 'MONTHLY', dayOfMonth: 1 };
    withSchedules(monthly);
    const next = getNextPayoutDate(monthly as unknown as PayoutSchedule, now) as Date;

    jest.setSystemTime(new Date(next.getTime() - 24 * 60 * 60 * 1000));
    await processScheduledPayouts();
    expect(requestWithdrawal).not.toHaveBeenCalled();

    jest.setSystemTime(next);
    await processScheduledPayouts();
    expect(requestWithdrawal).toHaveBeenCalledTimes(1);
  });

  it('runs a BIWEEKLY schedule on the chosen weekday every other week', async () => {
    withSchedules({ ...schedule, frequency: 'BIWEEKLY', dayOfWeek: 1 }); // Mondays
    const paidOn: string[] = [];

    // Four weeks from Monday 14 September, one run a day at 10:00 in Lagos
    for (let day = 0; day < 28; day++) {
      const runAt = new Date(Date.UTC(2026, 8, 14 + day, 9));
      jest.setSystemTime(runAt);
      (requestWithdrawal as jest.Mock).mockClear();

      await processScheduledPayouts();

      if ((requestWithdrawal as jest.Mock).mock.calls.length > 0) {
        paidOn.push(runAt.toISOString().slice(0, 10));
      }
    }

    expect(paidOn).toEqual(['2026-09-21', '2026-10-05']);
  });
});
