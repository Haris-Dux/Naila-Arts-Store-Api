import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { OutboxDispatcher } from './outbox.dispatcher';
import { OutboxService } from './outbox.service';
import { OutboxMessage, OutboxSchema } from './schemas/outbox.schema';

/**
 * Transactional outbox.
 *
 * Global because any module that changes state inside a transaction may need to
 * announce it, and threading the import through every one of them adds noise
 * without adding safety.
 *
 * OutboxDispatcher drains stored messages onto the in-process event bus, so a
 * recorded event is also an eventually-delivered one. Phase 9 adds the ERP
 * adapter as another subscriber; nothing about the mechanism changes.
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: OutboxMessage.name, schema: OutboxSchema }]),
    // Lets the dispatcher find @OutboxSubscriber providers across the app.
    DiscoveryModule,
  ],
  providers: [OutboxService, OutboxDispatcher],
  exports: [OutboxService, OutboxDispatcher],
})
export class OutboxModule {}
