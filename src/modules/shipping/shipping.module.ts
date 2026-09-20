import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrdersModule } from '../orders/orders.module';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { Shipment, ShipmentSchema } from './schemas/shipment.schema';
import { ShippingController } from './shipping.controller';
import {
  ShippingOrderCancelledHandler,
  ShippingOrderReturnedHandler,
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
    ShippingOrderReturnedHandler,
  ],
  // Exported for completeness only: the dispatcher finds subscribers through
  // DiscoveryService over the provider list, not through an import.
  exports: [
    ShippingService,
    ShippingOutboxHandler,
    ShippingOrderConfirmedHandler,
    ShippingOrderCancelledHandler,
    ShippingOrderReturnedHandler,
  ],
})
export class ShippingModule {}
