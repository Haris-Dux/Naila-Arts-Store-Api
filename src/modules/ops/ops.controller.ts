import { InjectQueue } from '@nestjs/bullmq';
import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { QUEUES } from '../../jobs/queues';
import { MinRole } from '../auth/decorators/roles.decorator';
import { OutboxDocument, OutboxMessage, OutboxStatus } from '../outbox/schemas/outbox.schema';
import { UserRole } from '../users/enums/user-role.enum';

/**
 * Operational visibility into the asynchronous machinery.
 *
 * The failed-job set and the FAILED outbox rows are this system's dead-letter
 * queues. Without somewhere to look at them they are just a place messages go
 * quietly to die, and the retry policy becomes a way of hiding failures rather
 * than surviving them.
 *
 * A guarded JSON endpoint rather than a mounted dashboard: it reuses the
 * authorization already in place, is covered by the test suite, and adds no
 * dependencies.
 */
@ApiTags('ops')
@ApiBearerAuth()
@Controller('ops')
@MinRole(UserRole.ADMIN)
export class OpsController {
  constructor(
    @InjectQueue(QUEUES.NOTIFICATIONS) private readonly notificationsQueue: Queue,
    @InjectModel(OutboxMessage.name) private readonly outboxModel: Model<OutboxDocument>,
  ) {}

  @Get('queues')
  @ApiOperation({ summary: 'Job counts per queue' })
  @ApiResponse({
    status: 200,
    description: 'Waiting, active, completed, failed and delayed counts',
  })
  async queues() {
    const counts = await this.notificationsQueue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    );
    return { [QUEUES.NOTIFICATIONS]: counts };
  }

  /**
   * The dead-letter view: jobs that exhausted their retries.
   *
   * Each carries the payload and the last failure, so an operator can see who
   * did not get their email and why.
   */
  @Get('queues/failed')
  @ApiOperation({ summary: 'Jobs that exhausted their retries' })
  async failedJobs(@Query('limit') limit = '20') {
    const jobs = await this.notificationsQueue.getFailed(0, Math.min(Number(limit) || 20, 100) - 1);

    return jobs.map((job) => ({
      id: job.id,
      name: job.name,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason,
      // Enough to identify the customer and the message, without dumping the
      // whole rendered email into an API response.
      recipient: (job.data as { recipient?: string }).recipient ?? null,
      kind: (job.data as { kind?: string }).kind ?? null,
      failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
    }));
  }

  /** Requeue everything in the failed set — after fixing whatever broke. */
  @Post('queues/failed/retry')
  @ApiOperation({ summary: 'Retry every failed job' })
  async retryFailed() {
    const jobs = await this.notificationsQueue.getFailed();
    for (const job of jobs) await job.retry();
    return { retried: jobs.length };
  }

  /**
   * Outbox health.
   *
   * `oldestPendingAgeSeconds` is the number worth alerting on: a rising value
   * means the dispatcher has stopped draining, which is invisible from request
   * metrics alone because nothing user-facing fails.
   */
  @Get('outbox')
  @ApiOperation({ summary: 'Outbox depth and staleness' })
  async outbox() {
    const [pending, dispatched, failed, oldest] = await Promise.all([
      this.outboxModel.countDocuments({ status: OutboxStatus.PENDING }),
      this.outboxModel.countDocuments({ status: OutboxStatus.DISPATCHED }),
      this.outboxModel.countDocuments({ status: OutboxStatus.FAILED }),
      this.outboxModel
        .findOne({ status: OutboxStatus.PENDING })
        .sort({ createdAt: 1 })
        .select('createdAt')
        .lean()
        .exec(),
    ]);

    return {
      pending,
      dispatched,
      failed,
      oldestPendingAgeSeconds: oldest
        ? Math.floor((Date.now() - new Date(oldest.createdAt).getTime()) / 1000)
        : null,
    };
  }

  /** Messages abandoned after the attempt ceiling — these need a human. */
  @Get('outbox/failed')
  @ApiOperation({ summary: 'Outbox messages abandoned after the attempt ceiling' })
  async failedOutbox(@Query('limit') limit = '20') {
    const messages = await this.outboxModel
      .find({ status: OutboxStatus.FAILED })
      .sort({ updatedAt: -1 })
      .limit(Math.min(Number(limit) || 20, 100))
      .lean()
      .exec();

    return messages.map((message) => ({
      id: message._id.toString(),
      eventType: message.eventType,
      aggregateType: message.aggregateType,
      aggregateId: message.aggregateId.toString(),
      attempts: message.attempts,
      lastError: message.lastError,
    }));
  }

  /** Return an abandoned message to the queue once the cause is fixed. */
  @Post('outbox/:id/retry')
  @ApiOperation({ summary: 'Requeue an abandoned outbox message' })
  @ApiResponse({ status: 201, description: 'Message reset to PENDING and due immediately' })
  async retryOutbox(@Param('id') id: string) {
    const result = await this.outboxModel
      .updateOne(
        { _id: id, status: OutboxStatus.FAILED },
        // Attempts reset too, so the fixed message gets a full retry budget
        // rather than dead-lettering again on its next failure.
        { $set: { status: OutboxStatus.PENDING, availableAt: new Date(), attempts: 0 } },
      )
      .exec();

    return { requeued: result.modifiedCount === 1 };
  }
}
