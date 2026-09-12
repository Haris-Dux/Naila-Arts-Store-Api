import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { CategoryCacheService } from './category-cache.service';
import { Category, CategorySchema } from './schemas/category.schema';

/**
 * The category tree.
 *
 * Registers the Product model rather than importing ProductsModule: it needs to
 * count products in a branch and re-point them when a category moves, but
 * ProductsModule depends on this one for placement validation, so importing it
 * back would be a cycle. The model registration is the narrow dependency —
 * the collection, not the service.
 *
 * It caches its own tree — see CategoryCacheService — but does not touch the
 * *catalogue* cache. Re-pointing products announces `catalog.products-changed`;
 * what that retires is the products module's business. The two caches are
 * genuinely independent: a product response carries category *ids* only, never
 * a name, so renaming a category cannot stale a cached product.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Category.name, schema: CategorySchema },
      { name: Product.name, schema: ProductSchema },
    ]),
  ],
  controllers: [CategoriesController],
  // CategoryCacheService is not exported: the tree cache is this module's own
  // business, and a second writer is how a cache and its invalidation drift.
  providers: [CategoriesService, CategoryCacheService],
  // Exported so ProductsService can validate a product's placement in the tree.
  exports: [CategoriesService],
})
export class CategoriesModule {}
