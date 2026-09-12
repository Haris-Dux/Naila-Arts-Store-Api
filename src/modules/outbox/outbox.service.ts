import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { OutboxDocument, OutboxMessage, OutboxStatus } from './schemas/outbox.schema';

export interface RecordOutboxInput {
  aggregateType: string;
  aggregateId: Types.ObjectId;
  eventType: string;
  payload: Record<string, unknown>;
}

/** Deliveries attempted before a message is parked as FAILED for a human. */
const MAX_ATTEMPTS = 10;

@Injectable()
export class OutboxService {
  constructor(
    @InjectModel(OutboxMessage.name) private readonly outboxModel: Model<OutboxDocument>,
  ) {}

  /**
   * Record a message. The session is required, not optional: an outbox row
   * written outside the transaction it describes provides none of the guarantee
   * the pattern exists for.
   */
  async record(input: RecordOutboxInput, session: ClientSession): Promise<void> {
    await this.outboxModel.create(
      [
        {
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          eventType: input.eventType,
          payload: input.payload,
          status: OutboxStatus.PENDING,
          availableAt: new Date(),
        },
      ],
      { session },
    );
  }

  /**
   * Atomically claim the oldest due message, or return null.
   *
   * The claim is a lease, not a status flag: `availableAt` is pushed forward so
   * no other worker picks the message up while this one holds it. If the process
   * dies mid-dispatch the lease simply expires and another worker retries —
   * whereas an `IN_FLIGHT` status would strand the message until someone noticed.
   *
   * `findOneAndUpdate` is a single atomic operation, so two workers racing for
   * the same row cannot both win it.
   */
  async claimNext(leaseMs = 60_000): Promise<OutboxDocument | null> {
    return this.outboxModel
      .findOneAndUpdate(
        { status: OutboxStatus.PENDING, availableAt: { $lte: new Date() } },
        { $set: { availableAt: new Date(Date.now() + leaseMs) }, $inc: { attempts: 1 } },
        { sort: { availableAt: 1 }, new: true },
      )
      .exec();
  }

  async markDispatched(id: Types.ObjectId): Promise<void> {
    await this.outboxModel
      .updateOne(
        { _id: id },
        { $set: { status: OutboxStatus.DISPATCHED, dispatchedAt: new Date() } },
      )
      .exec();
  }

  /**
   * Record a failure and back the message off before the next attempt.
   *
   * `attempts` is the count *after* the claim, which already incremented it —
   * incrementing again here would double-count every failure and halve the
   * effective retry ceiling.
   */
  async markFailed(id: Types.ObjectId, error: string, attempts: number): Promise<void> {
    const backoffMs = Math.min(2 ** attempts * 1000, 3_600_000);
    await this.outboxModel
      .updateOne(
        { _id: id },
        {
          $set: {
            lastError: error.slice(0, 1000),
            availableAt: new Date(Date.now() + backoffMs),
            // Stays PENDING so it is retried; FAILED is reserved for messages
            // abandoned after the attempt ceiling.
            status: attempts >= MAX_ATTEMPTS ? OutboxStatus.FAILED : OutboxStatus.PENDING,
          },
        },
      )
      .exec();
  }
}
