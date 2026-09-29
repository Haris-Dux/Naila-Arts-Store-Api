import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Suit, SuitSchema } from '../erp/schemas/suit.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

/**
 * Stock lives in the ERP's `suits` — one per colour of a product — and is
 * mirrored onto the product's colours, so the catalogue can filter and sort on
 * it without a join. Ownership of both figures is enforced by module boundary:
 * InventoryService is the only place a sale or a return moves them, and
 * UpdateProductDto has no stock key.
 */
@Module({
  imports: [MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      // The collection, not the ErpModule: a colour's stock lives in the ERP's
      // `suits`, and this is the only place allowed to move it.
      { name: Suit.name, schema: SuitSchema },
    ])],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
