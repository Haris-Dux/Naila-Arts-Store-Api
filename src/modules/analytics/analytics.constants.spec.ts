import { OrderStatus } from '../orders/enums/order-status.enum';
import { BOOKED_REVENUE_STATUSES, REVERSED_ORDER_STATUSES } from './analytics.constants';

describe('analytics constants', () => {
  it('counts every status that is not a reversal', () => {
    // Pinned deliberately. If this fails because OrderStatus grew, decide whether
    // the new status is booked revenue and update BOTH this list and the comment
    // in analytics.constants.ts — do not just re-snapshot it.
    expect([...BOOKED_REVENUE_STATUSES].sort()).toEqual([
      'DELIVERED',
      'FULFILLING',
      'PAID',
      'PENDING',
      'SHIPPED',
    ]);
  });

  it('includes PENDING, because a cash-on-delivery order never reaches PAID', () => {
    expect(BOOKED_REVENUE_STATUSES).toContain(OrderStatus.PENDING);
  });

  it('excludes the two reversals', () => {
    expect(BOOKED_REVENUE_STATUSES).not.toContain(OrderStatus.CANCELLED);
    expect(BOOKED_REVENUE_STATUSES).not.toContain(OrderStatus.REFUNDED);
  });

  it('partitions the enum, so no status is silently unclassified', () => {
    expect([...BOOKED_REVENUE_STATUSES, ...REVERSED_ORDER_STATUSES].sort()).toEqual(
      Object.values(OrderStatus).sort(),
    );
  });
});
