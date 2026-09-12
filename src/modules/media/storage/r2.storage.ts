import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaConfig, R2Config } from '../../../config/configuration';
import { MediaStorage } from './media-storage.port';

/**
 * How long a browser and Cloudflare's edge may hold an object.
 *
 * A year, immutable, because every filename is the SHA-256 of its own contents:
 * the bytes behind a URL can never change, so a revalidation could only ever
 * confirm what the cache already has. This header is where the read speed comes
 * from — far more than the storage underneath it.
 */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Files in Cloudflare R2, read straight from its CDN.
 *
 * R2 speaks S3, so this is the AWS SDK pointed at an account-specific endpoint
 * with the `auto` region — R2 has no regions, but the SigV4 signer requires the
 * field to be set to something.
 *
 * Reads never touch this application. `urlFor` builds a URL against the bucket's
 * public custom domain, and the browser fetches it from Cloudflare directly —
 * which is why the port's `urlFor` can stay synchronous. Presigned URLs would
 * force it async and, worse, would expire: a product grid would lose CDN caching
 * and every stored URL would rot.
 *
 * The bucket must therefore be publicly readable over that domain. That is
 * correct for product photography, which is public content the moment it is on
 * a storefront, and the content-addressed filenames mean a URL leaks nothing —
 * you cannot enumerate a hash.
 */
@Injectable()
export class R2Storage implements MediaStorage, OnModuleDestroy {
  private readonly logger = new Logger(R2Storage.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrl: string;

  constructor(config: ConfigService) {
    const media = config.getOrThrow<MediaConfig>('media');
    const r2: R2Config = media.r2;

    this.bucket = r2.bucket;
    this.publicUrl = r2.publicUrl;

    this.client = new S3Client({
      // R2 is not regional, but SigV4 will not sign without a region.
      region: 'auto',
      endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
    });

    this.logger.log(`Media stored in R2 bucket "${this.bucket}", served from ${this.publicUrl}`);
  }

  /**
   * Upload the bytes under `storageKey`.
   *
   * Unconditional rather than checked-then-written: the key is a content hash,
   * so re-uploading is byte-identical and a HEAD to avoid it would cost a round
   * trip to save nothing. This is what makes the port's idempotency contract
   * true here, where the local adapter's `wx` flag makes it false.
   */
  async save(storageKey: string, bytes: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: bytes,
        // Without this R2 serves the object as application/octet-stream and the
        // browser downloads it instead of rendering it.
        ContentType: 'image/webp',
        CacheControl: CACHE_CONTROL,
      }),
    );
  }

  /** Remove the object. Missing is success — the caller wanted it gone. */
  async remove(storageKey: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );
    } catch (error) {
      // S3 delete is already idempotent, but a bucket that has been repointed or
      // a key written by an older layout should not fail a catalogue edit.
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        this.logger.warn(`Media object already absent from R2: ${storageKey}`);
        return;
      }
      throw error;
    }
  }

  urlFor(storageKey: string): string {
    return `${this.publicUrl}/${storageKey}`;
  }

  /**
   * The SDK keeps a connection pool; releasing it lets the process exit rather
   * than hanging on shutdown — the same reason OutboxDispatcher unrefs its timer.
   */
  onModuleDestroy(): void {
    this.client.destroy();
  }
}
