/**
 * Does this record belong to this customer?
 *
 * One predicate for all three record types — orders, payments, shipments — so
 * the rule cannot drift between them. A customer able to see their order but not
 * its shipment would be a confusing and easily-missed inconsistency.
 *
 * Both sides must be present and equal, so a guest order (`userId: null`) is
 * never reachable by a signed-in customer, and an anonymous caller reaches
 * nothing at all. Guests read their own orders through the public tracking
 * lookup instead, which matches on the order number rather than on identity.
 *
 * Staff access is deliberately *not* folded in here: each service pairs this
 * with its own `roleAtLeast(actor.role, ADMIN)` check, and keeping the two
 * separate means a missing role import cannot silently widen ownership.
 */
export interface OwnedRecord {
  userId: { toString(): string } | null;
}

export function ownsRecord(userId: string | null | undefined, record: OwnedRecord): boolean {
  if (!userId || !record.userId) return false;
  return record.userId.toString() === userId;
}
