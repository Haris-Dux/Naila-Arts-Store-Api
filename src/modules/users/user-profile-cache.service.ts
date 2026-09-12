import { Injectable } from '@nestjs/common';
import { CacheEntry, CacheNamespace, VersionedCache } from '../../cache/versioned-cache';

/** A user's version token outlives their cached profile, so it is rarely re-minted. */
const VERSION_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * A user's own profile — what `GET /auth/me` and `GET /users/me` return — kept
 * for a day and retired whenever anything in it changes.
 *
 * One namespace per user, so an edit to one account never evicts another's.
 * The key is always the account's canonical id: the ownership guard has already
 * replaced `me` with the caller's id, and the caller normalises the id before it
 * reaches here, so one account can never have two cached copies of which only
 * one is retired.
 */
const namespaceFor = (userId: string): CacheNamespace => ({
  versionKey: `users:profile-version:${userId}`,
  prefix: `users:profile:${userId}`,
  versionTtlMs: VERSION_TTL_MS,
});

@Injectable()
export class UserProfileCacheService {
  constructor(private readonly cache: VersionedCache) {}

  lookup<T>(userId: string): Promise<CacheEntry<T>> {
    return this.cache.lookup<T>(namespaceFor(userId), 'profile');
  }

  /** Called after every write that changes what the profile shows. */
  async invalidate(userId: string): Promise<void> {
    await this.cache.retire(namespaceFor(userId));
  }
}
