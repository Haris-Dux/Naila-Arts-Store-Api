import { UserRole } from '../modules/users/enums/user-role.enum';

/**
 * Domain event names and payloads.
 *
 * Namespaced with a dot to match EventEmitterModule's delimiter, so a listener
 * can subscribe to `order.*` when that becomes useful.
 *
 * Events describe something that has already happened. A listener may not veto
 * it — anything that must be able to fail belongs in the caller, not here.
 */
export const EVENTS = {
  USER_AUTHENTICATED: 'user.authenticated',
  PRODUCTS_CHANGED: 'catalog.products-changed',
} as const;

export interface UserAuthenticatedEvent {
  userId: string;
  email: string;
  role: UserRole;
}

/**
 * Products were written to by something other than `ProductsService`.
 *
 * Two modules legitimately write the products collection behind the catalogue's
 * back: inventory, whose conditional stock update is the overselling guard and
 * has to stay a single atomic operation; and categories, which re-points a
 * branch's products when the branch moves. Both change fields the cached product
 * view carries.
 *
 * They announce the change rather than reaching for the cache themselves. That
 * keeps the cache private to the module that owns it, and — more to the point —
 * leaves exactly one implementation of "which keys does this retire", instead of
 * one copy per writer to get subtly wrong.
 *
 * Emit *after* the transaction commits. Retiring a cached view before the write
 * is visible lets a concurrent read repopulate it from the pre-commit state,
 * which is worse than not invalidating at all.
 */
export interface ProductsChangedEvent {
  /** Every product whose stored form changed. Empty is valid and means "none". */
  productIds: string[];
}
