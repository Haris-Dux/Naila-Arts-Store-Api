import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Category, CategorySchema } from '../categories/schemas/category.schema';
import { Order, OrderSchema } from '../orders/schemas/order.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Read-only reporting over orders and the catalogue.
 *
 * Registers the models rather than importing OrdersModule, ProductsModule and
 * CategoriesModule — the same call CategoriesModule already makes about Product.
 * Analytics needs the collections, not the services, and importing three domain
 * modules to read them would drag their dependency graphs (checkout, inventory,
 * media, sizes) in behind them. Nothing depends back on this module.
 *
 * Product and Category are registered even though only Order is queried
 * directly: the $lookup stages take collection *names*, and reading those off
 * the registered models keeps a rename from breaking the pipelines silently.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Category.name, schema: CategorySchema },
    ]),
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
