import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import Redis from 'ioredis';
import { RedisConfig } from '../config/configuration';

@Injectable()
export class RedisHealthIndicator implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    config: ConfigService,
  ) {
    const redis = config.getOrThrow<RedisConfig>('redis');
    this.client = new Redis({
      host: redis.host,
      port: redis.port,
      password: redis.password,
      db: redis.db,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      // A probe must fail fast; it should never queue behind a reconnect.
      enableOfflineQueue: false,
    });
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    const startedAt = Date.now();

    try {
      if (this.client.status !== 'ready') {
        await this.client.connect();
      }
      await this.client.ping();
      return indicator.up({ responseTimeMs: Date.now() - startedAt });
    } catch (error) {
      return indicator.down({
        message: error instanceof Error ? error.message : 'Redis unreachable',
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
