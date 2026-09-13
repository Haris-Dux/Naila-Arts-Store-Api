import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { MediaConfig } from '../../config/configuration';
import { ContentSection, ContentSectionSchema } from '../content/schemas/content-section.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { Media, MediaSchema } from './schemas/media.schema';
import { LocalDiskStorage } from './storage/local-disk.storage';
import { MEDIA_STORAGE, MediaStorage } from './storage/media-storage.port';
import { R2Storage } from './storage/r2.storage';

/**
 * Uploaded images.
 *
 * Storage sits behind `MEDIA_STORAGE`, so where the bytes live is a deployment
 * choice the service never sees: `MEDIA_DRIVER` selects Cloudflare R2 or the
 * deployment's own disk, and nothing else in the application changes.
 *
 * Both adapters are constructed here rather than one being resolved lazily,
 * because a missing R2 credential must fail at boot — the config validator
 * requires them when the driver is `r2` — rather than on the first upload.
 *
 * Registers the Product and ContentSection models rather than importing their
 * modules, for the same reason categories and sizes do: it needs to refuse
 * deleting an image a product or a banner still uses, and both of those modules
 * depend on this one.
 */
/**
 * Pick the storage adapter the environment asked for.
 *
 * Exported so it can be tested directly: inlined in the provider it would be
 * unreachable, and a test that re-declared it would pass while this changed.
 *
 * R2Storage is constructed here rather than being a provider of its own, so a
 * `local` deployment never builds an S3 client or reads credentials it does not
 * have.
 */
export const mediaStorageFactory = (
  config: ConfigService,
  local: LocalDiskStorage,
): MediaStorage => {
  const media = config.getOrThrow<MediaConfig>('media');
  return media.driver === 'r2' ? new R2Storage(config) : local;
};

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Media.name, schema: MediaSchema },
      { name: Product.name, schema: ProductSchema },
      { name: ContentSection.name, schema: ContentSectionSchema },
    ]),
  ],
  controllers: [MediaController],
  providers: [
    MediaService,
    LocalDiskStorage,
    { provide: MEDIA_STORAGE, inject: [ConfigService, LocalDiskStorage], useFactory: mediaStorageFactory },
  ],
  // Exported so products can resolve an image reference and refuse a dead one.
  exports: [MediaService],
})
export class MediaModule {}
