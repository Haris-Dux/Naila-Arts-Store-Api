/**
 * Where uploaded bytes live.
 *
 * A port with one adapter today — the VPS disk — because the decision to keep
 * files locally is a deployment choice, not a domain one. Object storage becomes
 * one class implementing this, with no change to the media service, the
 * catalogue, or any URL already stored in the database.
 */
export interface MediaStorage {
  /**
   * Write the bytes under `storageKey`, or do nothing if they are already there.
   *
   * Idempotent because the key is a content hash: identical keys mean identical
   * bytes, so a repeat upload is a no-op rather than a rewrite.
   */
  save(storageKey: string, bytes: Buffer): Promise<void>;

  /** Remove the file. Missing is success — the caller wanted it gone. */
  remove(storageKey: string): Promise<void>;

  /** Public URL for a stored key. */
  urlFor(storageKey: string): string;
}

export const MEDIA_STORAGE = Symbol('MEDIA_STORAGE');
