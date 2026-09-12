import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, HydratedDocument, Types } from 'mongoose';

export type NotificationLogDocument = HydratedDocument<NotificationLog>;

export enum NotificationStatus {
  SENT = 'SENT',
  FAILED = 'FAILED',
}

/**
 * A record of every notification actually sent.
 *
 * Two jobs. It is the audit trail support needs when a customer says they never
 * got an email — and, through the unique index on `dedupeKey`, it is what stops
 * the same message being sent twice.
 *
 * That matters because there are two at-least-once hops in front of it: the
 * outbox dispatcher may redeliver, and BullMQ may retry a job whose send
 * actually succeeded before the process died. Neither is exceptional. The old
 * stack had neither guard, so a redelivered Kafka event simply emailed the
 * customer again.
 */
@Schema({ timestamps: true, collection: 'notification_logs' })
export class NotificationLog {
  _id!: Types.ObjectId;

  /** e.g. 'orderPaid'. */
  @Prop({ required: true })
  kind!: string;

  /**
   * Identifies the *thing* being notified about, not the attempt — e.g.
   * `orderPaid:<orderId>`. Two deliveries of the same event share it.
   */
  @Prop({ required: true })
  dedupeKey!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  userId!: Types.ObjectId | null;

  @Prop({ required: true })
  recipient!: string;

  @Prop({ required: true })
  subject!: string;

  @Prop({ type: String, enum: Object.values(NotificationStatus), default: NotificationStatus.SENT })
  status!: NotificationStatus;

  @Prop({ type: String, default: null })
  messageId!: string | null;

  @Prop({ type: String, default: null })
  error!: string | null;

  createdAt!: Date;
}

export const NotificationLogSchema = SchemaFactory.createForClass(NotificationLog);

// The idempotency guarantee.
NotificationLogSchema.index({ dedupeKey: 1 }, { unique: true });
NotificationLogSchema.index({ userId: 1, createdAt: -1 });
NotificationLogSchema.index({ kind: 1, createdAt: -1 });
// A year of delivery history is plenty for support purposes.
NotificationLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 31_536_000 });
