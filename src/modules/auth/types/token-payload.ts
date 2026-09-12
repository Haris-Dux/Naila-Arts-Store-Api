import { UserRole } from '../../users/enums/user-role.enum';

/** Claims carried by an access token. Everything a guard needs, so guards do no I/O. */
export interface AccessTokenPayload {
  /** User id. */
  sub: string;
  email: string;
  role: UserRole;
  /** Invalidation counter — see User.tokenVersion. */
  tokenVersion: number;
  /** Set by @nestjs/jwt. */
  iat?: number;
  exp?: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires, for clients that schedule a refresh. */
  expiresIn: number;
  tokenType: 'Bearer';
}
