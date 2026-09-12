/**
 * Queue manager: recurring jobs, including moving an existing job to a time zone
 */

jest.mock('@/config', () => ({ config: { redisUrl: 'redis://localhost:6379' } }));

const mockQueue = { add: jest.fn(), removeRepeatable: jest.fn() };

jest.mock('bullmq', () => ({
  Queue: jest.fn(() => mockQueue),
  QueueEvents: jest.fn(() => ({ close: jest.fn() })),
  Worker: jest.fn(),
}));

import { queueManager } from '@/queues';

beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  mockQueue.add.mockResolvedValue({});
  mockQueue.removeRepeatable.mockResolvedValue(true);
  await queueManager.initialize();
});

describe('addScheduledJob', () => {
  it('schedules the job in the time zone, then removes the same job scheduled without one', async () => {
    await queueManager.addScheduledJob(
      'background-queue',
      { jobType: 'PROCESS_SCHEDULED_PAYOUTS' },
      '0 8 * * *',
      'scheduled-payouts',
      { timezone: 'Africa/Lagos' }
    );

    expect(mockQueue.add).toHaveBeenCalledWith(
      'background-queue',
      { jobType: 'PROCESS_SCHEDULED_PAYOUTS' },
      expect.objectContaining({ repeat: { pattern: '0 8 * * *', tz: 'Africa/Lagos' }, jobId: 'scheduled-payouts' })
    );
    // BullMQ's key for the old job: same name, pattern and id, no time zone
    expect(mockQueue.removeRepeatable).toHaveBeenCalledWith(
      'background-queue',
      { pattern: '0 8 * * *' },
      'scheduled-payouts'
    );
    // The new schedule exists before the old one goes, so the job is never unscheduled
    expect(mockQueue.add.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueue.removeRepeatable.mock.invocationCallOrder[0]
    );
  });

  it('schedules a job without a time zone as before and removes nothing', async () => {
    await queueManager.addScheduledJob(
      'background-queue',
      { jobType: 'RECONCILE_WITHDRAWALS' },
      '*/30 * * * *',
      'reconcile-withdrawals'
    );

    expect(mockQueue.add).toHaveBeenCalledWith(
      'background-queue',
      { jobType: 'RECONCILE_WITHDRAWALS' },
      expect.objectContaining({ repeat: { pattern: '*/30 * * * *' }, jobId: 'reconcile-withdrawals' })
    );
    expect(mockQueue.removeRepeatable).not.toHaveBeenCalled();
  });
});
