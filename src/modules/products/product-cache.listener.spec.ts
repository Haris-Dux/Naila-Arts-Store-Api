import { CatalogCacheService } from './catalog-cache.service';
import { ProductCacheListener } from './product-cache.listener';

/**
 * The invalidation rule, tested directly.
 *
 * This logic used to exist in three copies — products, inventory and categories
 * each invalidated for themselves — and the copies had drifted: a branch move
 * left `GET /products/:id` serving the old `categoryId` until the entry expired.
 *
 * There is one copy now, and this is it.
 */
describe('ProductCacheListener', () => {
  const makeCache = () => ({ invalidate: jest.fn().mockResolvedValue(undefined) });

  const listen = (cache: { invalidate: jest.Mock }) =>
    new ProductCacheListener(cache as unknown as CatalogCacheService);

  it('retires the whole catalogue once per change', async () => {
    // Every cached view — by id, by slug, list pages, feed batches — sits under
    // one version, so a single retirement covers any set of products.
    const cache = makeCache();
    await listen(cache).onProductsChanged();

    expect(cache.invalidate).toHaveBeenCalledTimes(1);
  });

  it('never lets a cache failure escape', async () => {
    // The write it describes has already committed. A stale entry is not worth
    // failing a completed sale or a completed category move over.
    const cache = { invalidate: jest.fn().mockRejectedValue(new Error('redis is down')) };
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(listen(cache).onProductsChanged()).resolves.toBeUndefined();
  });
});
