export enum OrderStatus {
  /** Placed, stock committed, awaiting payment. */
  PENDING = 'PENDING',
  PAID = 'PAID',
  FULFILLING = 'FULFILLING',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
}

/**
 * Which transitions are legal, declared explicitly.
 *
 * The old service let any caller PATCH an order to any status — the endpoint was
 * unauthenticated as well — so an order could jump from PENDING straight to
 * DELIVERED, or move backwards out of a terminal state. Enumerating the edges
 * makes an illegal move a 409 instead of a silent write.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  // FULFILLING without PAID is the cash-on-delivery path: the courier collects
  // on arrival, so the parcel has to move before any money does.
  [OrderStatus.PENDING]: [OrderStatus.PAID, OrderStatus.FULFILLING, OrderStatus.CANCELLED],
  [OrderStatus.PAID]: [OrderStatus.FULFILLING, OrderStatus.CANCELLED, OrderStatus.REFUNDED],
  [OrderStatus.FULFILLING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.REFUNDED],
  [OrderStatus.DELIVERED]: [OrderStatus.REFUNDED],
  // Terminal.
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.REFUNDED]: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/**
 * Statuses where the customer still holds committed stock they have not
 * received. Cancelling from one of these must return the stock to the shelf.
 */
export const STOCK_COMMITTED_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.PAID,
  OrderStatus.FULFILLING,
];

/** A customer may cancel their own order only before it has shipped. */
export const CUSTOMER_CANCELLABLE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.PAID,
];

export function isTerminal(status: OrderStatus): boolean {
  return ORDER_TRANSITIONS[status].length === 0;
}
