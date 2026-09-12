export enum ShipmentStatus {
  /** Created and awaiting the warehouse. */
  PENDING = 'PENDING',
  PREPARING = 'PREPARING',
  IN_TRANSIT = 'IN_TRANSIT',
  DELIVERED = 'DELIVERED',
  /** Delivery attempted and failed — usually retried. */
  FAILED = 'FAILED',
  RETURNED = 'RETURNED',
  CANCELLED = 'CANCELLED',
}

export const SHIPMENT_TRANSITIONS: Readonly<Record<ShipmentStatus, readonly ShipmentStatus[]>> = {
  [ShipmentStatus.PENDING]: [ShipmentStatus.PREPARING, ShipmentStatus.CANCELLED],
  [ShipmentStatus.PREPARING]: [ShipmentStatus.IN_TRANSIT, ShipmentStatus.CANCELLED],
  [ShipmentStatus.IN_TRANSIT]: [
    ShipmentStatus.DELIVERED,
    ShipmentStatus.FAILED,
    ShipmentStatus.RETURNED,
  ],
  // A failed delivery attempt is retried, not terminal.
  [ShipmentStatus.FAILED]: [ShipmentStatus.IN_TRANSIT, ShipmentStatus.RETURNED],
  [ShipmentStatus.DELIVERED]: [ShipmentStatus.RETURNED],
  [ShipmentStatus.RETURNED]: [],
  [ShipmentStatus.CANCELLED]: [],
};

export function canTransitionShipment(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return SHIPMENT_TRANSITIONS[from].includes(to);
}
