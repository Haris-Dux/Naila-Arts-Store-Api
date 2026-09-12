/**
 * Two roles, and only two.
 *
 * ADMIN operates the dashboard — catalogue, inventory, orders, fulfilment,
 * payments. USER is a store customer.
 *
 * There is no tier between them and none above ADMIN. A single-merchant store
 * has one staff population and one customer population; ranks beyond that
 * describe a hierarchy that does not exist, and only create authorization paths
 * nobody can reason about.
 */
export enum UserRole {
  ADMIN = 'ADMIN',
  USER = 'USER',
}

/**
 * Privilege ordering, used by RolesGuard so `@MinRole` reads as "at least".
 *
 * Kept as a rank rather than an equality check: it is what lets a route say
 * `@MinRole(UserRole.ADMIN)` without knowing what other roles exist, and it
 * survives a third role being added later.
 */
export const ROLE_RANK: Readonly<Record<UserRole, number>> = {
  [UserRole.USER]: 0,
  [UserRole.ADMIN]: 1,
};

export function roleAtLeast(actual: UserRole, required: UserRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}
