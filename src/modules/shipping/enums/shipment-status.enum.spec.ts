import {
  SHIPMENT_TRANSITIONS,
  ShipmentStatus,
  canTransitionShipment,
} from './shipment-status.enum';

describe('Shipment state machine', () => {
  const ALL = Object.values(ShipmentStatus);

  it('declares an edge list for every status', () => {
    for (const status of ALL) {
      expect(SHIPMENT_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('allows the fulfilment path', () => {
    expect(canTransitionShipment(ShipmentStatus.PENDING, ShipmentStatus.PREPARING)).toBe(true);
    expect(canTransitionShipment(ShipmentStatus.PREPARING, ShipmentStatus.IN_TRANSIT)).toBe(true);
    expect(canTransitionShipment(ShipmentStatus.IN_TRANSIT, ShipmentStatus.DELIVERED)).toBe(true);
  });

  it('refuses to dispatch straight from PENDING', () => {
    // Which is why ShippingService.dispatch applies the implied PREPARING step
    // rather than forcing the warehouse to make two calls.
    expect(canTransitionShipment(ShipmentStatus.PENDING, ShipmentStatus.IN_TRANSIT)).toBe(false);
  });

  it('treats a failed delivery attempt as retryable, not terminal', () => {
    // A courier finding nobody home is routine; the parcel goes out again.
    expect(canTransitionShipment(ShipmentStatus.IN_TRANSIT, ShipmentStatus.FAILED)).toBe(true);
    expect(canTransitionShipment(ShipmentStatus.FAILED, ShipmentStatus.IN_TRANSIT)).toBe(true);
    expect(SHIPMENT_TRANSITIONS[ShipmentStatus.FAILED].length).toBeGreaterThan(0);
  });

  it('allows a return from failed, in-transit and delivered', () => {
    expect(canTransitionShipment(ShipmentStatus.FAILED, ShipmentStatus.RETURNED)).toBe(true);
    expect(canTransitionShipment(ShipmentStatus.IN_TRANSIT, ShipmentStatus.RETURNED)).toBe(true);
    expect(canTransitionShipment(ShipmentStatus.DELIVERED, ShipmentStatus.RETURNED)).toBe(true);
  });

  it('refuses to cancel a parcel already with the carrier', () => {
    // It is physically out of our hands; the outcome is delivered, failed or returned.
    expect(canTransitionShipment(ShipmentStatus.IN_TRANSIT, ShipmentStatus.CANCELLED)).toBe(false);
    expect(canTransitionShipment(ShipmentStatus.DELIVERED, ShipmentStatus.CANCELLED)).toBe(false);
  });

  it('treats RETURNED and CANCELLED as terminal', () => {
    for (const status of [ShipmentStatus.RETURNED, ShipmentStatus.CANCELLED]) {
      expect(SHIPMENT_TRANSITIONS[status]).toHaveLength(0);
      for (const target of ALL) {
        expect(canTransitionShipment(status, target)).toBe(false);
      }
    }
  });

  it('never lists a status as a transition to itself', () => {
    // Repeating the current status is an idempotent no-op in the service —
    // carrier feeds routinely repeat themselves — not a recorded event.
    for (const status of ALL) {
      expect(SHIPMENT_TRANSITIONS[status]).not.toContain(status);
    }
  });
});
