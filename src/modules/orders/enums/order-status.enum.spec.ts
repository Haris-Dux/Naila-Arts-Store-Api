import {
  CUSTOMER_CANCELLABLE_STATUSES,
  ORDER_TRANSITIONS,
  OrderStatus,
  canTransition,
  isTerminal,
} from './order-status.enum';

/**
 * The order state machine, tested directly.
 *
 * The e2e suite covers the paths a customer actually walks; this covers the
 * whole graph, including the edges nobody should be able to walk. The old
 * service had no machine at all — its update endpoint accepted any status from
 * any other, and was reachable without authentication — so an order could jump
 * from PENDING straight to DELIVERED, or move back out of a terminal state.
 */
describe('Order state machine', () => {
  const ALL = Object.values(OrderStatus);

  it('declares an edge list for every status', () => {
    // A status missing from the table would throw at runtime inside
    // canTransition rather than simply disallowing the move.
    for (const status of ALL) {
      expect(ORDER_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('allows the happy path, one step at a time', () => {
    expect(canTransition(OrderStatus.PENDING, OrderStatus.PAID)).toBe(true);
    expect(canTransition(OrderStatus.PAID, OrderStatus.FULFILLING)).toBe(true);
    expect(canTransition(OrderStatus.FULFILLING, OrderStatus.SHIPPED)).toBe(true);
    expect(canTransition(OrderStatus.SHIPPED, OrderStatus.DELIVERED)).toBe(true);
  });

  it('refuses to skip a step', () => {
    expect(canTransition(OrderStatus.PENDING, OrderStatus.DELIVERED)).toBe(false);
    expect(canTransition(OrderStatus.PENDING, OrderStatus.SHIPPED)).toBe(false);
    // This one is load-bearing: shipping relies on it, which is why dispatching
    // mirrors PREPARING before IN_TRANSIT.
    expect(canTransition(OrderStatus.PAID, OrderStatus.SHIPPED)).toBe(false);
  });

  it('allows fulfilment to begin unpaid, for cash on delivery', () => {
    // The courier collects at the door, so the parcel has to move before any
    // money does. Without this edge a COD order can never be fulfilled.
    expect(canTransition(OrderStatus.PENDING, OrderStatus.FULFILLING)).toBe(true);
  });

  it('does not let an unpaid order skip fulfilment entirely', () => {
    // PENDING → FULFILLING exists for COD; PENDING → SHIPPED must not, or an
    // order could reach a customer with no shipment record behind it.
    expect(canTransition(OrderStatus.PENDING, OrderStatus.SHIPPED)).toBe(false);
    expect(canTransition(OrderStatus.PENDING, OrderStatus.RETURNED)).toBe(false);
  });

  it('refuses to move backwards', () => {
    expect(canTransition(OrderStatus.SHIPPED, OrderStatus.PAID)).toBe(false);
    expect(canTransition(OrderStatus.DELIVERED, OrderStatus.SHIPPED)).toBe(false);
    expect(canTransition(OrderStatus.PAID, OrderStatus.PENDING)).toBe(false);
  });

  it('treats CANCELLED and RETURNED as terminal, and nothing else', () => {
    const terminal = ALL.filter(isTerminal);
    expect(terminal.sort()).toEqual([OrderStatus.CANCELLED, OrderStatus.RETURNED].sort());

    // Nothing leads out of a terminal state, from anywhere.
    for (const status of terminal) {
      for (const target of ALL) {
        expect(canTransition(status, target)).toBe(false);
      }
    }
  });

  /**
   * The two endings sit on opposite sides of dispatch, and that is the whole
   * restock rule: the service returns units whenever an order goes terminal,
   * because either ending means the goods are back with us. If these two tests
   * ever fail, that shortcut is no longer safe.
   */
  describe('the two endings', () => {
    const BEFORE_DISPATCH = [OrderStatus.PENDING, OrderStatus.PAID, OrderStatus.FULFILLING];
    const AFTER_DISPATCH = [OrderStatus.SHIPPED, OrderStatus.DELIVERED];

    it('allows cancelling only before the parcel leaves', () => {
      for (const from of BEFORE_DISPATCH) {
        expect(canTransition(from, OrderStatus.CANCELLED)).toBe(true);
      }
      for (const from of AFTER_DISPATCH) {
        expect(canTransition(from, OrderStatus.CANCELLED)).toBe(false);
      }
    });

    it('allows returning only after the parcel leaves', () => {
      for (const from of AFTER_DISPATCH) {
        expect(canTransition(from, OrderStatus.RETURNED)).toBe(true);
      }
      for (const from of BEFORE_DISPATCH) {
        expect(canTransition(from, OrderStatus.RETURNED)).toBe(false);
      }
    });

    it('lets a refused parcel be returned without ever being delivered', () => {
      // Cash on delivery: the customer declines at the door, so the order never
      // reaches DELIVERED but the goods still come back.
      expect(canTransition(OrderStatus.SHIPPED, OrderStatus.RETURNED)).toBe(true);
    });

    it('models no refund at all', () => {
      // Money is settled by a person outside this system and recorded against
      // the payment. An order status meaning "refunded" is what made returns
      // complicated before.
      expect(Object.values(OrderStatus)).not.toContain('REFUNDED');
    });
  });

  it('lets a customer cancel only before the parcel leaves', () => {
    expect([...CUSTOMER_CANCELLABLE_STATUSES].sort()).toEqual(
      [OrderStatus.PENDING, OrderStatus.PAID, OrderStatus.FULFILLING].sort(),
    );
    // Right up until the parcel is handed to the carrier, but no further.
    expect(CUSTOMER_CANCELLABLE_STATUSES).not.toContain(OrderStatus.SHIPPED);
    expect(CUSTOMER_CANCELLABLE_STATUSES).not.toContain(OrderStatus.DELIVERED);
  });

  it('never lists a status as a transition to itself', () => {
    // Self-transitions are handled as an idempotent no-op by the service; an
    // edge here would instead append a duplicate history entry.
    for (const status of ALL) {
      expect(ORDER_TRANSITIONS[status]).not.toContain(status);
    }
  });

  it('can reach every non-initial status from PENDING', () => {
    // Guards against adding a status that nothing can ever transition into.
    const reachable = new Set<OrderStatus>([OrderStatus.PENDING]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const from of [...reachable]) {
        for (const to of ORDER_TRANSITIONS[from]) {
          if (!reachable.has(to)) {
            reachable.add(to);
            grew = true;
          }
        }
      }
    }
    expect([...reachable].sort()).toEqual([...ALL].sort());
  });
});
