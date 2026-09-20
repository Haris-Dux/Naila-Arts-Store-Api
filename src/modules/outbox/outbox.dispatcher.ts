import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { OUTBOX_SUBSCRIBER, OutboxHandler } from './outbox-handler.interface';
import { OutboxService } from './outbox.service';

const POLL_INTERVAL_MS = 2_000;
const BATCH_SIZE = 25;

/**
 * Drains the outbox to its registered handlers.
 *
 * This is the half of the transactional-outbox pattern that makes the other half
 * worth having: `OutboxService.record()` guarantees a message was *stored* with
 * the state change it describes, and this guarantees it is eventually
 * *delivered*.
 *
 * Delivery is at-least-once by construction — a crash between running the
 * handlers and marking the row done means redelivery — so every handler must be
 * idempotent. Shipment creation upserts for exactly this reason.
 *
 * Polling rather than a change stream: it works on any MongoDB deployment,
 * survives a subscriber being down, and two seconds of latency is immaterial for
 * a confirmation email or an ERP push.
 */
/**
 * Events recorded for completeness that nothing consumes today.
 *
 * Named rather than inferred, so a genuinely orphaned event still gets the
 * warning above. Both are emitted by the order state machine for every order:
 * fulfilment progress is already visible on the order itself, and the customer
 * hears about dispatch through `shipment.dispatched`, which carries the
 * tracking number this one does not.
 */
const UNCONSUMED_EVENTS = new Set(['order.fulfilling', 'order.shipped']);

@Injectable()
export class OutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private readonly handlersByType = new Map<string, OutboxHandler[]>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly pollingEnabled: boolean;

  constructor(
    private readonly outboxService: OutboxService,
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    // Tests drive `drain()` directly so dispatch is deterministic; a background
    // timer would race the assertions.
    this.pollingEnabled = config.getOrThrow<string>('app.env') !== 'test';
  }

  onModuleInit(): void {
    this.registerSubscribers();

    if (!this.pollingEnabled) return;

    this.timer = setInterval(() => {
      void this.drain().catch((error: unknown) => {
        this.logger.error(
          `Outbox drain failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, POLL_INTERVAL_MS);

    // Do not hold the process open at shutdown purely for the next poll.
    this.timer.unref();
    this.logger.log(
      `Outbox dispatcher polling every ${POLL_INTERVAL_MS}ms for [${[...this.handlersByType.keys()].join(', ')}]`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Find every @OutboxSubscriber provider in the application.
   *
   * Discovery rather than injection because this module is global: a provider
   * declared here resolves from this module's own scope, so a token supplied by
   * AppModule would never reach it — the dispatcher would silently see an empty
   * handler list and mark every message delivered with nothing having happened.
   */
  private registerSubscribers(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as OutboxHandler | undefined;
      if (!instance || typeof instance !== 'object') continue;

      const marked = this.reflector.get<boolean>(OUTBOX_SUBSCRIBER, instance.constructor);
      if (!marked) continue;

      const existing = this.handlersByType.get(instance.eventType) ?? [];
      existing.push(instance);
      this.handlersByType.set(instance.eventType, existing);
    }

    const summary = [...this.handlersByType.entries()]
      .map(([type, handlers]) => `${type} x${handlers.length}`)
      .join(', ');
    this.logger.log(`Outbox subscribers: ${summary || 'none'}`);
  }

  /**
   * Dispatch up to a batch of due messages. Returns how many were delivered.
   *
   * Guarded against overlapping runs: a slow handler must not have the next tick
   * start a second pass alongside it.
   */
  async drain(limit = BATCH_SIZE): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    let dispatched = 0;
    try {
      for (let i = 0; i < limit; i += 1) {
        const message = await this.outboxService.claimNext();
        if (!message) break;

        const handlers = this.handlersByType.get(message.eventType) ?? [];

        // An empty handler list is indistinguishable from "all handlers
        // succeeded" — the message is claimed, nothing runs, and it is marked
        // delivered. That is exactly what a subscriber left out of its module's
        // providers looks like, and it produces no signal anywhere: the ops
        // view reads pending: 0, failed: 0 while customers stop receiving mail.
        // The events that legitimately have no consumer are named so this stays
        // quiet until something is actually wrong.
        if (handlers.length === 0 && !UNCONSUMED_EVENTS.has(message.eventType)) {
          this.logger.error(
            `No handler is registered for ${message.eventType} ` +
              `(${message._id.toString()}); marking it delivered with nothing done. ` +
              `If a subscriber exists for it, check that its module lists it in providers.`,
          );
        }

        try {
          // Sequential and awaited, so a throw is this dispatcher's to handle.
          for (const handler of handlers) {
            await handler.handle(message.payload);
          }
          await this.outboxService.markDispatched(message._id);
          dispatched += 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Handler for ${message.eventType} (${message._id.toString()}) failed: ${reason}`,
          );
          // Backs off and stays PENDING, so the message is retried rather than lost.
          await this.outboxService.markFailed(message._id, reason, message.attempts);
        }
      }
    } finally {
      this.running = false;
    }

    return dispatched;
  }
}
