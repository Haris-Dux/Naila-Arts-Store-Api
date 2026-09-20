import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { QUEUES } from '../../jobs/queues';
import { MailerService } from './mailer.service';
import {
  NotificationLog,
  NotificationLogDocument,
  NotificationStatus,
} from './schemas/notification-log.schema';
import { NOTIFICATION_JOB, NotificationJob } from './notifications.types';
import { TemplateService } from './template.service';

export interface EnqueueOptions {
  /**
   * The job carries a secret — a password reset code. It is removed from Redis
   * as soon as it is sent, instead of lingering for the hour completed jobs are
   * normally kept.
   */
  sensitive?: boolean;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly inlineDelivery: boolean;

  constructor(
    @InjectQueue(QUEUES.NOTIFICATIONS) private readonly queue: Queue,
    @InjectModel(NotificationLog.name)
    private readonly logModel: Model<NotificationLogDocument>,
    private readonly templateService: TemplateService,
    private readonly mailerService: MailerService,
    config: ConfigService,
  ) {
    // Tests deliver inline so assertions are deterministic and the suite needs
    // no Redis. The rendering, dedupe and send path is identical either way —
    // only the hop through BullMQ is skipped.
    this.inlineDelivery = config.getOrThrow<string>('app.env') === 'test';
  }

  /**
   * Queue a notification.
   *
   * Enqueueing is deliberately all the caller does: SMTP is slow and fails
   * often, and doing it inline would put a mail server's availability on the
   * request path — or, worse, on the outbox dispatcher's, where a timeout would
   * hold up every other message behind it.
   */
  async enqueue(job: NotificationJob, options: EnqueueOptions = {}): Promise<void> {
    if (this.inlineDelivery) {
      await this.deliver(job);
      return;
    }

    await this.queue.add(NOTIFICATION_JOB, job, {
      // BullMQ refuses a duplicate jobId while the job exists, which cheaply
      // absorbs a fast redelivery. The notification log is the durable guard for
      // everything beyond that window.
      jobId: NotificationsService.toJobId(job.dedupeKey),
      ...(options.sensitive ? { removeOnComplete: true, removeOnFail: { age: 3600 } } : {}),
    });
  }

  /**
   * BullMQ rejects a job id containing `:` — it uses colons as its own Redis key
   * separator. The dedupe key keeps its readable `kind:aggregateId` form for the
   * Mongo index, which has no such restriction.
   */
  static toJobId(dedupeKey: string): string {
    return dedupeKey.replace(/:/g, '-');
  }

  /**
   * Render and send, once.
   *
   * Claims the dedupe key *before* sending. Claiming afterwards would let two
   * concurrent workers both pass the check and both send; this way the loser of
   * the insert race stops immediately.
   */
  async deliver(job: NotificationJob): Promise<void> {
    const rendered = this.templateService.render(job.kind, job.data, job.recipientName, job.locale);

    let claim: NotificationLogDocument;
    try {
      claim = await this.logModel.create({
        kind: job.kind,
        dedupeKey: job.dedupeKey,
        userId: job.userId ? new Types.ObjectId(job.userId) : null,
        recipient: job.recipient,
        subject: rendered.subject,
        status: NotificationStatus.SENT,
      });
    } catch (error) {
      if (!this.isDuplicateKey(error)) throw error;

      /**
       * Someone already holds this key. Whether that means "delivered" or "we
       * tried and it failed" decides what to do next, so ask.
       */
      const held = await this.logModel.findOne({ dedupeKey: job.dedupeKey }).exec();

      if (!held || held.status === NotificationStatus.SENT) {
        this.logger.log(`Skipping already-sent notification ${job.dedupeKey}`);
        return;
      }

      // A previous attempt failed and left its record behind. Re-claim that row
      // rather than inserting a second one, so the audit trail stays a single
      // row per notification and the unique index keeps doing its job.
      held.status = NotificationStatus.SENT;
      held.error = null;
      claim = held;
    }

    try {
      const result = await this.mailerService.send({
        to: job.recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      claim.messageId = result.messageId;
      await claim.save();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      /**
       * Mark the attempt failed; do not delete it.
       *
       * Deleting the row was how a retry got its second chance, but it threw
       * away the only record that anything had been attempted — and if the
       * transport had in fact accepted the message before the connection
       * dropped, the retry sent it again, up to five times, password reset
       * codes included. Keeping the row means the retry re-claims it above,
       * support can see the failure, and a delivery that really did happen is
       * still visible as a row rather than vanishing.
       *
       * The residual ambiguity is real and not solvable here: a send that fails
       * after the server accepted it is indistinguishable from one that never
       * landed. This bounds the damage instead of hiding it.
       */
      try {
        claim.status = NotificationStatus.FAILED;
        claim.error = reason;
        await claim.save();
      } catch (bookkeeping) {
        // Never let the bookkeeping failure replace the real one.
        const note = bookkeeping instanceof Error ? bookkeeping.message : String(bookkeeping);
        this.logger.error(`Could not record the failure of ${job.dedupeKey}: ${note}`);
      }

      this.logger.error(`Failed to send ${job.kind} to ${job.recipient}: ${reason}`);
      throw error;
    }
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === 11000
    );
  }
}
