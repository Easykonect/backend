/**
 * Payout Worker
 * 
 * Handles scheduled payout processing in the background.
 * 
 * Jobs:
 * - processScheduledPayouts: Processes all due scheduled payouts
 */

import { Job } from 'bullmq';
import { processScheduledPayouts } from '@/services/payout.service';
import logger from '@/lib/logger';

// ==========================================
// Types
// ==========================================

export interface PayoutJobData {
  jobType: 'PROCESS_SCHEDULED_PAYOUTS';
  data?: {
    providerId?: string;
    scheduleId?: string;
  };
}

// ==========================================
// Job Handlers
// ==========================================

/**
 * Process scheduled payout job
 */
export async function processPayoutJob(job: Job<PayoutJobData>) {
  const { jobType, data } = job.data;

  logger.info(`Processing payout job: ${job.id}`, { jobType, data });

  const startTime = Date.now();

  try {
    switch (jobType) {
      case 'PROCESS_SCHEDULED_PAYOUTS':
        return await handleScheduledPayouts();
      
      default:
        logger.warn('Unknown payout job type', { jobType });
        return { success: false, message: 'Unknown job type' };
    }
  } catch (error: any) {
    logger.error(`Payout job failed: ${job.id}`, {
      error: error.message,
      stack: error.stack,
      jobType,
    });
    throw error;
  }
}

/**
 * Process all scheduled payouts that are due
 */
async function handleScheduledPayouts() {
  logger.info('Starting scheduled payouts processing');

  const startTime = Date.now();
  const result = await processScheduledPayouts();

  const duration = Date.now() - startTime;

  logger.info('Scheduled payouts processing completed', {
    duration,
    processed: result.processed,
    successful: result.successful,
    failed: result.failed,
  });

  return {
    success: true,
    ...result,
    duration,
  };
}

export default processPayoutJob;

