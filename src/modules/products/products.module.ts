import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CategoriesModule } from '../categories/categories.module';
import { Suit, SuitSchema } from '../erp/schemas/suit.schema';
import { MediaModule } from '../media/media.module';
import { SizesModule } from '../sizes/sizes.module';
import { CatalogCacheService } from './catalog-cache.service';
import { ProductCacheListener } from './product-cache.listener';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { Product, ProductSchema } from './schemas/product.schema';

/**
 * The product catalogue.
 *
 * Split out from categories, which are now their own module with their own
 * routes and their own lifecycle. Products depend on categories (a product must
 * name a real branch) and on sizes (it must offer real ones); neither depends
 * back, so the direction is one-way and the graph stays acyclic.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      // Read once, at creation, to take a new product's stock from the ERP suit
      // it is built on. The collection rather than ErpModule, as InventoryModule does.
      { name: Suit.name, schema: SuitSchema },
    ]),
    CategoriesModule,
    SizesModule,
    // Resolves a product's image references, and refuses one that does not exist.
    MediaModule,
  ],
  controllers: [ProductsController],
  // CatalogCacheService is deliberately *not* exported. It caches nothing but
  // products, so this module owns it outright; anything else that writes the
  // collection announces `catalog.products-changed` and the listener below
  // decides what that retires.
  providers: [ProductsService, CatalogCacheService, ProductCacheListener],
  // ProductsService is exported so checkout can reprice an order from the
  // catalogue rather than trust the prices a client sends.
  exports: [ProductsService],
})
export class ProductsModule {}
