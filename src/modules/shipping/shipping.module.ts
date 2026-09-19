import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrdersModule } from '../orders/orders.module';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { Shipment, ShipmentSchema } from './schemas/shipment.schema';
import { ShippingController } from './shipping.controller';
import {
  ShippingOrderCancelledHandler,
  ShippingOrderConfirmedHandler,
  ShippingOutboxHandler,
} from './shipping.listener';
import { ShippingService } from './shipping.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Shipment.name, schema: ShipmentSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
    // Dispatching a shipment is what moves an order to SHIPPED.
    OrdersModule,
  ],
  controllers: [ShippingController],
  providers: [
    ShippingService,
    ShippingOutboxHandler,
    ShippingOrderConfirmedHandler,
    ShippingOrderCancelledHandler,
  ],
  // Contributed to the dispatcher's handler list in AppModule.
  exports: [
    ShippingService,
    ShippingOutboxHandler,
    ShippingOrderConfirmedHandler,
    ShippingOrderCancelledHandler,
  ],
})
export class ShippingModule {}
