import { Request } from 'express';
import { readGuestToken } from './guest-token';

/**
 * Who is making this request.
 *
 * A store must let people buy without registering first — demanding an account
 * before checkout loses sales. So an order, its payment and its shipment can
 * belong either to a signed-in customer or to a guest identified by the signed
 * cookie minted for them at checkout.
 *
 * Exactly one of these is set for an identified caller; both are null for a
 * browser that has never placed an order.
 */
export interface RequestOwner {
  userId: string | null;
  guestToken: string | null;
}

/**
 * Resolve the caller.
 *
 * The token wins over the cookie: a signed-in customer always operates on their
 * own records, even if a stale guest cookie is still riding along.
 *
 * Never mints a token. Checkout is the one place that does, because an order is
 * the first thing a guest owns; everywhere else a caller with no cookie simply
 * owns nothing, and inventing an identity would only paper over that.
 */
export function readRequestOwner(request: Request): RequestOwner {
  if (request.user) return { userId: request.user.id, guestToken: null };
  return { userId: null, guestToken: readGuestToken(request) ?? null };
}

export function isIdentified(owner: RequestOwner): boolean {
  return owner.userId !== null || owner.guestToken !== null;
}

/** Any record that belongs to a customer or a guest: orders, payments, shipments. */
export interface OwnedRecord {
  userId: { toString(): string } | null;
  guestToken: string | null;
}

/**
 * Does this caller own this record?
 *
 * One predicate for all three record types, so the rule cannot drift between
 * them — a guest able to see their order but not its shipment would be a
 * confusing and easily-missed inconsistency.
 *
 * Both sides must be present and equal. A null on either side never matches, so
 * an anonymous caller with no cookie can reach nothing, and a guest record is
 * never reachable by a signed-in user who merely lacks a token.
 */
export function ownsRecord(owner: RequestOwner, record: OwnedRecord): boolean {
  if (owner.userId && record.userId) return record.userId.toString() === owner.userId;
  if (owner.guestToken && record.guestToken) return record.guestToken === owner.guestToken;
  return false;
}
