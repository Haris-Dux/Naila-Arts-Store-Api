import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QUEUES } from '../../jobs/queues';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { Shipment, ShipmentSchema } from '../shipping/schemas/shipment.schema';
import { MailerService } from './mailer.service';
import {
  OrderCancelledNotificationHandler,
  OrderDeliveredNotificationHandler,
  OrderPaidNotificationHandler,
  OrderPlacedNotificationHandler,
  OrderRefundedNotificationHandler,
  ShipmentDispatchedNotificationHandler,
} from './notifications.listener';
import { NotificationsProcessor } from './notifications.processor';
import { NotificationsService } from './notifications.service';
import { NotificationLog, NotificationLogSchema } from './schemas/notification-log.schema';
import { TemplateService } from './template.service';

/**
 * Two hops on purpose: the outbox guarantees the *event* was recorded with the
 * state change, and BullMQ gives the *delivery* retries, backoff and a
 * dead-letter set. SMTP is slow and unreliable, so it does not belong on the
 * dispatcher's path — a hung mail server would hold up every other message.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: NotificationLog.name, schema: NotificationLogSchema },
      { name: Order.name, schema: OrderSchema },
      { name: Shipment.name, schema: ShipmentSchema },
    ]),
    BullModule.registerQueue({ name: QUEUES.NOTIFICATIONS }),
  ],
  providers: [
    TemplateService,
    MailerService,
    NotificationsService,
    NotificationsProcessor,
    // Discovered by OutboxDispatcher via @OutboxSubscriber.
    OrderPlacedNotificationHandler,
    OrderPaidNotificationHandler,
    // Registered, not just written: the dispatcher finds subscribers through
    // DiscoveryService, which only sees providers.
    OrderCancelledNotificationHandler,
    OrderRefundedNotificationHandler,
    OrderDeliveredNotificationHandler,
    ShipmentDispatchedNotificationHandler,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
