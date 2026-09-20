export enum OrderStatus {
  /** Placed, stock committed, awaiting payment. */
  PENDING = 'PENDING',
  PAID = 'PAID',
  FULFILLING = 'FULFILLING',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  /** Undone before the parcel left. */
  CANCELLED = 'CANCELLED',
  /** The goods came back after dispatch. */
  RETURNED = 'RETURNED',
}

/**
 * Which transitions are legal, declared explicitly.
 *
 * The old service let any caller PATCH an order to any status — the endpoint was
 * unauthenticated as well — so an order could jump from PENDING straight to
 * DELIVERED, or move backwards out of a terminal state. Enumerating the edges
 * makes an illegal move a 409 instead of a silent write.
 *
 * There are exactly two endings, split by whether the parcel ever left:
 * CANCELLED before dispatch, RETURNED after it. Money is not modelled here at
 * all — a refund is settled by a person outside this system and recorded
 * against the payment, never against the order.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  // FULFILLING without PAID is the cash-on-delivery path: the courier collects
  // on arrival, so the parcel has to move before any money does.
  [OrderStatus.PENDING]: [OrderStatus.PAID, OrderStatus.FULFILLING, OrderStatus.CANCELLED],
  [OrderStatus.PAID]: [OrderStatus.FULFILLING, OrderStatus.CANCELLED],
  [OrderStatus.FULFILLING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  // RETURNED from SHIPPED is the parcel refused at the door — common for cash
  // on delivery, where the customer never takes possession.
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.RETURNED],
  [OrderStatus.DELIVERED]: [OrderStatus.RETURNED],
  // Terminal.
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** A customer may cancel their own order any time before the parcel leaves. */
export const CUSTOMER_CANCELLABLE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.PAID,
  OrderStatus.FULFILLING,
];

export function isTerminal(status: OrderStatus): boolean {
  return ORDER_TRANSITIONS[status].length === 0;
}
