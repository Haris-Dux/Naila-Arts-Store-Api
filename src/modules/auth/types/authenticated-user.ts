import { UserRole } from '../../users/enums/user-role.enum';

/**
 * What a validated access token resolves to. Deliberately small: everything here
 * comes out of the JWT itself, so authorization needs no database round trip.
 *
 * The old gateway called the users service on *every single request* to rebuild
 * this — one extra network hop per request, for data the token already carried.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  /**
   * Incremented on logout / password change / forced revocation. A token whose
   * version is behind the user's current one is rejected, which is what makes
   * stateless tokens revocable.
   */
  tokenVersion: number;
}
