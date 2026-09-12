import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProductsModule } from '../products/products.module';
import { SizesModule } from '../sizes/sizes.module';
import { InventoryModule } from '../inventory/inventory.module';
import { UsersModule } from '../users/users.module';
import { CheckoutService } from './checkout.service';
import { IdempotencyService } from './idempotency.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { IdempotencyKey, IdempotencyKeySchema } from './schemas/idempotency-key.schema';
import { Order, OrderSchema } from './schemas/order.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: IdempotencyKey.name, schema: IdempotencyKeySchema },
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
  providers: [OrdersService, CheckoutService, IdempotencyService],
  exports: [OrdersService],
})
export class OrdersModule {}
