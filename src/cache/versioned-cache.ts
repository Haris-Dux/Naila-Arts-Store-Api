import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { randomBytes } from 'node:crypto';
import { CACHE_KEY_INDEX, CacheKeyIndex } from './cache-key-index';

/**
 * How long a cached read lives: a day.
 *
 * Freshness does not come from this — every write retires what it affects the
 * moment it commits. The day is the outer bound for a change that bypasses the
 * application entirely, such as an edit made directly in the database.
 */
export const CACHE_ENTRY_TTL_MS = 24 * 60 * 60_000;

/** How often a retirement that failed (Redis unreachable) is attempted again. */
const RETRY_INTERVAL_MS = 5_000;

/** One family of cached reads that is retired as a unit. */
export interface CacheNamespace {
  /** Holds the namespace's current version token. */
  versionKey: string;
  /** Entries are `<prefix>:<version>:<part>`; the index is `<prefix>:index:<version>`. */
  prefix: string;
  /** Lifetime of the version token itself; 0 keeps it forever. */
  versionTtlMs: number;
}

export interface CacheEntry<T> {
  /** The cached value, or undefined on a miss. */
  value: T | undefined;
  /**
   * Store a freshly computed value — under the version this lookup saw, not
   * whatever is current by the time the database has answered.
   */
  save(value: T): Promise<void>;
}

const miss = <T>(): CacheEntry<T> => ({ value: undefined, save: () => Promise.resolve() });

const newToken = (): string => randomBytes(8).toString('hex');

/**
 * Cache-aside reads that a write can retire all at once, with no stale copy
 * able to slip back in.
 *
 * Every namespace has a version token and every key embeds it. Three rules make
 * that correct rather than merely fast:
 *
 *  - **The version is read before the database, and the result is stored under
 *    it.** A read that started before a write, and finishes after the write has
 *    retired the version, stores its now-stale answer under the old version —
 *    where nothing will ever read it. Reading the version again at save time
 *    would file that stale answer under the new one and serve it all day.
 *  - **Tokens are random, not counters.** If the version key were ever lost, a
 *    counter would restart at 1 and resurrect every entry still stored under
 *    v1; a new random token collides with nothing.
 *  - **A retirement that fails is not forgotten.** If Redis is unreachable when
 *    a write commits, the namespace is marked pending: its reads bypass the
 *    cache and the retirement is retried until it lands. Otherwise one Redis
 *    blip during a price change would serve the old price for a day.
 *
 * Retired entries are deleted in the background through the key index, so dead
 * copies do not accumulate for a day in a Redis that cannot evict.
 */
@Injectable()
export class VersionedCache implements OnModuleDestroy {
  private readonly logger = new Logger(VersionedCache.name);
  /** Namespaces whose retirement has not landed yet, by version key. */
  private readonly pending = new Map<string, CacheNamespace>();
  private retryTimer?: NodeJS.Timeout;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @Inject(CACHE_KEY_INDEX) private readonly index: CacheKeyIndex,
  ) {}

  async lookup<T>(namespace: CacheNamespace, part: string): Promise<CacheEntry<T>> {
    // A write this process could not announce: read through until it lands.
    if (this.pending.has(namespace.versionKey) && !(await this.retire(namespace))) {
      return miss<T>();
    }

    const version = await this.attempt(() => this.currentVersion(namespace));
    if (!version) return miss<T>();

    const key = `${namespace.prefix}:${version}:${part}`;
    // cache-manager reports a miss as null; normalise to one absent value.
    const value = (await this.attempt(() => this.cache.get<T>(key))) ?? undefined;

    return {
      value,
      save: async (fresh: T) => {
        await this.attempt(async () => {
          await this.cache.set(key, fresh, CACHE_ENTRY_TTL_MS);
          await this.index.add(this.indexKey(namespace, version), key, CACHE_ENTRY_TTL_MS);
        });
      },
    };
  }

  /**
   * Retire every entry in the namespace. Resolves to whether it took effect; a
   * failure is remembered and retried, never thrown at the write that caused it.
   */
  async retire(namespace: CacheNamespace): Promise<boolean> {
    try {
      const previous = await this.cache.get<unknown>(namespace.versionKey);
      await this.cache.set(namespace.versionKey, newToken(), namespace.versionTtlMs);
      this.pending.delete(namespace.versionKey);

      if (typeof previous === 'string' && previous.length > 0) {
        // Off the write's path: the entries stopped being readable when the
        // version moved, so this is only reclaiming their memory.
        void this.index.clear(this.indexKey(namespace, previous)).catch((error: unknown) => {
          this.logger.warn(
            `Could not delete retired ${namespace.prefix} entries: ${asMessage(error)}`,
          );
        });
      }
      return true;
    } catch (error) {
      this.pending.set(namespace.versionKey, namespace);
      this.scheduleRetry();
      this.logger.warn(
        `Could not retire ${namespace.prefix} entries; reading through to the database until ` +
          `that succeeds: ${asMessage(error)}`,
      );
      return false;
    }
  }

  onModuleDestroy(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  private async currentVersion(namespace: CacheNamespace): Promise<string> {
    const current = await this.cache.get<unknown>(namespace.versionKey);
    if (typeof current === 'string' && current.length > 0) return current;

    // First use, a lost key, or a number left by an earlier release. A fresh
    // random token cannot match any entry already stored.
    const created = newToken();
    await this.cache.set(namespace.versionKey, created, namespace.versionTtlMs);
    return created;
  }

  private indexKey(namespace: CacheNamespace, version: string): string {
    return `${namespace.prefix}:index:${version}`;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      void (async () => {
        for (const namespace of [...this.pending.values()]) await this.retire(namespace);
        if (this.pending.size === 0 && this.retryTimer) {
          clearInterval(this.retryTimer);
          this.retryTimer = undefined;
        }
      })();
    }, RETRY_INTERVAL_MS);
    // Never hold the process open just to retry.
    this.retryTimer.unref();
  }

  /**
   * A cache is an optimisation, never a dependency: with Redis unreachable a
   * read falls through to the database instead of failing.
   */
  private async attempt<T>(operation: () => Promise<T>): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      this.logger.warn(`Cache unavailable, reading through to the database: ${asMessage(error)}`);
      return undefined;
    }
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
