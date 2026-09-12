import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Suit, SuitSchema } from '../erp/schemas/suit.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

/**
 * Stock lives on the product document rather than in its own collection, so a
 * decrement is a single-document atomic update with no join and no second write
 * to keep consistent. Ownership of that field is enforced by module boundary:
 * InventoryService is the only place that writes it, and UpdateProductDto has no
 * `stock` key.
 *
 * Phase 5 adds a reservations collection on top for the checkout window; the
 * on-hand figure stays here.
 */
@Module({
  imports: [MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      // The collection, not the ErpModule: stock for a linked product lives in
      // the ERP's `suits`, and this is the only place allowed to move it.
      { name: Suit.name, schema: SuitSchema },
    ])],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
