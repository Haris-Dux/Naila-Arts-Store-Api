import { Injectable } from '@nestjs/common';
import { OutboxHandler, OutboxSubscriber } from '../outbox/outbox-handler.interface';
import { PaymentsService } from './payments.service';

/**
 * Closes the open payment attempt when its order is cancelled.
 *
 * Without this a cancelled order's payment stayed PENDING, and recording it
 * later took money for goods that had already gone back on the shelf.
 * Idempotent: `cancelForOrder` only touches PENDING or AUTHORIZED payments.
 */
@Injectable()
@OutboxSubscriber()
export class PaymentsOrderCancelledHandler implements OutboxHandler {
  readonly eventType = 'order.cancelled';

  constructor(private readonly paymentsService: PaymentsService) {}

  async handle(payload: Record<string, unknown>): Promise<void> {
    const orderId = typeof payload.orderId === 'string' ? payload.orderId : null;
    if (!orderId) return;
    await this.paymentsService.cancelForOrder(orderId);
  }
}
