import { Injectable, Logger } from '@nestjs/common';
import { OutboxHandler, OutboxSubscriber } from '../outbox/outbox-handler.interface';
import { ShippingService } from './shipping.service';

/**
 * Creates the shipment once an order is paid.
 *
 * Driven by confirmation, not order creation. The old handler fired the moment
 * an order was submitted, so a shipment existed for every order — including ones
 * never paid for, and ones the customer cancelled a minute later.
 *
 * There are two ways an order becomes fulfillable, and both land here:
 *
 *   `order.paid`       — prepaid; the money arrived first.
 *   `order.confirmed`  — cash on delivery; the courier collects on arrival, so
 *                        the parcel must move before any money does.
 *
 * Delivery is at-least-once, so this must be safe to run repeatedly. It is:
 * `createForOrder` upserts, which also means the two events cannot produce two
 * shipments if both ever fired for one order.
 */
@Injectable()
@OutboxSubscriber()
export class ShippingOutboxHandler implements OutboxHandler {
  readonly eventType = 'order.paid';

  private readonly logger = new Logger(ShippingOutboxHandler.name);

  constructor(private readonly shippingService: ShippingService) {}

  async handle(payload: Record<string, unknown>): Promise<void> {
    const orderId = typeof payload.orderId === 'string' ? payload.orderId : null;
    if (!orderId) {
      this.logger.warn('Ignoring order.paid with no orderId');
      return;
    }

    // Errors propagate on purpose: the dispatcher records the failure and retries
    // with backoff. A missing shipment is a customer who paid and never receives
    // their goods, so it must not fail silently.
    await this.shippingService.createForOrder(orderId);
  }
}

/**
 * The cash-on-delivery arm of the same behaviour.
 *
 * A separate subscriber rather than one handler matching two names: the
 * dispatcher keys handlers by a single event type, and duplicating four lines is
 * cheaper than making that registry more clever.
 */
@Injectable()
@OutboxSubscriber()
export class ShippingOrderConfirmedHandler implements OutboxHandler {
  readonly eventType = 'order.confirmed';

  constructor(private readonly delegate: ShippingOutboxHandler) {}

  async handle(payload: Record<string, unknown>): Promise<void> {
    await this.delegate.handle(payload);
  }
}

/**
 * Closes the shipment when its order is cancelled.
 *
 * Without this a cancelled order's shipment stayed PENDING in the warehouse
 * queue and could still be dispatched. Idempotent: `cancelForOrder` does nothing
 * to a shipment that is already cancelled or has left the building.
 */
@Injectable()
@OutboxSubscriber()
export class ShippingOrderCancelledHandler implements OutboxHandler {
  readonly eventType = 'order.cancelled';

  constructor(private readonly shippingService: ShippingService) {}

  async handle(payload: Record<string, unknown>): Promise<void> {
    const orderId = typeof payload.orderId === 'string' ? payload.orderId : null;
    if (!orderId) return;
    await this.shippingService.cancelForOrder(orderId);
  }
}

/**
 * Records the shipment as returned when the order was closed directly.
 *
 * Symmetry with `ShippingOrderCancelledHandler`: `order.cancelled` has always
 * reached back into shipping, and `order.returned` needs the same, or an order
 * marked returned from the order screen leaves its parcel reading DELIVERED.
 * The reverse direction (shipment RETURNED closes the order) is the mirror in
 * ShippingService and is unaffected — this is idempotent, so the two meeting in
 * the middle is a no-op.
 */
@Injectable()
@OutboxSubscriber()
export class ShippingOrderReturnedHandler implements OutboxHandler {
  readonly eventType = 'order.returned';

  constructor(private readonly shippingService: ShippingService) {}

  async handle(payload: Record<string, unknown>): Promise<void> {
    const orderId = typeof payload.orderId === 'string' ? payload.orderId : null;
    if (!orderId) return;
    await this.shippingService.markReturnedForOrder(orderId);
  }
}
