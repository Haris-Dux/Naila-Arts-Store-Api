import { JobsOptions } from 'bullmq';

/**
 * Every durable background queue in the application.
 *
 * Anything that is a *side effect* of a state change goes here rather than being
 * called inline: emails, ERP pushes, stock warnings. That keeps the request path
 * fast and — more importantly — makes the work survive a process restart, with
 * retries and a dead-letter trail. The old stack fired these through Kafka with
 * no idempotency and no retry policy, so a redelivery silently re-decremented
 * stock and re-sent email.
 */
export const QUEUES = {
  NOTIFICATIONS: 'notifications',
  ERP_OUTBOX: 'erp-outbox',
  INVENTORY: 'inventory',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Default job policy. Exponential backoff, bounded attempts, and completed jobs
 * kept briefly so a failure can be inspected before it ages out.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  // Failures are retained far longer — they are the dead-letter queue.
  removeOnFail: { age: 7 * 24 * 3600 },
};
