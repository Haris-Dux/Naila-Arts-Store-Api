import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { TokenRevocationService } from '../token-revocation.service';
import { AccessTokenPayload } from '../types/token-payload';
import { AuthenticatedUser } from '../types/authenticated-user';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly revocation: TokenRevocationService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('auth.jwtSecret'),
      issuer: 'store',
      audience: 'store-api',
    });
  }

  /**
   * Builds the principal from the token alone.
   *
   * The old strategy issued a `Users.findOne` over TCP here, so every
   * authenticated request paid a network round trip to reconstruct data the
   * token already carried. The only I/O left is a single Redis key read for
   * revocation.
   */
  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    if (await this.revocation.isRevoked(payload.sub, payload.tokenVersion)) {
      throw new UnauthorizedException('Session has been revoked');
    }

    return {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      tokenVersion: payload.tokenVersion,
    };
  }
}
