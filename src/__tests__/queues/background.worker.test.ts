/**
 * Background worker: automatic payment releases, withdrawal reconciliation,
 * scheduled payouts, stale wallet locks, cleanup of deleted messages (kept
 * for reported conversations) and the recurring schedule
 */

jest.mock('@/queues', () => ({
  QUEUE_NAMES: { BACKGROUND: 'background-queue' },
  queueManager: { registerWorker: jest.fn(), addScheduledJob: jest.fn() },
}));
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    report: { findMany: jest.fn() },
    message: { findMany: jest.fn(), deleteMany: jest.fn() },
  },
}));
jest.mock('@/services/escrow.service', () => ({
  findBookingsDueForRelease: jest.fn(),
  releaseBookingPayment: jest.fn(),
}));
jest.mock('@/services/notification.service', () => ({ createNotification: jest.fn() }));
jest.mock('@/services/withdrawal.service', () => ({ reconcileProcessingWithdrawals: jest.fn() }));
jest.mock('@/services/payout.service', () => ({ processScheduledPayouts: jest.fn() }));
jest.mock('@/services/wallet.service', () => ({ unlockStaleWallets: jest.fn() }));

import type { Job } from 'bullmq';
import prisma from '@/lib/prisma';
import { queueManager, type BackgroundJobData } from '@/queues';
import { findBookingsDueForRelease, releaseBookingPayment } from '@/services/escrow.service';
import { createNotification } from '@/services/notification.service';
import { reconcileProcessingWithdrawals } from '@/services/withdrawal.service';
import { processScheduledPayouts } from '@/services/payout.service';
import { unlockStaleWallets } from '@/services/wallet.service';
import { initializeBackgroundWorker, scheduleRecurringJobs } from '@/queues/background.worker';

type JobType = BackgroundJobData['jobType'];

// The processor is internal: register the worker and run a job through it
const runJob = (jobType: JobType) => {
  initializeBackgroundWorker();
  const processor = (queueManager.registerWorker as jest.Mock).mock.calls[0][1] as (
    job: Job<BackgroundJobData>
  ) => Promise<void>;
  return processor({ id: 'job-1', data: { jobType } } as unknown as Job<BackgroundJobData>);
};

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

it('registers the processor on the background queue with a concurrency of 2', () => {
  initializeBackgroundWorker();

  expect(queueManager.registerWorker).toHaveBeenCalledWith('background-queue', expect.any(Function), 2);
});

