import { Injectable } from '@nestjs/common';
import { CacheEntry, CacheNamespace, VersionedCache } from '../../cache/versioned-cache';

/**
 * The category tree and listing — kept for a day, retired on every category write.
 *
 * Categories are the best cache candidate in the application: read on every
 * storefront page for the nav, written almost never, and small enough that
 * deserialising a hit costs less than the query it replaces. The day is only
 * the outer bound for a change that bypasses the service, such as an edit made
 * directly in the database.
 *
 * Staff and shoppers see different trees, so they get different entries:
 * sharing one would let a branch an administrator switched off leak into a
 * shopper's cached nav. `findById` is not cached — one indexed lookup of one
 * small document, off the storefront's hot path.
 */
const CATEGORIES: CacheNamespace = {
  versionKey: 'categories:version',
  prefix: 'categories',
  versionTtlMs: 0,
};

@Injectable()
export class CategoryCacheService {
  constructor(private readonly cache: VersionedCache) {}

  lookup<T>(view: 'list' | 'tree', includeInactive: boolean): Promise<CacheEntry<T>> {
    return this.cache.lookup<T>(CATEGORIES, `${view}:${includeInactive ? 'all' : 'public'}`);
  }

  /**
   * Called after every category write. Retires both views for both audiences:
   * a category appears in the listing and the tree, and activating or
   * deactivating one moves it between the public and staff views.
   */
  async invalidate(): Promise<void> {
    await this.cache.retire(CATEGORIES);
  }
}
