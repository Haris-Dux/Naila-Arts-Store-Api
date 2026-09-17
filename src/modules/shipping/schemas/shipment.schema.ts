import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, HydratedDocument, Types } from 'mongoose';
import { BaseSchemaClass } from '../../../common/schemas/base.schema';
import { Address, AddressSchema } from '../../orders/schemas/order.schema';
import { ShipmentStatus } from '../enums/shipment-status.enum';

export type ShipmentDocument = HydratedDocument<Shipment>;

@Schema({ _id: false })
export class ShipmentItem {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  @Prop({ required: true })
  name!: string;

  @Prop({ type: Number, required: true, min: 1 })
  quantity!: number;
}

export const ShipmentItemSchema = SchemaFactory.createForClass(ShipmentItem);

@Schema({ _id: false })
export class ShipmentEvent {
  @Prop({ type: String, enum: Object.values(ShipmentStatus), required: true })
  status!: ShipmentStatus;

  @Prop({ type: Date, default: Date.now })
  at!: Date;

  @Prop({ type: String, default: null })
  location!: string | null;

  @Prop({ type: String, default: null })
  note!: string | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  by!: Types.ObjectId | null;
}

export const ShipmentEventSchema = SchemaFactory.createForClass(ShipmentEvent);

@Schema({ timestamps: true, collection: 'shipments' })
export class Shipment extends BaseSchemaClass {
  /**
   * One shipment per order, enforced by a unique index.
   *
   * That index is what makes creation idempotent: the handler upserts on this
   * field, so a redelivered `order.paid` updates nothing rather than inserting a
   * second row. The old service built a document, called `create()` with the
   * same data, then `save()`d the first one — two inserts on every single
   * order, before redelivery was even considered.
   */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', required: true })
  orderId!: Types.ObjectId;

  /** Denormalised so support can search without a join. */
  @Prop({ required: true })
  orderNumber!: string;

  /** The signed-in customer, or null when the order was placed as a guest. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null, index: true })
  userId!: Types.ObjectId | null;

  @Prop({
    type: String,
    enum: Object.values(ShipmentStatus),
    default: ShipmentStatus.PENDING,
    index: true,
  })
  status!: ShipmentStatus;

  /** Copied from the order: where it was sent, not where the customer lives now. */
  @Prop({ type: AddressSchema, required: true })
  shippingAddress!: Address;

  @Prop({ type: [ShipmentItemSchema], default: [] })
  items!: ShipmentItem[];

  @Prop({ type: String, default: null })
  carrier!: string | null;

  @Prop({ type: String, default: null })
  trackingNumber!: string | null;

  @Prop({ type: String, default: null })
  trackingUrl!: string | null;

  @Prop({ type: [ShipmentEventSchema], default: [] })
  events!: ShipmentEvent[];

  @Prop({ type: Date, default: null })
  estimatedDeliveryAt!: Date | null;

  @Prop({ type: Date, default: null })
  shippedAt!: Date | null;

  @Prop({ type: Date, default: null })
  deliveredAt!: Date | null;
}

export const ShipmentSchema = SchemaFactory.createForClass(Shipment);

// The idempotency guarantee. Without it, a redelivered event inserts a duplicate.
ShipmentSchema.index({ orderId: 1 }, { unique: true });
ShipmentSchema.index({ userId: 1, createdAt: -1 });
// Warehouse queue: everything not yet dispatched, oldest first.
ShipmentSchema.index({ status: 1, createdAt: 1 });
ShipmentSchema.index({ trackingNumber: 1 }, { sparse: true });
ShipmentSchema.index({ orderNumber: 1 });
