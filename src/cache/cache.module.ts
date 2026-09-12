import KeyvRedis from '@keyv/redis';
import { CacheOptions, CacheModule as NestCacheModule } from '@nestjs/cache-manager';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisConfig } from '../config/configuration';
import { redisUrl } from '../redis/redis.util';
import {
  CACHE_KEY_INDEX,
  CacheKeyIndex,
  NoopCacheKeyIndex,
  RedisCacheKeyIndex,
} from './cache-key-index';
import { VersionedCache } from './versioned-cache';

/**
 * Redis-backed cache.
 *
 * The old stack paired `cache-manager-redis-store@3` with `@nestjs/cache-manager@3`
 * (cache-manager v6 under the hood), and imported it two different ways in two
 * services — one of them a named import the package does not export. v6 is
 * Keyv-based, so `@keyv/redis` is the correct store; with the old pairing the
 * cache silently degraded to in-memory, meaning no sharing across replicas.
 */
@Global()
@Module({
  imports: [
    NestCacheModule.registerAsync({
      isGlobal: true,
      inject: [ConfigService],
      // Explicit return type: without it, the union of the test and production
      // branches is inferred as a narrowed literal and the generic no longer
      // admits a store.
      useFactory: (config: ConfigService): CacheOptions => {
        // Per-entry TTLs are set at the call site; this is only a backstop.
        const ttl = 60_000;

        // Tests fall back to cache-manager's in-memory store so the suite needs
        // no live Redis. Same API and the same code paths under test — only the
        // cross-replica sharing is absent, which a single test process has no
        // use for anyway.
        if (config.getOrThrow<string>('app.env') === 'test') {
          return { ttl };
        }

        const redis = config.getOrThrow<RedisConfig>('redis');
        return { stores: [new KeyvRedis(redisUrl(redis))], ttl };
      },
    }),
  ],
  providers: [
    {
      provide: CACHE_KEY_INDEX,
      inject: [ConfigService],
      useFactory: (config: ConfigService): CacheKeyIndex => {
        // Same reason as the store above: the suite runs without Redis.
        if (config.getOrThrow<string>('app.env') === 'test') return new NoopCacheKeyIndex();

        const redis = config.getOrThrow<RedisConfig>('redis');
        return new RedisCacheKeyIndex(
          new Redis({
            host: redis.host,
            port: redis.port,
            password: redis.password,
            db: redis.db,
            // Fail a command quickly while Redis is away; the caller treats
            // that as "no cleanup this time", never as an error.
            maxRetriesPerRequest: 1,
          }),
        );
      },
    },
    VersionedCache,
  ],
  exports: [NestCacheModule, VersionedCache],
})
export class CacheModule {}
