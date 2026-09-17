import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, HydratedDocument, Types } from 'mongoose';
import { BaseSchemaClass } from '../../../common/schemas/base.schema';
import { PaymentMethod, PaymentStatus } from '../enums/payment-status.enum';

export type PaymentDocument = HydratedDocument<Payment>;

@Schema({ _id: false })
export class PaymentEvent {
  @Prop({ type: String, enum: Object.values(PaymentStatus), required: true })
  status!: PaymentStatus;

  @Prop({ type: Date, default: Date.now })
  at!: Date;

  @Prop({ type: String, default: null })
  note!: string | null;

  /** Null for provider-driven transitions. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  by!: Types.ObjectId | null;
}

export const PaymentEventSchema = SchemaFactory.createForClass(PaymentEvent);

@Schema({ timestamps: true, collection: 'payments' })
export class Payment extends BaseSchemaClass {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', required: true, index: true })
  orderId!: Types.ObjectId;

  /** The signed-in customer, or null when the order was placed as a guest. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null, index: true })
  userId!: Types.ObjectId | null;

  /** Which adapter owns this payment — 'manual' today, a gateway later. */
  @Prop({ required: true })
  provider!: string;

  /** The provider's identifier. Unique per provider. */
  @Prop({ required: true })
  reference!: string;

  @Prop({ type: String, enum: Object.values(PaymentMethod), required: true })
  method!: PaymentMethod;

  @Prop({
    type: String,
    enum: Object.values(PaymentStatus),
    default: PaymentStatus.PENDING,
    index: true,
  })
  status!: PaymentStatus;

  /**
   * Amount due, in integer minor units.
   *
   * Copied from the order at creation and never from the client — the amount
   * charged must equal the amount the order recorded.
   */
  @Prop({ type: Number, required: true, min: 0 })
  amount!: number;

  @Prop({ type: Number, default: 0, min: 0 })
  amountRefunded!: number;

  @Prop({ required: true, uppercase: true })
  currency!: string;

  /** Provider-specific payload handed to the storefront (bank details, redirect URL). */
  @Prop({ type: Object, default: null })
  instructions!: Record<string, unknown> | null;

  @Prop({ type: [PaymentEventSchema], default: [] })
  events!: PaymentEvent[];

  @Prop({ type: Date, default: null })
  capturedAt!: Date | null;

  @Prop({ type: String, default: null })
  failureReason!: string | null;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);

// A reference is unique within a provider, not globally.
PaymentSchema.index({ provider: 1, reference: 1 }, { unique: true });
PaymentSchema.index({ orderId: 1, createdAt: -1 });
PaymentSchema.index({ userId: 1, createdAt: -1 });
PaymentSchema.index({ status: 1, createdAt: -1 });
