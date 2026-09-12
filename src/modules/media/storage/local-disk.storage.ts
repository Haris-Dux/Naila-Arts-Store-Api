import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MediaConfig } from '../../../config/configuration';
import { MediaStorage } from './media-storage.port';

/**
 * Files on the deployment's own disk.
 *
 * Chosen over object storage because the store runs on a single VPS: there is no
 * egress bill, no second system to keep credentials for, and the read path is a
 * kernel `sendfile` straight from the page cache. The files are served by
 * Express's static middleware, which is mounted *before* the Nest router — so an
 * image request never touches the JWT guard or the Redis-backed throttler, and
 * costs nothing but the bytes.
 *
 * Two things this arrangement demands, and both are wired up:
 *
 *  - The directory must be a mounted volume. Inside a container, the default
 *    filesystem is discarded on the next `docker compose up --build`, which
 *    would take the entire catalogue's photography with it.
 *  - It must be backed up separately from Mongo. A database dump restores
 *    everything except the pictures.
 */
@Injectable()
export class LocalDiskStorage implements MediaStorage {
  private readonly logger = new Logger(LocalDiskStorage.name);
  private readonly root: string;
  private readonly publicPath: string;

  constructor(config: ConfigService) {
    const media = config.getOrThrow<MediaConfig>('media');
    this.root = resolve(media.root);
    this.publicPath = media.publicPath;
  }

  async save(storageKey: string, bytes: Buffer): Promise<void> {
    const destination = this.pathFor(storageKey);
    await mkdir(dirname(destination), { recursive: true });

    // Write beside the target, then rename. `rename` within a filesystem is
    // atomic, so a reader never sees a half-written image — which matters more
    // than usual here, because the filename is a content hash and a truncated
    // file would be cached under a name that promises the whole thing.
    const staging = `${destination}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(staging, bytes, { flag: 'wx' });
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { force: true });
      throw error;
    }
  }

  async remove(storageKey: string): Promise<void> {
    // `force` makes a missing file success: the caller asked for it to be gone.
    await rm(this.pathFor(storageKey), { force: true });
  }

  urlFor(storageKey: string): string {
    return `${this.publicPath}/${storageKey}`;
  }

  /**
   * Resolve a key to an absolute path, refusing anything that escapes the root.
   *
   * Keys are generated from a hash and never come from a client, so this cannot
   * currently be reached — which is exactly why it is worth having. The day
   * someone adds an endpoint that takes a key from a request, the traversal is
   * already closed.
   */
  private pathFor(storageKey: string): string {
    const path = resolve(join(this.root, storageKey));
    if (path !== this.root && !path.startsWith(`${this.root}/`)) {
      this.logger.error(`Refusing a storage key that escapes the media root: ${storageKey}`);
      throw new Error('Invalid storage key');
    }
    return path;
  }
}
