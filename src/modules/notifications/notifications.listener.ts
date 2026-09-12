import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Money } from '../../common/money';
import { StoreConfig } from '../../config/configuration';
import { OutboxHandler, OutboxSubscriber } from '../outbox/outbox-handler.interface';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { Shipment, ShipmentDocument } from '../shipping/schemas/shipment.schema';
import { NotificationsService } from './notifications.service';
import { NotificationKind } from './template.service';

/**
 * Shared plumbing for the order-driven emails.
 *
 * Money is formatted here rather than in the template: `Money` owns every
 * conversion out of minor units, and a template that did its own arithmetic
 * would be a second place for it to go wrong.
 */
abstract class OrderNotificationHandler implements OutboxHandler {
  abstract readonly eventType: string;
  protected abstract readonly kind: NotificationKind;

  protected readonly logger = new Logger(this.constructor.name);
  private readonly store: StoreConfig;

  constructor(
    private readonly orderModel: Model<OrderDocument>,
    protected readonly notificationsService: NotificationsService,
    config: ConfigService,
  ) {
    this.store = config.getOrThrow<StoreConfig>('store');
  }

  async handle(payload: Record<string, unknown>): Promise<void> {
    const orderId = typeof payload.orderId === 'string' ? payload.orderId : null;
    if (!orderId || !Types.ObjectId.isValid(orderId)) {
      this.logger.warn(`Ignoring ${this.eventType} with no usable orderId`);
      return;
    }

    const order = await this.orderModel.findById(orderId).exec();
    if (!order) {
      // Not an error worth retrying forever: the order is gone, so no email is
      // owed. Returning marks the outbox message delivered.
      this.logger.warn(`Ignoring ${this.eventType}: order ${orderId} no longer exists`);
      return;
    }

    // The order carries its own contact details, so a guest — who has no account
    // to look up — is reachable, and a registered customer who later changes
    // their address does not retroactively redirect past confirmations.
    const recipient = { email: order.contactEmail, name: order.contactName };
    const userId = order.userId ? order.userId.toString() : null;

    const money = (amount: number) => Money.fromMinor(amount, order.currency).format();

    await this.notificationsService.enqueue({
      kind: this.kind,
      // Keyed on the event and the order, so a redelivery cannot email twice.
      dedupeKey: `${this.kind}:${orderId}`,
      recipient: recipient.email,
      recipientName: recipient.name,
      userId,
      locale: this.store.locale,
      data: {
        order: {
          orderNumber: order.orderNumber,
          total: money(order.grandTotal),
          items: order.items.map((item) => ({
            name: item.name,
            size: item.size ? item.size.name : null,
            quantity: item.quantity,
            unitPrice: money(item.unitPrice),
            lineTotal: money(item.lineTotal),
          })),
        },
      },
    });
  }
}

@Injectable()
@OutboxSubscriber()
export class OrderPlacedNotificationHandler extends OrderNotificationHandler {
  readonly eventType = 'order.placed';
  protected readonly kind: NotificationKind = 'orderPlaced';

  constructor(
    @InjectModel(Order.name) orderModel: Model<OrderDocument>,
    notificationsService: NotificationsService,
    config: ConfigService,
  ) {
    super(orderModel, notificationsService, config);
  }
}

@Injectable()
@OutboxSubscriber()
export class OrderPaidNotificationHandler extends OrderNotificationHandler {
  readonly eventType = 'order.paid';
  protected readonly kind: NotificationKind = 'orderPaid';

  constructor(
    @InjectModel(Order.name) orderModel: Model<OrderDocument>,
    notificationsService: NotificationsService,
    config: ConfigService,
  ) {
    super(orderModel, notificationsService, config);
  }
}

/**
 * The three closing emails.
 *
 * `order.cancelled`, `order.refunded` and `order.delivered` were already being
 * recorded by the order state machine and consumed by nobody, so a customer
 * whose order was cancelled heard nothing at all.
 *
 * Cancelled and refunded are separate kinds rather than one: the order stopping
 * and the money coming back are different things to be told, and a customer
 * often receives both.
 */
@Injectable()
@OutboxSubscriber()
export class OrderCancelledNotificationHandler extends OrderNotificationHandler {
  readonly eventType = 'order.cancelled';
  protected readonly kind: NotificationKind = 'orderCancelled';

  constructor(
    @InjectModel(Order.name) orderModel: Model<OrderDocument>,
    notificationsService: NotificationsService,
    config: ConfigService,
  ) {
    super(orderModel, notificationsService, config);
  }
}

@Injectable()
@OutboxSubscriber()
export class OrderRefundedNotificationHandler extends OrderNotificationHandler {
  readonly eventType = 'order.refunded';
  protected readonly kind: NotificationKind = 'orderRefunded';

  constructor(
    @InjectModel(Order.name) orderModel: Model<OrderDocument>,
    notificationsService: NotificationsService,
    config: ConfigService,
  ) {
    super(orderModel, notificationsService, config);
  }
}

@Injectable()
@OutboxSubscriber()
export class OrderDeliveredNotificationHandler extends OrderNotificationHandler {
  readonly eventType = 'order.delivered';
  protected readonly kind: NotificationKind = 'orderDelivered';

  constructor(
    @InjectModel(Order.name) orderModel: Model<OrderDocument>,
    notificationsService: NotificationsService,
    config: ConfigService,
  ) {
    super(orderModel, notificationsService, config);
  }
}

/**
 * The dispatch email, with tracking details.
 *
 * Reads the shipment rather than the order, since the carrier and tracking
 * number are what the customer actually wants.
 */
@Injectable()
@OutboxSubscriber()
export class ShipmentDispatchedNotificationHandler implements OutboxHandler {
  readonly eventType = 'shipment.dispatched';

  private readonly logger = new Logger(ShipmentDispatchedNotificationHandler.name);
  private readonly store: StoreConfig;

  constructor(
    @InjectModel(Shipment.name) private readonly shipmentModel: Model<ShipmentDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly notificationsService: NotificationsService,
    config: ConfigService,
  ) {
    this.store = config.getOrThrow<StoreConfig>('store');
  }

  async handle(payload: Record<string, unknown>): Promise<void> {
    const shipmentId = typeof payload.shipmentId === 'string' ? payload.shipmentId : null;
    if (!shipmentId || !Types.ObjectId.isValid(shipmentId)) {
      this.logger.warn('Ignoring shipment.dispatched with no usable shipmentId');
      return;
    }

    const shipment = await this.shipmentModel.findById(shipmentId).exec();
    if (!shipment) {
      this.logger.warn(`Ignoring shipment.dispatched: shipment ${shipmentId} no longer exists`);
      return;
    }

    const order = await this.orderModel.findById(shipment.orderId).exec();
    if (!order) {
      this.logger.warn(`Ignoring shipment.dispatched: order for ${shipmentId} no longer exists`);
      return;
    }

    await this.notificationsService.enqueue({
      kind: 'shipmentDispatched',
      dedupeKey: `shipmentDispatched:${shipmentId}`,
      recipient: order.contactEmail,
      recipientName: order.contactName,
      userId: order.userId ? order.userId.toString() : null,
      locale: this.store.locale,
      data: {
        shipment: {
          orderNumber: shipment.orderNumber,
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          trackingUrl: shipment.trackingUrl,
          estimatedDeliveryAt: shipment.estimatedDeliveryAt
            ? shipment.estimatedDeliveryAt.toISOString().slice(0, 10)
            : null,
        },
      },
    });
  }
}