describe('PROCESS_AUTOMATIC_PAYMENT_RELEASES', () => {
  const releases = {
    'booking-1': {
      paymentId: 'pay-1',
      payoutKobo: 930_000,
      bookingId: 'booking-1',
      providerUserId: 'provider-user-1',
      customerUserId: 'customer-1',
      serviceName: 'Deep Cleaning',
    },
    'booking-2': {
      paymentId: 'pay-2',
      payoutKobo: 465_050,
      bookingId: 'booking-2',
      providerUserId: 'provider-user-2',
      customerUserId: 'customer-2',
      serviceName: 'Plumbing',
    },
  };

  const notifiedBookings = () =>
    (createNotification as jest.Mock).mock.calls.map(([input]) => input.metadata.bookingId);

  beforeEach(() => {
    (findBookingsDueForRelease as jest.Mock).mockResolvedValue(['booking-1', 'booking-2']);
    (releaseBookingPayment as jest.Mock).mockImplementation(async (id: keyof typeof releases) => releases[id]);
    (createNotification as jest.Mock).mockResolvedValue({ id: 'notification-1' });
  });

  it('releases every due booking and notifies the provider in naira and the customer', async () => {
    await runJob('PROCESS_AUTOMATIC_PAYMENT_RELEASES');

    expect((releaseBookingPayment as jest.Mock).mock.calls).toEqual([['booking-1'], ['booking-2']]);
    expect(createNotification).toHaveBeenCalledTimes(4);
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'provider-user-1',
      type: 'PAYMENT_RECEIVED',
      metadata: { bookingId: 'booking-1', paymentId: 'pay-1', amount: 9_300 },
    }));
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'customer-1',
      type: 'BOOKING_COMPLETED',
      metadata: { bookingId: 'booking-1' },
    }));
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'provider-user-2',
      type: 'PAYMENT_RECEIVED',
      metadata: { bookingId: 'booking-2', paymentId: 'pay-2', amount: 4_650.5 },
    }));
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'customer-2',
      type: 'BOOKING_COMPLETED',
      metadata: { bookingId: 'booking-2' },
    }));
  });

  it('sends nothing for a booking another run already released', async () => {
    (releaseBookingPayment as jest.Mock).mockImplementation(async (id: keyof typeof releases) =>
      id === 'booking-1' ? null : releases[id]
    );

    await runJob('PROCESS_AUTOMATIC_PAYMENT_RELEASES');

    expect(releaseBookingPayment).toHaveBeenCalledTimes(2);
    expect(notifiedBookings()).toEqual(['booking-2', 'booking-2']);
  });

  it('carries on after a release that throws', async () => {
    (releaseBookingPayment as jest.Mock).mockImplementation(async (id: keyof typeof releases) => {
      if (id === 'booking-1') throw new Error('Write conflict');
      return releases[id];
    });

    await expect(runJob('PROCESS_AUTOMATIC_PAYMENT_RELEASES')).resolves.toBeUndefined();

    expect(releaseBookingPayment).toHaveBeenCalledTimes(2);
    expect(notifiedBookings()).toEqual(['booking-2', 'booking-2']);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('booking-1'), 'Write conflict');
  });

  it('neither fails the job nor stops other releases when a notification fails', async () => {
    (createNotification as jest.Mock).mockRejectedValueOnce(new Error('Socket down'));

    await expect(runJob('PROCESS_AUTOMATIC_PAYMENT_RELEASES')).resolves.toBeUndefined();

    expect(releaseBookingPayment).toHaveBeenCalledTimes(2);
    expect(createNotification).toHaveBeenCalledTimes(4);
    // The money moved, so the release isn't logged as failed
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('payout and wallet jobs', () => {
  const services = [reconcileProcessingWithdrawals, processScheduledPayouts, unlockStaleWallets] as jest.Mock[];

  beforeEach(() => {
    (reconcileProcessingWithdrawals as jest.Mock).mockResolvedValue({ checked: 2, settled: 1 });
    (processScheduledPayouts as jest.Mock).mockResolvedValue({ processed: 1, successful: 1, failed: 0, results: [] });
    (unlockStaleWallets as jest.Mock).mockResolvedValue(3);
  });

  it.each<[JobType, jest.Mock]>([
    ['RECONCILE_WITHDRAWALS', reconcileProcessingWithdrawals as jest.Mock],
    ['PROCESS_SCHEDULED_PAYOUTS', processScheduledPayouts as jest.Mock],
    ['UNLOCK_STALE_WALLETS', unlockStaleWallets as jest.Mock],
  ])('%s runs only its service', async (jobType, service) => {
    await runJob(jobType);

    expect(service).toHaveBeenCalledTimes(1);
    for (const other of services.filter((s) => s !== service)) {
      expect(other).not.toHaveBeenCalled();
    }
  });
});

describe('scheduleRecurringJobs', () => {
  it.each([
    ['PROCESS_AUTOMATIC_PAYMENT_RELEASES', '*/10 * * * *', 'automatic-payment-releases'],
    ['RECONCILE_WITHDRAWALS', '*/30 * * * *', 'reconcile-withdrawals'],
  ])('schedules %s at %s as %s on the background queue', async (jobType, pattern, jobId) => {
    await scheduleRecurringJobs();

    expect(queueManager.addScheduledJob).toHaveBeenCalledWith('background-queue', { jobType }, pattern, jobId);
  });

  it('schedules PROCESS_SCHEDULED_PAYOUTS at 08:00 Lagos time under its existing job id', async () => {
    await scheduleRecurringJobs();

    expect(queueManager.addScheduledJob).toHaveBeenCalledWith(
      'background-queue',
      { jobType: 'PROCESS_SCHEDULED_PAYOUTS' },
      '0 8 * * *',
      'scheduled-payouts',
      { timezone: 'Africa/Lagos' }
    );
  });
});

describe('CLEANUP_OLD_MESSAGES', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const deletedWhere = () => (prisma.message.deleteMany as jest.Mock).mock.calls[0][0].where;

  beforeEach(() => {
    (prisma.report.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.message.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.message.deleteMany as jest.Mock).mockResolvedValue({ count: 3 });
  });

  it('deletes messages soft-deleted over 7 days ago, excluding no conversation when nothing was reported', async () => {
    await runJob('CLEANUP_OLD_MESSAGES');

    expect(prisma.report.findMany).toHaveBeenCalledWith({
      where: { targetType: { in: ['MESSAGE', 'CONVERSATION'] } },
      select: { targetType: true, targetId: true },
    });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(prisma.message.deleteMany).toHaveBeenCalledTimes(1);

    const where = deletedWhere();
    expect(where).toEqual({ isDeleted: true, deletedAt: { lt: expect.any(Date) } });
    // Seven calendar days, allowing for a daylight-saving change
    expect(Math.abs(Date.now() - where.deletedAt.lt.getTime() - 7 * DAY_MS)).toBeLessThan(2 * 60 * 60 * 1000);
  });

  it('keeps deleted messages in reported conversations, including the conversation of a reported message', async () => {
    (prisma.report.findMany as jest.Mock).mockResolvedValue([
      { targetType: 'CONVERSATION', targetId: 'conversation-1' },
      { targetType: 'MESSAGE', targetId: 'message-9' },
      { targetType: 'CONVERSATION', targetId: 'conversation-1' },
    ]);
    (prisma.message.findMany as jest.Mock).mockResolvedValue([{ conversationId: 'conversation-2' }]);

    await runJob('CLEANUP_OLD_MESSAGES');

    expect(prisma.message.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['message-9'] } },
      select: { conversationId: true },
    });
    const where = deletedWhere();
    expect(where).toMatchObject({ isDeleted: true, deletedAt: { lt: expect.any(Date) } });
    expect([...where.conversationId.notIn].sort()).toEqual(['conversation-1', 'conversation-2']);
  });

  it('keeps a conversation reported only through one of its messages', async () => {
    (prisma.report.findMany as jest.Mock).mockResolvedValue([{ targetType: 'MESSAGE', targetId: 'message-9' }]);
    (prisma.message.findMany as jest.Mock).mockResolvedValue([{ conversationId: 'conversation-2' }]);

    await runJob('CLEANUP_OLD_MESSAGES');

    expect(deletedWhere().conversationId).toEqual({ notIn: ['conversation-2'] });
  });
});
