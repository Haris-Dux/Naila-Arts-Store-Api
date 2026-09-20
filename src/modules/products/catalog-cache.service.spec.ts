import { CatalogCacheService } from './catalog-cache.service';

/**
 * The query fingerprint, tested on its own.
 *
 * It is a pure static, and it decides which shoppers share a cached page — so
 * two different queries collapsing onto one key is a correctness bug, not a
 * performance one.
 */
describe('CatalogCacheService.fingerprint', () => {
  const fp = (query: Record<string, unknown>) => CatalogCacheService.fingerprint(query);

  it('ignores key order', () => {
    expect(fp({ a: '1', b: '2' })).toBe(fp({ b: '2', a: '1' }));
  });

  it('drops undefined and null rather than keying on them', () => {
    expect(fp({ a: '1', b: undefined, c: null })).toBe(fp({ a: '1' }));
  });

  it('cannot be collided by a value containing the separators', () => {
    // The whole point. Joining on `&` and `=` without escaping meant
    // `?search=x&sizing=SIZED` and `?search=x%26sizing%3DSIZED` flattened to the
    // same string — so an anonymous caller could serve one query's results
    // under another query's key for as long as the entry lived.
    expect(fp({ search: 'x', sizing: 'SIZED' })).not.toBe(fp({ search: 'x&sizing=SIZED' }));
  });

  it('separates a value ending in a key name from that key', () => {
    expect(fp({ sort: 'price', order: 'asc' })).not.toBe(fp({ sort: 'price&order=asc' }));
  });

  it('distinguishes a value moved into its neighbour', () => {
    expect(fp({ a: 'xy', b: 'z' })).not.toBe(fp({ a: 'x', b: 'yz' }));
  });

  it('is stable for the same query', () => {
    expect(fp({ search: 'lawn', page: 2 })).toBe(fp({ page: 2, search: 'lawn' }));
  });
});
