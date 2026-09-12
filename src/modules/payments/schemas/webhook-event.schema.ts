import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type WebhookEventDocument = HydratedDocument<WebhookEvent>;

/**
 * Record of every webhook accepted, so a redelivery is a no-op.
 *
 * Gateways retry aggressively and guarantee at-least-once delivery: the same
 * `payment.captured` will arrive more than once, and without this the order
 * would be marked paid twice and any downstream effect duplicated. The unique
 * index on (provider, eventId) is the mechanism — the second insert loses and
 * the handler returns early.
 *
 * This is the same discipline missing from the old Kafka consumers, where a
 * redelivered Order.Created re-decremented stock and re-sent the email.
 */
@Schema({ timestamps: true, collection: 'webhook_events' })
export class WebhookEvent {
  _id!: Types.ObjectId;

  @Prop({ required: true })
  provider!: string;

  /** The provider's event id. */
  @Prop({ required: true })
  eventId!: string;

  @Prop({ required: true })
  type!: string;

  @Prop({ type: Object, default: null })
  payload!: Record<string, unknown> | null;

  @Prop({ type: Date, default: null })
  processedAt!: Date | null;

  createdAt!: Date;
}

export const WebhookEventSchema = SchemaFactory.createForClass(WebhookEvent);

WebhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
// Retention: a gateway will not redeliver an event 30 days later.
WebhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2_592_000 });
