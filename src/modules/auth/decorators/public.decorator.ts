import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/**
 * Opt a route out of authentication.
 *
 * Authentication is on by default for every route (JwtAuthGuard is registered
 * globally), so a developer must *deliberately* open an endpoint. The old
 * gateway had it the other way round — each controller opted in — and one route
 * simply forgot: `PATCH /orders/:id` shipped with no JwtAuthGuard at all and was
 * reachable anonymously. Defaulting to closed makes that omission impossible.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
