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
      if (this.isDuplicateKey(error)) {
        this.logger.log(`Skipping already-sent notification ${job.dedupeKey}`);
        return;
      }
      throw error;
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
      // Release the claim so the queue's retry can genuinely re-attempt —
      // leaving it would make every retry a no-op and the email never arrive.
      await this.logModel.deleteOne({ _id: claim._id }).exec();
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
