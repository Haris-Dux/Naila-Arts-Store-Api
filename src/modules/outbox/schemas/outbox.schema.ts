import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, HydratedDocument, Types } from 'mongoose';

export type OutboxDocument = HydratedDocument<OutboxMessage>;

export enum OutboxStatus {
  PENDING = 'PENDING',
  DISPATCHED = 'DISPATCHED',
  FAILED = 'FAILED',
}

/**
 * Transactional outbox.
 *
 * A row is written *inside* the same transaction as the state change it
 * describes, so the fact and its announcement commit together. A worker drains
 * the table afterwards and hands each message to its queue.
 *
 * This closes the gap that a plain "save, then enqueue" leaves open: if the
 * process dies between the commit and the enqueue, the order exists but nothing
 * downstream ever hears about it — no confirmation email, no ERP push, and no
 * record that anything was missed. The old stack had exactly that shape, calling
 * `kafkaClient.emit()` after `save()` with nothing tying the two together.
 */
@Schema({ timestamps: true, collection: 'outbox' })
export class OutboxMessage {
  _id!: Types.ObjectId;

  /** e.g. 'order' — what kind of thing this happened to. */
  @Prop({ required: true })
  aggregateType!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  aggregateId!: Types.ObjectId;

  /** Domain event name, e.g. 'order.placed'. */
  @Prop({ required: true })
  eventType!: string;

  @Prop({ type: Object, required: true })
  payload!: Record<string, unknown>;

  @Prop({ type: String, enum: Object.values(OutboxStatus), default: OutboxStatus.PENDING })
  status!: OutboxStatus;

  /** Not eligible for dispatch before this time; moved forward on retry backoff. */
  @Prop({ type: Date, default: Date.now })
  availableAt!: Date;

  @Prop({ type: Number, default: 0 })
  attempts!: number;

  @Prop({ type: String, default: null })
  lastError!: string | null;

  @Prop({ type: Date, default: null })
  dispatchedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const OutboxSchema = SchemaFactory.createForClass(OutboxMessage);

// The drain query.
OutboxSchema.index({ status: 1, availableAt: 1 });
OutboxSchema.index({ aggregateType: 1, aggregateId: 1 });
OutboxSchema.index({ createdAt: 1 });
