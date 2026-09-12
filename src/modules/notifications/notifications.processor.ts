import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '../../jobs/queues';
import { NotificationsService } from './notifications.service';
import { NotificationJob } from './notifications.types';

/**
 * Sends queued notifications.
 *
 * Retries and backoff come from DEFAULT_JOB_OPTIONS (5 attempts, exponential
 * from 2s). A job that exhausts them stays in the failed set for a week — that
 * set *is* the dead-letter queue, and it is readable and retryable through
 * GET/POST /ops/queues/failed rather than being a place messages quietly go to
 * die.
 *
 * The old notifications service sent inline from a Kafka handler with no retry
 * at all: a momentarily unreachable SMTP server meant the customer simply never
 * heard that their order had been placed.
 */
@Processor(QUEUES.NOTIFICATIONS, {
  // A handful at a time. Higher would trip most providers' rate limits, and
  // email is not latency-critical.
  concurrency: 5,
})
export class NotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(private readonly notificationsService: NotificationsService) {
    super();
  }

  async process(job: Job<NotificationJob>): Promise<void> {
    // Throwing is how a job is retried; `deliver` is idempotent, so a retry
    // after a send that actually succeeded is a no-op rather than a second email.
    await this.notificationsService.deliver(job.data);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<NotificationJob> | undefined, error: Error): void {
    const attempts = job?.attemptsMade ?? 0;
    const max = job?.opts.attempts ?? 0;

    if (attempts >= max) {
      // Distinct log line: this is the one worth alerting on, because nobody
      // will ever receive this message without intervention.
      this.logger.error(
        `DEAD-LETTERED ${job?.data.kind} to ${job?.data.recipient} after ${attempts} attempts: ${error.message}`,
      );
      return;
    }

    this.logger.warn(
      `Notification ${job?.data.kind} to ${job?.data.recipient} failed (attempt ${attempts}/${max}): ${error.message}`,
    );
  }
}
