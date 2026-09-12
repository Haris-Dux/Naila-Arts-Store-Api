import { OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export const CACHE_KEY_INDEX = Symbol('CACHE_KEY_INDEX');

/**
 * Remembers which keys were written under a cache version, so they can be
 * deleted the moment that version is retired.
 *
 * Retiring a version already stops its entries being read; this exists for
 * memory. Entries live for a day, Redis runs with `noeviction` (BullMQ requires
 * it), and a busy catalogue retires its version on every sale and every ERP
 * bill — so without deletion, a day's worth of dead copies would pile up until
 * Redis started refusing writes, queue jobs included.
 */
export interface CacheKeyIndex {
  add(indexKey: string, key: string, ttlMs: number): Promise<void>;
  clear(indexKey: string): Promise<void>;
}

/** The test suite runs on cache-manager's in-memory store, which dies with the process. */
export class NoopCacheKeyIndex implements CacheKeyIndex {
  async add(): Promise<void> {}
  async clear(): Promise<void> {}
}

const CLEAR_BATCH = 500;

/**
 * The index as a Redis set per version.
 *
 * The keys written here are the same plain names the cache store writes, so an
 * entry deleted here is the entry the cache would have served.
 */
export class RedisCacheKeyIndex implements CacheKeyIndex, OnModuleDestroy {
  constructor(private readonly client: Redis) {}

  async add(indexKey: string, key: string, ttlMs: number): Promise<void> {
    // The index expires with the entries it lists, so an index nobody ever
    // clears — its version retired while a slow read was still in flight —
    // cannot outlive them.
    const results = await this.client.multi().sadd(indexKey, key).pexpire(indexKey, ttlMs).exec();
    const failure = results?.find(([error]) => error)?.[0];
    if (failure) throw failure;
  }

  async clear(indexKey: string): Promise<void> {
    // SSCAN in batches rather than SMEMBERS: a version can index thousands of
    // entries, and one huge reply would stall Redis for everything else.
    let cursor = '0';
    do {
      const [next, keys] = await this.client.sscan(indexKey, cursor, 'COUNT', CLEAR_BATCH);
      cursor = next;
      // UNLINK, not DEL: the memory is reclaimed off Redis's main thread.
      if (keys.length > 0) await this.client.unlink(...keys);
    } while (cursor !== '0');
    await this.client.unlink(indexKey);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}
