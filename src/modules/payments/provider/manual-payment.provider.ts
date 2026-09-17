import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PaymentsConfig } from '../../../config/configuration';
import { PaymentMethod, PaymentStatus } from '../enums/payment-status.enum';
import {
  CreatePaymentInput,
  PaymentProvider,
  ProviderPaymentResult,
  ProviderSettlementResult,
  ProviderWebhookEvent,
} from './payment-provider.interface';

/**
 * Offline payment: cash on delivery.
 *
 * Real, not a stub — a great many stores settle this way, and it makes the whole
 * order lifecycle exercisable before a gateway has been chosen. Money moves
 * outside the system, so "capture" is an administrator confirming receipt.
 *
 * The webhook path is fully implemented rather than stubbed, using the same
 * HMAC-over-raw-body scheme the major gateways use. That way the plumbing —
 * signature verification, replay rejection, idempotent handling — is proven
 * before a real provider is plugged in, and adding one is a single new class.
 */
@Injectable()
export class ManualPaymentProvider implements PaymentProvider {
  readonly name = 'manual';
  readonly supportedMethods = [PaymentMethod.CASH_ON_DELIVERY];

  private readonly logger = new Logger(ManualPaymentProvider.name);
  private readonly config: PaymentsConfig;

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<PaymentsConfig>('payments');
  }

  createPayment(input: CreatePaymentInput): Promise<ProviderPaymentResult> {
    // The reference is what the courier's paperwork and the shop's own records
    // are matched on, so it has to be readable and unambiguous.
    const reference = `${input.orderNumber}-${randomBytes(3).toString('hex').toUpperCase()}`;

    return Promise.resolve({
      reference,
      /**
       * Cash on delivery is *authorized*, not pending: the customer has
       * committed to pay and the courier will collect, so the order can be
       * fulfilled before any money moves. Capture comes later, when the cash is
       * handed over.
       */
      status: PaymentStatus.AUTHORIZED,
      instructions: {
        method: PaymentMethod.CASH_ON_DELIVERY,
        paymentReference: reference,
        note: 'Payment is collected by the courier on delivery.',
      },
    });
  }

  /** Records that an administrator confirmed the funds arrived. */
  capture(reference: string, amount: number): Promise<ProviderSettlementResult> {
    this.logger.log(`Manual capture recorded for ${reference}: ${amount} minor units`);
    return Promise.resolve({ status: PaymentStatus.CAPTURED, amount, reference });
  }

  /** The money is sent back out of band; this records that it was. */
  refund(reference: string, amount: number): Promise<ProviderSettlementResult> {
    this.logger.log(`Manual refund recorded for ${reference}: ${amount} minor units`);
    return Promise.resolve({ status: PaymentStatus.REFUNDED, amount, reference });
  }

  /**
   * Verify an HMAC-SHA256 signature over the raw body.
   *
   * Signature header format: `t=<unix seconds>,v1=<hex hmac of "t.body">`.
   * The timestamp is inside the signed payload, so an attacker cannot replay an
   * old capture by adjusting it — and it is checked against a tolerance window,
   * which is what stops a captured request being replayed indefinitely.
   */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): ProviderWebhookEvent | null {
    if (!signature) return null;

    const parts = Object.fromEntries(
      signature
        .split(',')
        .map((part) => part.split('=', 2))
        .filter((pair): pair is [string, string] => pair.length === 2),
    );

    const timestamp = Number(parts.t);
    const provided = parts.v1;
    if (!Number.isFinite(timestamp) || !provided) return null;

    const ageSeconds = Math.abs(Date.now() / 1000 - timestamp);
    if (ageSeconds > this.config.webhookToleranceSeconds) {
      this.logger.warn(`Rejected webhook: timestamp ${ageSeconds.toFixed(0)}s outside tolerance`);
      return null;
    }

    const expected = createHmac('sha256', this.config.webhookSecret)
      .update(`${parts.t}.${rawBody.toString('utf8')}`)
      .digest('hex');

    // Constant-time compare: a fast-failing comparison leaks the signature one
    // byte at a time.
    if (!ManualPaymentProvider.safeEqual(expected, provided)) {
      this.logger.warn('Rejected webhook: signature mismatch');
      return null;
    }

    return ManualPaymentProvider.parseEvent(rawBody);
  }

  private static safeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    // timingSafeEqual throws on a length mismatch, which would itself leak.
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }

  private static parseEvent(rawBody: Buffer): ProviderWebhookEvent | null {
    try {
      const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
      const id = typeof body.id === 'string' ? body.id : null;
      const type = typeof body.type === 'string' ? body.type : null;
      const reference = typeof body.paymentReference === 'string' ? body.paymentReference : null;
      if (!id || !type || !reference) return null;

      const status = MANUAL_EVENT_STATUS[type];
      if (!status) return null;

      return {
        id,
        type,
        paymentReference: reference,
        status,
        amount: typeof body.amount === 'number' ? body.amount : undefined,
        raw: body,
      };
    } catch {
      return null;
    }
  }
}

/** Event type → resulting payment status. Unknown types are ignored, not guessed. */
const MANUAL_EVENT_STATUS: Readonly<Record<string, PaymentStatus>> = {
  'payment.captured': PaymentStatus.CAPTURED,
  'payment.failed': PaymentStatus.FAILED,
  'payment.cancelled': PaymentStatus.CANCELLED,
  'payment.refunded': PaymentStatus.REFUNDED,
};
