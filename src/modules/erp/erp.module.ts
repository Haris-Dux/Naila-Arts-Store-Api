import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Product, ProductSchema } from '../products/schemas/product.schema';
import { ErpStockSyncService } from './erp-stock-sync.service';
import { Suit, SuitSchema } from './schemas/suit.schema';
import { SyncCheckpoint, SyncCheckpointSchema } from './schemas/sync-checkpoint.schema';
import { SuitsController } from './suits.controller';
import { SuitsService } from './suits.service';

/**
 * The seam between the store and the ERP it shares a database with.
 *
 * Two jobs: keep `Product.stock` matching the ERP's `suits.quantity`, which is the
 * source of truth for any product built on a suit; and let the dashboard look
 * suits up so a product can be built on one.
 *
 * Registers the Product model rather than importing ProductsModule — the same
 * call CategoriesModule makes: it needs the collection, not the service, and
 * importing the module would drag its dependency graph in behind it.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Suit.name, schema: SuitSchema },
      { name: SyncCheckpoint.name, schema: SyncCheckpointSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
  ],
  controllers: [SuitsController],
  providers: [ErpStockSyncService, SuitsService],
  exports: [ErpStockSyncService],
})
export class ErpModule {}
