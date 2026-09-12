import { Cache } from 'cache-manager';
import { CacheKeyIndex } from './cache-key-index';
import { CACHE_ENTRY_TTL_MS, CacheNamespace, VersionedCache } from './versioned-cache';

/** Just enough of cache-manager: a Map, with a switch to simulate Redis going away. */
class FakeCache {
  readonly store = new Map<string, unknown>();
  readonly ttls = new Map<string, number>();
  down = false;

  get<T>(key: string): Promise<T | null> {
    if (this.down) return Promise.reject(new Error('Redis unavailable'));
    return Promise.resolve(this.store.has(key) ? (this.store.get(key) as T) : null);
  }

  set<T>(key: string, value: T, ttl?: number): Promise<T> {
    if (this.down) return Promise.reject(new Error('Redis unavailable'));
    this.store.set(key, value);
    this.ttls.set(key, ttl ?? -1);
    return Promise.resolve(value);
  }
}

class FakeIndex implements CacheKeyIndex {
  readonly sets = new Map<string, Set<string>>();
  readonly cleared: string[] = [];

  add(indexKey: string, key: string): Promise<void> {
    const set = this.sets.get(indexKey) ?? new Set<string>();
    set.add(key);
    this.sets.set(indexKey, set);
    return Promise.resolve();
  }

  clear(indexKey: string): Promise<void> {
    this.cleared.push(indexKey);
    this.sets.delete(indexKey);
    return Promise.resolve();
  }
}

const NS: CacheNamespace = { versionKey: 'things:version', prefix: 'things', versionTtlMs: 0 };

describe('VersionedCache', () => {
  let cache: FakeCache;
  let index: FakeIndex;
  let versioned: VersionedCache;

  beforeEach(() => {
    cache = new FakeCache();
    index = new FakeIndex();
    versioned = new VersionedCache(cache as unknown as Cache, index);
  });

  afterEach(() => versioned.onModuleDestroy());

  /** Let the background index cleanup run. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('misses, stores, then hits', async () => {
    const first = await versioned.lookup<string>(NS, 'a');
    expect(first.value).toBeUndefined();
    await first.save('A');

    expect((await versioned.lookup<string>(NS, 'a')).value).toBe('A');
  });

  it('keeps entries for a day, and the version itself forever', async () => {
    const entry = await versioned.lookup<string>(NS, 'a');
    await entry.save('A');

    const entryKey = [...cache.ttls.keys()].find((k) => k.endsWith(':a'))!;
    expect(cache.ttls.get(entryKey)).toBe(CACHE_ENTRY_TTL_MS);
    expect(cache.ttls.get(NS.versionKey)).toBe(0);
  });

  it('stops serving every entry once the namespace is retired', async () => {
    await (await versioned.lookup<string>(NS, 'a')).save('A');
    await (await versioned.lookup<string>(NS, 'b')).save('B');

    await versioned.retire(NS);

    expect((await versioned.lookup<string>(NS, 'a')).value).toBeUndefined();
    expect((await versioned.lookup<string>(NS, 'b')).value).toBeUndefined();
  });

  it('deletes the retired entries through the index', async () => {
    await (await versioned.lookup<string>(NS, 'a')).save('A');
    const oldVersion = cache.store.get(NS.versionKey) as string;

    await versioned.retire(NS);
    await settle();

    expect(index.cleared).toEqual([`things:index:${oldVersion}`]);
  });

  it('never serves a value a slow read computed before a write retired it', async () => {
    // A read begins: it notes the version and misses.
    const slowRead = await versioned.lookup<string>(NS, 'price');
    // Meanwhile a write commits and retires the namespace.
    await versioned.retire(NS);
    // The slow read finally stores what it read before the write: stale.
    await slowRead.save('OLD PRICE');

    // It went under the retired version, so nobody is ever served it.
    expect((await versioned.lookup<string>(NS, 'price')).value).toBeUndefined();
  });

  it('replaces a version left by an earlier release instead of reusing it', async () => {
    // The previous release stored a counter; entries from then were `v1`.
    cache.store.set(NS.versionKey, 1);

    const entry = await versioned.lookup<string>(NS, 'a');

    expect(entry.value).toBeUndefined();
    expect(typeof cache.store.get(NS.versionKey)).toBe('string');
  });

  it('mints a new random version if the version key is lost', async () => {
    await (await versioned.lookup<string>(NS, 'a')).save('A');

    // Lost — flushed, expired, deleted by hand. A counter would restart at 1
    // and resurrect everything stored under v1; a random token cannot.
    cache.store.delete(NS.versionKey);

    expect((await versioned.lookup<string>(NS, 'a')).value).toBeUndefined();
  });

  it('reads through, rather than failing, while Redis is unreachable', async () => {
    cache.down = true;

    const entry = await versioned.lookup<string>(NS, 'a');
    expect(entry.value).toBeUndefined();
    await expect(entry.save('A')).resolves.toBeUndefined();
  });

  it('bypasses the cache until a retirement that failed has landed', async () => {
    await (await versioned.lookup<string>(NS, 'a')).save('OLD');

    // The write commits while Redis is away: the retirement cannot land.
    cache.down = true;
    expect(await versioned.retire(NS)).toBe(false);

    // Redis is back. The stale copy is still stored — it must not be served;
    // the pending retirement lands first.
    cache.down = false;
    expect((await versioned.lookup<string>(NS, 'a')).value).toBeUndefined();
  });

  it('keeps reading through while the retirement still cannot land', async () => {
    await (await versioned.lookup<string>(NS, 'a')).save('OLD');
    cache.down = true;
    await versioned.retire(NS);

    // Redis answers reads again but refuses the version write.
    cache.down = false;
    const realSet = cache.set.bind(cache);
    cache.set = async (key, value, ttl) => {
      if (key === NS.versionKey) throw new Error('write refused');
      return realSet(key, value, ttl);
    };

    expect((await versioned.lookup<string>(NS, 'a')).value).toBeUndefined();
  });

  it('keeps namespaces independent', async () => {
    const alice: CacheNamespace = { versionKey: 'u:v:alice', prefix: 'u:alice', versionTtlMs: 0 };
    const bob: CacheNamespace = { versionKey: 'u:v:bob', prefix: 'u:bob', versionTtlMs: 0 };
    await (await versioned.lookup<string>(alice, 'profile')).save('Alice');
    await (await versioned.lookup<string>(bob, 'profile')).save('Bob');

    await versioned.retire(alice);

    expect((await versioned.lookup<string>(alice, 'profile')).value).toBeUndefined();
    expect((await versioned.lookup<string>(bob, 'profile')).value).toBe('Bob');
  });
});
