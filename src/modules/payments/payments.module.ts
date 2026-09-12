import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { ManualPaymentProvider } from './provider/manual-payment.provider';
import { PAYMENT_PROVIDERS, PaymentProvider } from './provider/payment-provider.interface';
import { Payment, PaymentSchema } from './schemas/payment.schema';
import { WebhookEvent, WebhookEventSchema } from './schemas/webhook-event.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Payment.name, schema: PaymentSchema },
      { name: WebhookEvent.name, schema: WebhookEventSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
    // Capturing a payment is what moves an order to PAID.
    OrdersModule,
  ],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    ManualPaymentProvider,
    {
      /**
       * The registered providers, injected as a list.
       *
       * Adding a gateway means writing one class that implements PaymentProvider
       * and appending it here — nothing in orders, checkout, or the webhook route
       * changes.
       */
      provide: PAYMENT_PROVIDERS,
      useFactory: (manual: ManualPaymentProvider): PaymentProvider[] => [manual],
      inject: [ManualPaymentProvider],
    },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
