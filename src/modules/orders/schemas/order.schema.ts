import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, HydratedDocument, Types } from 'mongoose';
import { BaseSchemaClass } from '../../../common/schemas/base.schema';
import { OrderStatus } from '../enums/order-status.enum';

export type OrderDocument = HydratedDocument<Order>;

/**
 * A line as it was actually sold.
 *
 * Note the contrast with the catalogue, which the storefront reads live: an
 * order *must* snapshot. It is the record of what the customer was charged, and
 * it has to stay true even after the catalogue changes, the product is renamed,
 * or it is withdrawn entirely. The catalogue shows current prices; the order
 * preserves the agreed ones.
 *
 * These values are written by the server from the catalogue inside the checkout
 * transaction — never accepted from the client.
 */
@Schema({ _id: false })
export class OrderItemSize {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Size', required: true })
  sizeId!: Types.ObjectId;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  code!: string;
}

export const OrderItemSizeSchema = SchemaFactory.createForClass(OrderItemSize);

@Schema({ _id: false })
export class OrderItem {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Product', required: true })
  productId!: Types.ObjectId;

  /** Name at the time of sale, so an invoice reprints correctly years later. */
  @Prop({ required: true })
  name!: string;

  @Prop({ type: String, default: null })
  sku!: string | null;

  /**
   * The size the customer picked, snapshotted like the name and the price.
   *
   * Null for an unstitched piece. Stored by value rather than by reference for
   * the same reason as the name: the size list is the merchant's to reorder and
   * rename, and a picking slip printed next year must still say what shipped.
   */
  @Prop({ type: OrderItemSizeSchema, default: null })
  size!: OrderItemSize | null;

  /**
   * Minor units, taken from the catalogue at checkout — the *effective* price,
   * so a promotion running at the moment of sale is what the customer is
   * charged and what the order records.
   */
  @Prop({ type: Number, required: true, min: 0 })
  unitPrice!: number;

  @Prop({ type: Number, required: true, min: 1 })
  quantity!: number;

  /** unitPrice × quantity, computed server-side. */
  @Prop({ type: Number, required: true, min: 0 })
  lineTotal!: number;
}

export const OrderItemSchema = SchemaFactory.createForClass(OrderItem);

@Schema({ _id: false })
export class Address {
  @Prop({ required: true, trim: true }) fullName!: string;
  @Prop({ required: true, trim: true }) line1!: string;
  @Prop({ type: String, default: null }) line2!: string | null;
  @Prop({ required: true, trim: true }) city!: string;
  @Prop({ type: String, default: null }) state!: string | null;
  @Prop({ required: true, trim: true }) postalCode!: string;
  /** ISO 3166-1 alpha-2. */
  @Prop({ required: true, uppercase: true, trim: true }) country!: string;
  @Prop({ type: String, default: null }) phone!: string | null;
}

export const AddressSchema = SchemaFactory.createForClass(Address);

/** Append-only audit trail of every status change. */
@Schema({ _id: false })
export class OrderStatusChange {
  @Prop({ type: String, enum: Object.values(OrderStatus), required: true })
  status!: OrderStatus;

  @Prop({ type: Date, default: Date.now })
  at!: Date;

  /** Who made the change; null for system transitions. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  by!: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  note!: string | null;
}

export const OrderStatusChangeSchema = SchemaFactory.createForClass(OrderStatusChange);

@Schema({ timestamps: true, collection: 'orders' })
export class Order extends BaseSchemaClass {
  /** Human-readable reference, quoted in emails and to support. */
  @Prop({ required: true })
  orderNumber!: string;

  /**
   * The signed-in customer, or null for a guest order.
   *
   * Never read from the request body. The old CreateOrderDto carried `userId`,
   * so any signed-in customer could place an order against somebody else's
   * account; here it comes from the token. A guest order has none, and is
   * reached by its order number through the public tracking lookup.
   */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null, index: true })
  userId!: Types.ObjectId | null;

  /**
   * Where confirmations go, and how support identifies the buyer.
   *
   * Stored on the order rather than resolved through `userId` because a guest
   * has no account to resolve, and because a registered customer later changing
   * their address must not rewrite where past confirmations were sent.
   */
  @Prop({ required: true, lowercase: true, trim: true })
  contactEmail!: string;

  @Prop({ required: true, trim: true })
  contactName!: string;

  @Prop({
    type: String,
    enum: Object.values(OrderStatus),
    default: OrderStatus.PENDING,
    index: true,
  })
  status!: OrderStatus;

  @Prop({ type: [OrderItemSchema], required: true })
  items!: OrderItem[];

  // ---- Money, all integer minor units, all computed server-side ----

  @Prop({ type: Number, required: true, min: 0 })
  subtotal!: number;

  @Prop({ type: Number, default: 0, min: 0 })
  shippingTotal!: number;

  @Prop({ type: Number, default: 0, min: 0 })
  taxTotal!: number;

  @Prop({ type: Number, default: 0, min: 0 })
  discountTotal!: number;

  /** subtotal + shipping + tax − discount. */
  @Prop({ type: Number, required: true, min: 0 })
  grandTotal!: number;

  @Prop({ required: true, uppercase: true })
  currency!: string;

  @Prop({ type: AddressSchema, required: true })
  shippingAddress!: Address;

  @Prop({ type: AddressSchema, default: null })
  billingAddress!: Address | null;

  @Prop({ type: [OrderStatusChangeSchema], default: [] })
  statusHistory!: OrderStatusChange[];

  @Prop({ type: String, default: null })
  customerNote!: string | null;

  @Prop({ type: Date, default: Date.now })
  placedAt!: Date;

  @Prop({ type: Date, default: null })
  paidAt!: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt!: Date | null;

  @Prop({ type: Date, default: null })
  returnedAt!: Date | null;

  /**
   * True once stock has been returned to the shelf, so nothing restocks twice.
   *
   * Whole-order granularity is only safe because an order has exactly one
   * shipment — `createForOrder` upserts on a unique `orderId`. A partial-return
   * feature would break this latch silently and needs per-line tracking.
   *
   * Written in the same transaction as the increment, and the order is re-read
   * inside that transaction, so a `withTransaction` retry correctly redoes the
   * restock rather than skipping it.
   */
  @Prop({ type: Boolean, default: false })
  stockReleased!: boolean;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

OrderSchema.index({ orderNumber: 1 }, { unique: true });
// "My orders", newest first.
OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ contactEmail: 1, createdAt: -1 });
// Admin queue: orders in a given state, oldest first.
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ 'items.productId': 1 });

// Analytics: live orders in a booked status, within a placedAt window. Named
// explicitly so the index keeps one stable name in every database.
OrderSchema.index(
  { status: 1, placedAt: -1 },
  { name: 'analytics_status_placedAt', partialFilterExpression: { deletedAt: null } },
);
