import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QUEUES } from '../../jobs/queues';
import { OutboxMessage, OutboxSchema } from '../outbox/schemas/outbox.schema';
import { OpsController } from './ops.controller';

/**
 * Admin-only visibility into the queue and the outbox — the two places work can
 * fail without any request failing.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: OutboxMessage.name, schema: OutboxSchema }]),
    BullModule.registerQueue({ name: QUEUES.NOTIFICATIONS }),
  ],
  controllers: [OpsController],
})
export class OpsModule {}
