import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisConfig } from '../config/configuration';
import { DEFAULT_JOB_OPTIONS, QUEUES } from './queues';

const registeredQueues = Object.values(QUEUES).map((name) => ({ name }));

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = config.getOrThrow<RedisConfig>('redis');
        return {
          connection: {
            host: redis.host,
            port: redis.port,
            password: redis.password,
            db: redis.db,
            // BullMQ requires this; without it blocking commands fail on retry.
            maxRetriesPerRequest: null,
          },
          defaultJobOptions: DEFAULT_JOB_OPTIONS,
        };
      },
    }),
    BullModule.registerQueue(...registeredQueues),
  ],
  exports: [BullModule],
})
export class JobsModule {}
