import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProductsModule } from '../products/products.module';
import { SizesModule } from '../sizes/sizes.module';
import { InventoryModule } from '../inventory/inventory.module';
import { Payment, PaymentSchema } from '../payments/schemas/payment.schema';
import { Shipment, ShipmentSchema } from '../shipping/schemas/shipment.schema';
import { UsersModule } from '../users/users.module';
import { CheckoutService } from './checkout.service';
import { IdempotencyService } from './idempotency.service';
import { OrderTrackingService } from './order-tracking.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { IdempotencyKey, IdempotencyKeySchema } from './schemas/idempotency-key.schema';
import { Order, OrderSchema } from './schemas/order.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: IdempotencyKey.name, schema: IdempotencyKeySchema },
      // The guest tracking lookup answers "where is my order?" in one call, so
      // it reads the payment and shipment alongside the order. The models, not
      // PaymentsModule or ShippingModule: both of those depend on this one, and
      // importing either back would be a cycle.
      { name: Payment.name, schema: PaymentSchema },
      { name: Shipment.name, schema: ShipmentSchema },
    ]),
    // Checkout reprices the submitted lines from the catalogue and commits
    // stock, both inside one transaction.
    ProductsModule,
    // Checkout resolves the size the customer picked, so the order records it.
    SizesModule,
    InventoryModule,
    // Checkout resolves a signed-in customer's contact details from their
    // account rather than trusting the request body.
    UsersModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, CheckoutService, IdempotencyService, OrderTrackingService],
  exports: [OrdersService],
})
export class OrdersModule {}
