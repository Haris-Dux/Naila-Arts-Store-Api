import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import {
  AuthenticationException,
  ConflictException,
  InvalidStateTransitionException,
  ResourceNotFoundException,
  ValidationFailedException,
} from '../../common/exceptions/domain.exception';
import { Money } from '../../common/money';
import { notDeleted } from '../../common/schemas/base.schema';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ownsRecord } from '../../common/ownership';
import { OrderStatus, canTransition, isTerminal } from '../orders/enums/order-status.enum';
import { OrdersService } from '../orders/orders.service';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { OutboxService } from '../outbox/outbox.service';
import { UserRole, roleAtLeast } from '../users/enums/user-role.enum';
import { CreatePaymentDto, PaymentResponseDto } from './dto/payment.dto';
import { PaymentMethod, PaymentStatus, canTransitionPayment } from './enums/payment-status.enum';
import {
  PAYMENT_PROVIDERS,
  PaymentProvider,
  ProviderSettlementResult,
  ProviderWebhookEvent,
} from './provider/payment-provider.interface';
import { Payment, PaymentDocument } from './schemas/payment.schema';
import { WebhookEvent, WebhookEventDocument } from './schemas/webhook-event.schema';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly providers: Map<string, PaymentProvider>;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Payment.name) private readonly paymentModel: Model<PaymentDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(WebhookEvent.name)
    private readonly webhookEventModel: Model<WebhookEventDocument>,
    @Inject(PAYMENT_PROVIDERS) providers: PaymentProvider[],
    private readonly ordersService: OrdersService,
    private readonly outboxService: OutboxService,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.name, provider]));
  }

  getProvider(name: string): PaymentProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new ResourceNotFoundException('Payment provider', name);
    return provider;
  }

  // ---------------------------------------------------------------- creation

  /**
   * Start a payment for an order.
   *
   * The amount comes from the order, not the request — a client cannot choose
   * what it pays, for the same reason it cannot choose what a product costs.
   *
   * A guest order is accepted on its id alone: the guest has just been handed
   * that id by checkout and holds no token, and confirming a payment method is
   * the other half of the same transaction. An order that belongs to an account
   * still requires that account's token, so one customer cannot confirm
   * another's order.
   */
  async create(dto: CreatePaymentDto, actor?: AuthenticatedUser): Promise<PaymentResponseDto> {
    const order = await this.getOrderOrThrow(dto.orderId);

    // 404, not 403: another customer's order id should not be confirmable.
    if (!this.mayConfirmOrder(order, actor)) {
      throw new ResourceNotFoundException('Order', dto.orderId);
    }

    if (order.status !== OrderStatus.PENDING) {
      throw new ConflictException(
        `Order ${order.orderNumber} is ${order.status} and cannot be paid`,
      );
    }

    // An order has at most one live payment attempt. Returning the existing one
    // keeps a double-submit from creating a second reference the customer might
    // then pay against.
    const existing = await this.paymentModel
      .findOne({
        orderId: order._id,
        status: { $in: [PaymentStatus.PENDING, PaymentStatus.AUTHORIZED] },
        ...notDeleted,
      })
      .exec();
    if (existing) return PaymentResponseDto.from(existing);

    const provider = this.selectProvider(dto.method);
    const result = await provider.createPayment({
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      amount: order.grandTotal,
      currency: order.currency,
      method: dto.method,
      customerEmail: order.contactEmail,
    });

    const payment = await this.paymentModel.create({
      orderId: order._id,
      userId: order.userId,
      provider: provider.name,
      reference: result.reference,
      method: dto.method,
      status: result.status,
      amount: order.grandTotal,
      currency: order.currency,
      instructions: result.instructions ?? null,
      events: [{ status: result.status, at: new Date(), by: null, note: 'Payment initiated' }],
    });

    /**
     * Cash on delivery is settled by the courier, not before dispatch — so
     * fulfilment cannot wait for a capture. Announcing `order.confirmed` is what
     * lets shipping start on an unpaid order.
     *
     * Without this a COD order would sit PENDING until an administrator
     * manually captured a payment nobody had collected yet, which defeats the
     * method entirely.
     */
    if (dto.method === PaymentMethod.CASH_ON_DELIVERY) {
      await this.announceConfirmed(order, payment);
    }

    this.logger.log(
      `Payment ${payment.reference} opened for ${order.orderNumber} ` +
        `(${Money.fromMinor(payment.amount, payment.currency).format()}, ${dto.method})`,
    );

    return PaymentResponseDto.from(payment);
  }

  // ------------------------------------------------------------------- reads

  async findById(id: string, actor: AuthenticatedUser): Promise<PaymentResponseDto> {
    const payment = await this.getPaymentOrThrow(id);
    if (!this.mayAccessOrder(payment, actor)) {
      throw new ResourceNotFoundException('Payment', id);
    }
    return PaymentResponseDto.from(payment);
  }

  async findForOrder(orderId: string, actor: AuthenticatedUser): Promise<PaymentResponseDto[]> {
    const order = await this.getOrderOrThrow(orderId);
    if (!this.mayAccessOrder(order, actor)) {
      throw new ResourceNotFoundException('Order', orderId);
    }

    const payments = await this.paymentModel
      .find({ orderId: order._id, ...notDeleted })
      .sort({ createdAt: -1 })
      .exec();

    return payments.map(PaymentResponseDto.from);
  }

  // -------------------------------------------------------------- settlement

  /**
   * Record that funds were taken, and move the order to PAID.
   *
   * For the manual provider this is an administrator confirming a bank transfer
   * cleared; for a gateway it is the capture call. Either way the order
   * transition happens here, so there is exactly one place where an order
   * becomes paid.
   */
  async capture(
    id: string,
    actor: AuthenticatedUser | null,
    note?: string,
  ): Promise<PaymentResponseDto> {
    const payment = await this.getPaymentOrThrow(id);

    // Taking money for an order that no longer exists is a refund waiting to
    // happen. Only this path is guarded: a provider webhook reports a capture
    // that has already happened, and that must still be recorded.
    if (payment.status !== PaymentStatus.CAPTURED) {
      const order = await this.getOrderOrThrow(payment.orderId.toString());
      // isTerminal, not a list of names: enumerating CANCELLED alone is what
      // let a payment be captured against an order that had already ended.
      if (isTerminal(order.status)) {
        throw new InvalidStateTransitionException(
          'Payment',
          payment.status,
          PaymentStatus.CAPTURED,
        );
      }
    }

    return this.settleCapture(payment, actor, note);
  }

  /**
   * Close every open payment attempt of a cancelled order, idempotently.
   *
   * Conditional on the status in the filter, so a capture racing the
   * cancellation either wins (and the payment stays CAPTURED, for a refund) or
   * loses — never both. A payment that already moved money is left alone.
   */
  async cancelForOrder(orderId: string): Promise<void> {
    if (!Types.ObjectId.isValid(orderId)) return;

    const result = await this.paymentModel
      .updateMany(
        {
          orderId: new Types.ObjectId(orderId),
          status: { $in: [PaymentStatus.PENDING, PaymentStatus.AUTHORIZED] },
          ...notDeleted,
        },
        {
          $set: { status: PaymentStatus.CANCELLED },
          $push: {
            events: {
              status: PaymentStatus.CANCELLED,
              at: new Date(),
              by: null,
              note: 'Order cancelled',
            },
          },
        },
      )
      .exec();

    if (result.modifiedCount > 0) {
      this.logger.log(`Cancelled ${result.modifiedCount} open payment(s) for order ${orderId}`);
    }
  }

  async refund(
    id: string,
    actor: AuthenticatedUser,
    amount?: number,
    reason?: string,
  ): Promise<PaymentResponseDto> {
    // Reassigned to the claimed document below.
    let payment = await this.getPaymentOrThrow(id);

    const remaining = payment.amount - payment.amountRefunded;
    if (remaining <= 0) throw new ConflictException('This payment has been fully refunded');

    const requested = amount ?? remaining;
    if (requested > remaining) {
      throw new ValidationFailedException(
        `Cannot refund ${Money.fromMinor(requested, payment.currency).format()}; only ` +
          `${Money.fromMinor(remaining, payment.currency).format()} remains`,
        { requested, remaining },
      );
    }

    /**
     * Reserve the amount atomically before calling the gateway.
     *
     * `amountRefunded += x; save()` reads and writes in two steps, so two
     * operators refunding concurrently both see the same remaining balance and
     * both issue a refund — giving the customer back more than they paid, with
     * the record showing only one of them. The `$expr` guard lives in the query
     * filter so the check and the increment are one operation, exactly as the
     * stock decrement and the capture claim do.
     */
    const claimed = await this.paymentModel
      .findOneAndUpdate(
        {
          _id: payment._id,
          status: { $in: [PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED] },
          // Only matches while the payment can still absorb this refund.
          $expr: { $lte: [{ $add: ['$amountRefunded', requested] }, '$amount'] },
        },
        { $inc: { amountRefunded: requested } },
        { new: true },
      )
      .exec();

    if (!claimed) {
      // Either the payment is not in a refundable state, or a concurrent refund
      // took the balance. Re-read and report the right one: telling the caller
      // "only $49.98 remains" about a payment that was never captured is both
      // wrong and confusing, so the state conflict is checked first.
      const current = await this.getPaymentOrThrow(payment._id.toString());

      if (
        current.status !== PaymentStatus.CAPTURED &&
        current.status !== PaymentStatus.PARTIALLY_REFUNDED
      ) {
        throw new InvalidStateTransitionException(
          'Payment',
          current.status,
          PaymentStatus.REFUNDED,
        );
      }

      const left = current.amount - current.amountRefunded;
      if (left <= 0) throw new ConflictException('This payment has been fully refunded');
      throw new ValidationFailedException(
        `Cannot refund ${Money.fromMinor(requested, current.currency).format()}; only ` +
          `${Money.fromMinor(left, current.currency).format()} remains`,
        { requested, remaining: left },
      );
    }

    let result: ProviderSettlementResult;
    try {
      result = await this.getProvider(claimed.provider).refund(claimed.reference, requested);
    } catch (error) {
      // Give the reservation back so the amount is not permanently held against
      // a refund that never happened.
      await this.paymentModel
        .updateOne({ _id: claimed._id }, { $inc: { amountRefunded: -requested } })
        .exec();
      throw error;
    }

    /**
     * Derive the status from the claimed document, which carries the balance
     * *after* every reservation that has landed — including a concurrent one.
     *
     * Deciding from this caller's own share instead let two operators refunding
     * half each finish in the wrong order and write PARTIALLY_REFUNDED over a
     * payment whose balance was already zero: a REFUNDED → PARTIALLY_REFUNDED
     * move the transition table forbids. No money was ever at risk — the $expr
     * reservation above is what guarantees that — but the record read as though
     * something was still owed.
     */
    const next =
      claimed.amountRefunded >= claimed.amount
        ? PaymentStatus.REFUNDED
        : PaymentStatus.PARTIALLY_REFUNDED;

    payment = claimed;
    // Never walk backwards out of REFUNDED, whatever order the callers finish in.
    if (payment.status === PaymentStatus.REFUNDED && next !== PaymentStatus.REFUNDED) {
      this.logger.log(
        `Refund on ${payment.reference} settled while it was already fully refunded; ` +
          `leaving the status alone`,
      );
      return PaymentResponseDto.from(payment);
    }
    payment.status = next;
    payment.events.push({
      status: next,
      at: new Date(),
      by: new Types.ObjectId(actor.id),
      note: reason ?? `Refunded ${Money.fromMinor(result.amount, payment.currency).format()}`,
    });
    await payment.save();

    // The order is deliberately untouched. Whether the goods came back is a
    // separate fact from whether the money did, and only the warehouse knows
    // it — so returning an order is marked on the order, and refunding is
    // recorded here. Neither drives the other.

    this.logger.log(
      `Refunded ${Money.fromMinor(result.amount, payment.currency).format()} on ${payment.reference}`,
    );
    return PaymentResponseDto.from(payment);
  }

  // ---------------------------------------------------------------- webhooks

  /**
   * Handle a provider callback.
   *
   * Three properties matter, and all three are enforced here rather than trusted:
   *   - authenticity: the signature is verified over the raw bytes
   *   - idempotency: a unique index on (provider, eventId) makes a redelivery a
   *     no-op, and gateways redeliver aggressively
   *   - ordering: transitions are checked, so a late event cannot regress state
   */
  async handleWebhook(
    providerName: string,
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<{ received: true; duplicate: boolean }> {
    const provider = this.getProvider(providerName);

    const event = provider.verifyWebhook(rawBody, signature);
    if (!event) {
      // Deliberately terse: a detailed reason tells an attacker which part of
      // their forgery to fix.
      throw new AuthenticationException('Invalid webhook signature');
    }

    try {
      await this.webhookEventModel.create({
        provider: providerName,
        eventId: event.id,
        type: event.type,
        payload: event.raw,
      });
    } catch (error) {
      if (this.isDuplicateKey(error)) {
        this.logger.log(`Ignoring duplicate webhook ${providerName}/${event.id}`);
        return { received: true, duplicate: true };
      }
      throw error;
    }

    await this.applyWebhookEvent(providerName, event);
    await this.webhookEventModel
      .updateOne(
        { provider: providerName, eventId: event.id },
        { $set: { processedAt: new Date() } },
      )
      .exec();

    return { received: true, duplicate: false };
  }

  private async applyWebhookEvent(
    providerName: string,
    event: ProviderWebhookEvent,
  ): Promise<void> {
    const payment = await this.paymentModel
      .findOne({ provider: providerName, reference: event.paymentReference, ...notDeleted })
      .exec();

    if (!payment) {
      // Accepted and recorded, but nothing to apply — a 4xx here would make the
      // gateway retry forever over a payment we do not have.
      this.logger.warn(`Webhook ${event.id} references unknown payment ${event.paymentReference}`);
      return;
    }

    if (payment.status === event.status) {
      this.logger.log(`Webhook ${event.id}: payment already ${event.status}, nothing to do`);
      return;
    }

    if (!canTransitionPayment(payment.status, event.status)) {
      // Out-of-order delivery is normal; regressing state because of it is not.
      this.logger.warn(
        `Webhook ${event.id} ignored: ${payment.status} → ${event.status} is not a legal transition`,
      );
      return;
    }

    switch (event.status) {
      case PaymentStatus.CAPTURED:
        await this.settleCapture(payment, null, `Captured via ${providerName} webhook`);
        break;

      case PaymentStatus.REFUNDED:
        payment.amountRefunded = payment.amount;
        payment.status = PaymentStatus.REFUNDED;
        payment.events.push({
          status: PaymentStatus.REFUNDED,
          at: new Date(),
          by: null,
          note: `Refunded via ${providerName} webhook`,
        });
        await payment.save();
        // No order transition: see refund(). A gateway telling us the money
        // went back says nothing about where the goods are.
        break;

      case PaymentStatus.FAILED:
      case PaymentStatus.CANCELLED:
        payment.status = event.status;
        payment.failureReason = event.type;
        payment.events.push({
          status: event.status,
          at: new Date(),
          by: null,
          note: `${event.type} via ${providerName} webhook`,
        });
        await payment.save();
        // The order stays PENDING so the customer can try a different method —
        // cancelling it here would also release stock they may still want.
        break;

      default:
        payment.status = event.status;
        payment.events.push({
          status: event.status,
          at: new Date(),
          by: null,
          note: `${event.type} via ${providerName} webhook`,
        });
        await payment.save();
    }
  }

  // -------------------------------------------------------------- internals

  private async settleCapture(
    // Reassigned to the claimed document below, so not `readonly`.
    payment: PaymentDocument,
    actor: AuthenticatedUser | null,
    note?: string,
  ): Promise<PaymentResponseDto> {
    if (payment.status === PaymentStatus.CAPTURED) {
      // Idempotent: an admin double-click and a redelivered webhook both land here.
      return PaymentResponseDto.from(payment);
    }

    this.assertPaymentTransition(payment.status, PaymentStatus.CAPTURED);

    /**
     * Claim the capture atomically before calling the gateway.
     *
     * A read-check-then-write would let two callers both observe "not yet
     * captured" and both charge the customer. Nothing else prevents that: the
     * webhook event id guards redelivery of *one* webhook, and the BullMQ job id
     * guards *one* queue path, but an admin capture racing a provider webhook —
     * or simply a double-click — goes through neither. Putting the state guard
     * in the query filter makes the check and the claim one operation, the same
     * way the stock decrement does.
     *
     * The manual provider makes a double capture invisible, which is exactly why
     * this would have gone unnoticed until a real gateway was plugged in.
     */
    const previousStatus = payment.status;
    const claimed = await this.paymentModel
      .findOneAndUpdate(
        {
          _id: payment._id,
          status: { $in: [PaymentStatus.PENDING, PaymentStatus.AUTHORIZED] },
        },
        {
          $set: { status: PaymentStatus.CAPTURED, capturedAt: new Date() },
          $push: {
            events: {
              status: PaymentStatus.CAPTURED,
              at: new Date(),
              by: actor ? new Types.ObjectId(actor.id) : null,
              note: note ?? 'Payment captured',
            },
          },
        },
        { new: true },
      )
      .exec();

    if (!claimed) {
      // Another caller won the race. Report their outcome rather than repeating
      // the work, so a concurrent capture behaves like a sequential repeat.
      const current = await this.getPaymentOrThrow(payment._id.toString());
      if (current.status === PaymentStatus.CAPTURED) return PaymentResponseDto.from(current);
      throw new InvalidStateTransitionException('Payment', current.status, PaymentStatus.CAPTURED);
    }

    let result: ProviderSettlementResult;
    try {
      result = await this.getProvider(claimed.provider).capture(claimed.reference, claimed.amount);
    } catch (error) {
      // Release the claim so a retry can genuinely re-attempt — the same
      // reasoning as releasing a notification's dedupe key on a failed send.
      // Leaving it CAPTURED would report money as taken that never moved.
      await this.paymentModel
        .updateOne(
          { _id: claimed._id, status: PaymentStatus.CAPTURED },
          { $set: { status: previousStatus, capturedAt: null }, $pop: { events: 1 } },
        )
        .exec();
      throw error;
    }

    payment = claimed;

    /**
     * The single place an order becomes PAID.
     *
     * Skipped when the order has already moved past PENDING, which is the normal
     * cash-on-delivery ending: the courier collects at the door, so by the time
     * the capture is recorded the order is already SHIPPED or DELIVERED. Marking
     * it PAID then would be a backwards transition. The payment record carries
     * the truth about the money; the order's status tracks fulfilment.
     */
    const order = await this.orderModel.findById(payment.orderId).select('status').lean().exec();
    if (order && canTransition(order.status, OrderStatus.PAID)) {
      await this.transitionOrderSafely(
        payment.orderId.toString(),
        OrderStatus.PAID,
        actor,
        note ?? `Payment ${payment.reference} captured`,
      );
    }

    this.logger.log(
      `Captured ${Money.fromMinor(result.amount, payment.currency).format()} on ${payment.reference}`,
    );
    return PaymentResponseDto.from(payment);
  }

  /**
   * Move the order, tolerating a transition that is no longer legal.
   *
   * The payment is the source of truth about money; if the order has since been
   * cancelled or already advanced, that is worth a warning but must not fail the
   * capture — the funds moved regardless, and throwing here would leave the
   * payment recorded but the caller believing it failed.
   */
  private async transitionOrderSafely(
    orderId: string,
    next: OrderStatus,
    actor: AuthenticatedUser | null,
    note?: string,
  ): Promise<void> {
    try {
      await this.ordersService.updateStatus(orderId, next, actor, note);
    } catch (error) {
      if (error instanceof InvalidStateTransitionException) {
        this.logger.warn(
          `Payment settled but order ${orderId} could not move to ${next}: ${error.message}`,
        );
        return;
      }
      throw error;
    }
  }

  /** Staff or the owning customer. Guest records match nobody. */
  private mayAccessOrder(
    record: { userId: Types.ObjectId | null },
    actor?: AuthenticatedUser,
  ): boolean {
    if (actor && roleAtLeast(actor.role, UserRole.ADMIN)) return true;
    return ownsRecord(actor?.id, record);
  }

  /**
   * The same, plus anybody holding the id of a *guest* order.
   *
   * That opening is what lets a guest confirm a payment method for the order
   * they have just placed: they hold the id checkout returned and nothing else.
   * Deliberately separate from `mayAccessOrder` so it cannot widen the reads —
   * an order id would otherwise be enough to pull back a guest's payment record.
   */
  private mayConfirmOrder(
    record: { userId: Types.ObjectId | null },
    actor?: AuthenticatedUser,
  ): boolean {
    return record.userId === null || this.mayAccessOrder(record, actor);
  }

  /**
   * Record that an order may be fulfilled without prepayment.
   *
   * Emitted only for cash on delivery. Shipping subscribes to this alongside
   * `order.paid`, so both flows create a shipment through the same handler.
   */
  private async announceConfirmed(order: OrderDocument, payment: PaymentDocument): Promise<void> {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.outboxService.record(
          {
            aggregateType: 'order',
            aggregateId: order._id,
            eventType: 'order.confirmed',
            payload: {
              orderId: order._id.toString(),
              orderNumber: order.orderNumber,
              paymentMethod: payment.method,
            },
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
  }

  private selectProvider(method: PaymentMethod): PaymentProvider {
    for (const provider of this.providers.values()) {
      if (provider.supportedMethods.includes(method)) return provider;
    }
    throw new ValidationFailedException(`No payment provider supports ${method}`);
  }

  private assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
    if (!canTransitionPayment(from, to)) {
      throw new InvalidStateTransitionException('Payment', from, to);
    }
  }

  private async getPaymentOrThrow(id: string): Promise<PaymentDocument> {
    if (!Types.ObjectId.isValid(id)) throw new ResourceNotFoundException('Payment', id);
    const payment = await this.paymentModel.findOne({ _id: id, ...notDeleted }).exec();
    if (!payment) throw new ResourceNotFoundException('Payment', id);
    return payment;
  }

  private async getOrderOrThrow(id: string): Promise<OrderDocument> {
    if (!Types.ObjectId.isValid(id)) throw new ResourceNotFoundException('Order', id);
    const order = await this.orderModel.findOne({ _id: id, ...notDeleted }).exec();
    if (!order) throw new ResourceNotFoundException('Order', id);
    return order;
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === 11000
    );
  }
}
