import { PaymentMethod, PaymentStatus } from '../enums/payment-status.enum';

/** DI token for the set of registered providers. */
export const PAYMENT_PROVIDERS = 'PAYMENT_PROVIDERS';

export interface CreatePaymentInput {
  orderId: string;
  orderNumber: string;
  /** Integer minor units. */
  amount: number;
  currency: string;
  method: PaymentMethod;
  customerEmail: string;
}

export interface ProviderPaymentResult {
  /** The provider's own identifier for this payment. */
  reference: string;
  status: PaymentStatus;
  /**
   * Anything the client needs to complete the payment — bank details for a
   * transfer, a redirect URL for a hosted checkout, a client secret for an
   * embedded form. Deliberately untyped: it is provider-specific and passes
   * straight through to the storefront.
   */
  instructions?: Record<string, unknown>;
}

export interface ProviderSettlementResult {
  status: PaymentStatus;
  /** Minor units actually moved. */
  amount: number;
  reference?: string;
}

export interface ProviderWebhookEvent {
  /** The provider's event id — used to make replay handling idempotent. */
  id: string;
  type: string;
  /** The provider's payment reference this event concerns. */
  paymentReference: string;
  status: PaymentStatus;
  amount?: number;
  raw: Record<string, unknown>;
}

/**
 * What the application needs from a payment gateway.
 *
 * Adding Stripe, Adyen or a local processor later means writing one class that
 * implements this and registering it — no changes to orders, checkout, or the
 * webhook route. The old stack had no payment step at all: orders went straight
 * from created to shipped, so there was nothing to extend.
 *
 * Implementations must be side-effect-free with respect to our database. They
 * talk to the gateway and report what happened; PaymentsService owns all
 * persistence and all order transitions.
 */
export interface PaymentProvider {
  /** Stable identifier, used in the webhook route and stored on each payment. */
  readonly name: string;

  /** Methods this provider can settle. */
  readonly supportedMethods: readonly PaymentMethod[];

  createPayment(input: CreatePaymentInput): Promise<ProviderPaymentResult>;

  /** Take previously authorized funds. */
  capture(reference: string, amount: number): Promise<ProviderSettlementResult>;

  refund(reference: string, amount: number): Promise<ProviderSettlementResult>;

  /**
   * Verify a webhook's authenticity and parse it.
   *
   * Takes the **raw** body, not the parsed object: a signature covers the exact
   * bytes sent, and re-serialising parsed JSON will not reproduce them. Returns
   * null when the signature does not verify — the caller rejects the request.
   */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): ProviderWebhookEvent | null;
}
