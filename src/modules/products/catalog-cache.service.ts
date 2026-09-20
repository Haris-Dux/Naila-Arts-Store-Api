import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CacheEntry, CacheNamespace, VersionedCache } from '../../cache/versioned-cache';

/**
 * Catalogue read cache: products by id and by slug, list pages and feed batches
 * — each kept for a day, all retired together by any catalogue write.
 *
 * Two problems in the old implementation this is built to avoid:
 *
 *  1. `create()` cached under `product_${newProduct.id}` *before* saving, so the
 *     id was undefined and every new product wrote to the same `product_undefined`
 *     key.
 *  2. The product list was cached for an hour by a blanket CacheInterceptor and
 *     never invalidated on write, so the storefront served a stale catalogue —
 *     including prices — long after an edit.
 *
 * One namespace for all four, retired as a unit. A list page's key is the whole
 * query-parameter cross-product, a feed batch's a scroll position, and a product
 * page's a slug the write may just have renamed — none of them can be found from
 * the product id a write knows. So a write retires every cached catalogue read,
 * and whatever is still wanted is rebuilt on its next request.
 *
 * Only public views are stored; staff reads that include drafts bypass it.
 */
const CATALOG: CacheNamespace = {
  // Named for list pages, where it started. Kept rather than renamed so a deploy
  // does not strand the old key; the number it used to hold is replaced by a
  // token on first use.
  versionKey: 'catalog:list:version',
  prefix: 'catalog',
  versionTtlMs: 0,
};

@Injectable()
export class CatalogCacheService {
  constructor(private readonly cache: VersionedCache) {}

  /**
   * Stable fingerprint of a query, independent of key order.
   *
   * Every part is length-prefixed rather than joined on `&` and `=`, because
   * those characters occur in the values. `search` is free text and sorts before
   * `sizing`, `sort` and `subcategoryId`, so
   * `?search=x&sizing=SIZED` and `?search=x%26sizing%3DSIZED` used to flatten to
   * the same string and therefore the same cache entry — letting an anonymous
   * caller serve one query's results under another query's key. A length prefix
   * cannot be forged from inside a value, because the length is counted, not
   * parsed.
   */
  static fingerprint(query: Record<string, unknown>): string {
    const normalised = Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => {
        const text = String(value);
        return `${key.length}:${key}${text.length}:${text}`;
      })
      .join('');
    return createHash('sha1').update(normalised).digest('hex').slice(0, 16);
  }

  /** One product by id. */
  product<T>(id: string): Promise<CacheEntry<T>> {
    return this.cache.lookup<T>(CATALOG, `product:${id}`);
  }

  /** One product page by its slug (already lower-cased by the caller). */
  slug<T>(slug: string): Promise<CacheEntry<T>> {
    return this.cache.lookup<T>(CATALOG, `slug:${slug}`);
  }

  /** A page of the numbered listing, keyed by its query. */
  list<T>(fingerprint: string): Promise<CacheEntry<T>> {
    return this.cache.lookup<T>(CATALOG, `list:${fingerprint}`);
  }

  /** A batch of the endless feed, keyed by the whole query including its cursor. */
  feed<T>(fingerprint: string): Promise<CacheEntry<T>> {
    return this.cache.lookup<T>(CATALOG, `feed:${fingerprint}`);
  }

  /** Called after every catalogue write: retires every cached catalogue read. */
  async invalidate(): Promise<void> {
    await this.cache.retire(CATALOG);
  }
}
