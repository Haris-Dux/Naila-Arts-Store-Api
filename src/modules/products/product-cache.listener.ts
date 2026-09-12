import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EVENTS } from '../../events/domain-events';
import { CatalogCacheService } from './catalog-cache.service';

/**
 * The one place that decides what a product write retires from the cache.
 *
 * Modules that write the products collection directly — inventory for stock,
 * categories for a branch move — announce the change instead of invalidating
 * themselves. That keeps `CatalogCacheService` private to this module, so no
 * other module has to know products are cached at all.
 *
 * It also collapses what used to be three copies of the invalidation rule into
 * one. The copies had already drifted: categories retired the list pages but not
 * the per-product entries, and since a branch move rewrites `categoryId` and
 * `subcategoryId` — both of which the cached product view carries — a product
 * detail page served the old placement until its TTL ran out.
 */
@Injectable()
export class ProductCacheListener {
  private readonly logger = new Logger(ProductCacheListener.name);

  constructor(private readonly cache: CatalogCacheService) {}

  @OnEvent(EVENTS.PRODUCTS_CHANGED)
  async onProductsChanged(): Promise<void> {
    try {
      // One retirement covers every cached product view — by id, by slug, list
      // pages and feed batches — so it is the same single call whether the event
      // names one product, many, or none it could enumerate.
      await this.cache.invalidate();
    } catch (error) {
      // A cache is an optimisation, never a dependency. `CatalogCacheService`
      // already swallows a Redis outage; anything reaching here is a bug worth
      // seeing, but still not worth failing the write that has already committed.
      this.logger.error(
        `Failed to retire cached products: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
