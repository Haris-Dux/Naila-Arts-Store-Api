import { PAYMENT_TRANSITIONS, PaymentStatus, canTransitionPayment } from './payment-status.enum';

/**
 * The payment state machine.
 *
 * This one exists specifically because webhooks arrive late and out of order.
 * A gateway guarantees at-least-once delivery, not ordered delivery, so a
 * `payment.failed` genuinely can land after a `payment.captured` — and the
 * machine is what stops that dragging a settled payment backwards.
 */
describe('Payment state machine', () => {
  const ALL = Object.values(PaymentStatus);

  it('declares an edge list for every status', () => {
    for (const status of ALL) {
      expect(PAYMENT_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('allows the settlement paths', () => {
    expect(canTransitionPayment(PaymentStatus.PENDING, PaymentStatus.CAPTURED)).toBe(true);
    expect(canTransitionPayment(PaymentStatus.PENDING, PaymentStatus.AUTHORIZED)).toBe(true);
    expect(canTransitionPayment(PaymentStatus.AUTHORIZED, PaymentStatus.CAPTURED)).toBe(true);
  });

  it('refuses to un-capture a payment', () => {
    // The exact out-of-order webhook case.
    expect(canTransitionPayment(PaymentStatus.CAPTURED, PaymentStatus.FAILED)).toBe(false);
    expect(canTransitionPayment(PaymentStatus.CAPTURED, PaymentStatus.CANCELLED)).toBe(false);
    expect(canTransitionPayment(PaymentStatus.CAPTURED, PaymentStatus.PENDING)).toBe(false);
  });

  it('allows refunds only from a captured payment', () => {
    expect(canTransitionPayment(PaymentStatus.CAPTURED, PaymentStatus.REFUNDED)).toBe(true);
    expect(canTransitionPayment(PaymentStatus.CAPTURED, PaymentStatus.PARTIALLY_REFUNDED)).toBe(
      true,
    );
    // Nothing was taken, so there is nothing to give back.
    expect(canTransitionPayment(PaymentStatus.PENDING, PaymentStatus.REFUNDED)).toBe(false);
    expect(canTransitionPayment(PaymentStatus.AUTHORIZED, PaymentStatus.REFUNDED)).toBe(false);
  });

  it('lets a partial refund be topped up or completed', () => {
    expect(
      canTransitionPayment(PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.PARTIALLY_REFUNDED),
    ).toBe(true);
    expect(canTransitionPayment(PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED)).toBe(
      true,
    );
  });

  it('treats FAILED, CANCELLED and REFUNDED as terminal', () => {
    for (const status of [PaymentStatus.FAILED, PaymentStatus.CANCELLED, PaymentStatus.REFUNDED]) {
      expect(PAYMENT_TRANSITIONS[status]).toHaveLength(0);
      for (const target of ALL) {
        expect(canTransitionPayment(status, target)).toBe(false);
      }
    }
  });

  it('never allows money to move after a full refund', () => {
    expect(canTransitionPayment(PaymentStatus.REFUNDED, PaymentStatus.CAPTURED)).toBe(false);
    expect(canTransitionPayment(PaymentStatus.REFUNDED, PaymentStatus.PARTIALLY_REFUNDED)).toBe(
      false,
    );
  });
});
