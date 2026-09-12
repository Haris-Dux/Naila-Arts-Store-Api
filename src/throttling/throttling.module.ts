import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { RedisConfig } from '../config/configuration';

/**
 * Global rate limiting, backed by Redis.
 *
 * Exactly one throttler is registered. That is deliberate: @nestjs/throttler
 * evaluates *every* entry in `throttlers` on every request, so adding a strict
 * "auth" tier here would silently impose its 10/min ceiling on the whole
 * storefront. Routes that need a tighter limit override the default in place
 * with `@Throttle({ default: { limit, ttl } })` — see AuthController.
 *
 * The old gateway applied a flat 10-requests-per-minute to every endpoint,
 * catalogue browsing included, and kept counters in process memory so the real
 * limit multiplied by the replica count. Both are fixed: a workable baseline,
 * with shared state in Redis.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // Generous baseline for browsing; tightened per route where it matters.
        const throttlers = [{ name: 'default', ttl: 60_000, limit: 300 }];

        // Tests use the built-in in-memory storage, so the suite needs no live
        // Redis. Shared storage only matters across replicas, which tests do not have.
        if (config.getOrThrow<string>('app.env') === 'test') {
          return { throttlers };
        }

        const redis = config.getOrThrow<RedisConfig>('redis');
        return {
          throttlers,
          storage: new ThrottlerStorageRedisService({
            host: redis.host,
            port: redis.port,
            password: redis.password,
            db: redis.db,
          }),
        };
      },
    }),
  ],
  exports: [ThrottlerModule],
})
export class ThrottlingModule {}
