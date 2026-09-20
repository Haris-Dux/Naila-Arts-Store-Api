import { OrderStatus } from '../orders/enums/order-status.enum';

/**
 * Statuses whose money is not booked, because the order was undone.
 *
 * Both are terminal — see ORDER_TRANSITIONS — and between them they cover both
 * ways a sale comes undone: cancelled before the parcel left, returned after.
 * Nothing else in the state machine means "this sale did not happen".
 */
export const REVERSED_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.RETURNED,
] as const;

/**
 * The statuses that count towards revenue — every order the customer placed and
 * has not taken back, PENDING included.
 *
 * PENDING is not "unconfirmed". ORDER_TRANSITIONS allows PENDING -> FULFILLING
 * precisely so a cash-on-delivery parcel can move before any money does, and on
 * this store that is the main path: a COD order never passes through PAID and
 * its `paidAt` stays null forever. Counting only PAID and beyond would make
 * "revenue today" read near zero every morning and then fill in retroactively as
 * the warehouse works the queue — a figure that is never wrong and never useful.
 *
 * Derived by exclusion on purpose. An allow-list would drop a newly added status
 * out of revenue silently; this way a new status is counted, loudly, and
 * analytics.constants.spec.ts fails until somebody classifies it.
 *
 * One known distortion:
 *
 *  - A return reduces the revenue of the window the order was *placed* in,
 *    not the window it came back in. `Order.returnedAt` records when it
 *    happened, but no query in this module reads it. Every figure this module returns is
 *    as-of-now rather than immutable, which is why each response carries
 *    `generatedAt`.
 */
export const BOOKED_REVENUE_STATUSES: readonly OrderStatus[] = Object.values(OrderStatus).filter(
  (status) => !REVERSED_ORDER_STATUSES.includes(status),
);

/** How long a computed figure may be served from cache. */
export const ANALYTICS_TTL_MS = 60_000;

/**
 * Longest window a single request may span.
 *
 * A year of daily buckets is 366 points, which is already more than a chart can
 * usefully draw; beyond it the series is bucketed by month anyway.
 */
export const MAX_WINDOW_DAYS = 366;

/** Default window when the caller names neither end. */
export const DEFAULT_WINDOW_DAYS = 30;
