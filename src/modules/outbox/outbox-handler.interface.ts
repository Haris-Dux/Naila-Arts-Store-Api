import { SetMetadata } from '@nestjs/common';

export const OUTBOX_SUBSCRIBER = 'outbox:subscriber';

/**
 * Marks a provider as an outbox subscriber.
 *
 * The dispatcher finds these at bootstrap via Nest's DiscoveryService, so adding
 * a subscriber is one decorator on one class — no central list to update, and no
 * import edge from the outbox back to every feature that uses it.
 */
export const OutboxSubscriber = () => SetMetadata(OUTBOX_SUBSCRIBER, true);

/**
 * A subscriber to outbox messages.
 *
 * Deliberately an explicit interface rather than `@OnEvent` on the shared event
 * bus. The dispatcher's contract is "await every handler, and treat a throw as a
 * delivery failure worth retrying" — and @nestjs/event-emitter does not reliably
 * give that: its wrapper returns `undefined` to `emitAsync`, so the dispatcher
 * would mark a message delivered before the handler had finished, and a
 * rejection would surface as an unhandled promise rather than a retry. That
 * silently voids the whole point of an outbox.
 *
 * A typed registry makes both properties structural: the dispatcher holds the
 * promises, and the errors are its own to act on.
 *
 * Handlers must be idempotent. Delivery is at-least-once by construction — a
 * crash between running a handler and marking the row done means a redelivery.
 */
export interface OutboxHandler {
  /** Event type this handles, e.g. 'order.paid'. */
  readonly eventType: string;

  handle(payload: Record<string, unknown>): Promise<void>;
}
