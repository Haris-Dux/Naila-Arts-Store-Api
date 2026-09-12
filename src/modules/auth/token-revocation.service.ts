import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';
import { parseDuration } from '../../common/duration';

/**
 * Makes stateless access tokens revocable without a database read per request.
 *
 * An access token embeds the `tokenVersion` it was minted with. When a user logs
 * out everywhere, changes their password, or is deactivated, that version is
 * bumped and the new floor is written here. The guard reads one Redis key —
 * sub-millisecond, and only populated for users who have actually revoked —
 * instead of loading the user document, which is what the old gateway did on
 * every single authenticated request.
 *
 * Entries expire after the access-token lifetime, because by then every token
 * minted under the old version has expired on its own.
 */
@Injectable()
export class TokenRevocationService {
  private readonly logger = new Logger(TokenRevocationService.name);
  private readonly ttlMs: number;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    config: ConfigService,
  ) {
    // A small margin over the token lifetime, to cover clock skew between the
    // signing process and Redis.
    this.ttlMs = parseDuration(config.getOrThrow<string>('auth.accessTokenTtl')) + 60_000;
  }

  private key(userId: string): string {
    return `auth:min-token-version:${userId}`;
  }

  /** Record that tokens below `version` are no longer acceptable for this user. */
  async revokeBelow(userId: string, version: number): Promise<void> {
    try {
      await this.cache.set(this.key(userId), version, this.ttlMs);
    } catch (error) {
      // Redis being down must not block a logout. The floor is also persisted on
      // the user document, so correctness is restored on the next refresh; only
      // the immediate cutoff is lost.
      this.logger.error(
        `Failed to publish revocation for user ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** True when this token's version is behind the recorded floor. */
  async isRevoked(userId: string, tokenVersion: number): Promise<boolean> {
    try {
      const minimum = await this.cache.get<number>(this.key(userId));
      return typeof minimum === 'number' && tokenVersion < minimum;
    } catch (error) {
      // Fail open, deliberately: a Redis outage should degrade revocation
      // latency to the token's 15-minute lifetime, not lock every user out of
      // the store. Refresh still checks the database.
      this.logger.error(
        `Revocation check failed for user ${userId}, allowing request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
