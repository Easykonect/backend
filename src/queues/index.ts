/**
 * Queue Configuration
 * 
 * This module sets up BullMQ queues and workers for:
 * 1. Email sending (transactional emails)
 * 2. Notification processing
 * 3. Background jobs (cleanup, analytics, etc.)
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { config } from '@/config';

// ===========================================
// Redis Connection for BullMQ
// ===========================================
const REDIS_URL = config.redisUrl;

// BullMQ connection options (uses URL string, not Redis instance)
const getConnection = () => ({
  url: REDIS_URL,
  maxRetriesPerRequest: null,
});

// ===========================================
// Queue Names
// ===========================================
export const QUEUE_NAMES = {
  EMAIL: 'email-queue',
  NOTIFICATION: 'notification-queue',
  BACKGROUND: 'background-queue',
} as const;

// ===========================================
// Job Types
// ===========================================
export interface EmailJobData {
  to: string;
  subject: string;
  html: string;
  text?: string;
  template?: string;
  templateData?: Record<string, unknown>;
}

export interface NotificationJobData {
  userId: string;
  type: string;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  sendPush?: boolean;
}

export interface BackgroundJobData {
  jobType: 'CLEANUP_OLD_NOTIFICATIONS' | 'CLEANUP_OLD_MESSAGES' | 'SEND_DAILY_DIGEST' | 'ANALYTICS_SNAPSHOT' | 'UNLOCK_STALE_WALLETS';
  data?: Record<string, unknown>;
}

// ===========================================
// Default Job Options
// ===========================================
const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1000,
  },
  removeOnComplete: {
    age: 86400, // Keep completed jobs for 24 hours
    count: 1000, // Keep last 1000 completed jobs
  },
  removeOnFail: {
    age: 604800, // Keep failed jobs for 7 days
  },
};

// ===========================================
// Queue Instances
// ===========================================
class QueueManager {
  private static instance: QueueManager;
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private events: Map<string, QueueEvents> = new Map();
  private initialized = false;

  private constructor() {}

  static getInstance(): QueueManager {
    if (!this.instance) {
      this.instance = new QueueManager();
    }
    return this.instance;
  }

  /**
   * Initialize all queues
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const connection = getConnection();

    // Create queues
    for (const [, name] of Object.entries(QUEUE_NAMES)) {
      const queue = new Queue(name, { connection });
      this.queues.set(name, queue);

      const queueEvents = new QueueEvents(name, { connection });
      this.events.set(name, queueEvents);

      console.log(`✅ Queue initialized: ${name}`);
    }

    this.initialized = true;
    console.log('✅ All queues initialized');
  }

  /**
   * Get a queue by name
   */
  getQueue(name: string): Queue | undefined {
    return this.queues.get(name);
  }

  /**
   * Get queue events by name
   */
  getQueueEvents(name: string): QueueEvents | undefined {
    return this.events.get(name);
  }

  /**
   * Register a worker for a queue
   */
  registerWorker<T>(
    queueName: string,
    processor: (job: Job<T>) => Promise<void>,
    concurrency: number = 5
  ): Worker {
    const connection = getConnection();
    
    const worker = new Worker<T>(queueName, processor, {
      connection,
      concurrency,
    });

    // Worker event handlers
    worker.on('completed', (job) => {
      console.log(`✅ Job ${job.id} completed in queue ${queueName}`);
    });

    worker.on('failed', (job, err) => {
      console.error(`❌ Job ${job?.id} failed in queue ${queueName}:`, err.message);
    });

    worker.on('error', (err) => {
      console.error(`❌ Worker error in queue ${queueName}:`, err.message);
    });

    this.workers.set(queueName, worker);
    console.log(`✅ Worker registered for queue: ${queueName}`);

    return worker;
  }

  /**
   * Add a job to a queue
   */
  async addJob<T>(
    queueName: string,
    data: T,
    options?: {
      delay?: number;
      priority?: number;
      jobId?: string;
    }
  ): Promise<Job<T> | null> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      console.error(`Queue ${queueName} not found`);
      return null;
    }

    const job = await queue.add(queueName, data, {
      ...defaultJobOptions,
      ...options,
    });

    return job as Job<T>;
  }

  /**
   * Add a job with scheduling (cron pattern)
   */
  async addScheduledJob<T>(
    queueName: string,
    data: T,
    cronPattern: string,
    jobId: string
  ): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      console.error(`Queue ${queueName} not found`);
      return;
    }

    await queue.add(queueName, data, {
      ...defaultJobOptions,
      repeat: {
        pattern: cronPattern,
      },
      jobId,
    });

    console.log(`📅 Scheduled job ${jobId} with pattern: ${cronPattern}`);
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(queueName: string): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  } | null> {
    const queue = this.queues.get(queueName);
    if (!queue) return null;

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return { waiting, active, completed, failed, delayed };
  }

  /**
   * Pause a queue
   */
  async pauseQueue(queueName: string): Promise<void> {
    const queue = this.queues.get(queueName);
    if (queue) {
      await queue.pause();
      console.log(`⏸️ Queue ${queueName} paused`);
    }
  }

  /**
   * Resume a queue
   */
  async resumeQueue(queueName: string): Promise<void> {
    const queue = this.queues.get(queueName);
    if (queue) {
      await queue.resume();
      console.log(`▶️ Queue ${queueName} resumed`);
    }
  }

  /**
   * Clean old jobs from a queue
   */
  async cleanQueue(queueName: string, olderThanMs: number = 86400000): Promise<void> {
    const queue = this.queues.get(queueName);
    if (queue) {
      await queue.clean(olderThanMs, 100, 'completed');
      await queue.clean(olderThanMs * 7, 100, 'failed');
      console.log(`🧹 Queue ${queueName} cleaned`);
    }
  }

  /**
   * Gracefully shutdown all workers and queues
   */
  async shutdown(): Promise<void> {
    console.log('🔄 Shutting down queue system...');

    // Close workers first
    for (const [name, worker] of this.workers) {
      await worker.close();
      console.log(`✅ Worker ${name} closed`);
    }

    // Close queue events
    for (const [name, events] of this.events) {
      await events.close();
      console.log(`✅ Queue events ${name} closed`);
    }

    // Close queues
    for (const [name, queue] of this.queues) {
      await queue.close();
      console.log(`✅ Queue ${name} closed`);
    }

    this.initialized = false;
    console.log('✅ Queue system shutdown complete');
  }
}

// ===========================================
// Singleton instance
// ===========================================
export const queueManager = QueueManager.getInstance();

// ===========================================
// Helper functions for adding jobs
// ===========================================

/**
 * Add an email to the email queue
 */
export async function queueEmail(data: EmailJobData, options?: { delay?: number; priority?: number }): Promise<void> {
  await queueManager.addJob(QUEUE_NAMES.EMAIL, data, options);
}

/**
 * Add a notification to the notification queue
 */
export async function queueNotification(
  data: NotificationJobData,
  options?: { delay?: number; priority?: number }
): Promise<void> {
  await queueManager.addJob(QUEUE_NAMES.NOTIFICATION, data, options);
}

/**
 * Add a background job
 */
export async function queueBackgroundJob(
  data: BackgroundJobData,
  options?: { delay?: number; priority?: number }
): Promise<void> {
  await queueManager.addJob(QUEUE_NAMES.BACKGROUND, data, options);
}

export default queueManager;
