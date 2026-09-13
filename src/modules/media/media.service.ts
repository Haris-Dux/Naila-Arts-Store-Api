import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import {
  ConflictException,
  ResourceNotFoundException,
  ValidationFailedException,
} from '../../common/exceptions/domain.exception';
import { notDeleted } from '../../common/schemas/base.schema';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ContentSection, ContentSectionDocument } from '../content/schemas/content-section.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { MediaResponseDto } from './dto/media.dto';
import { Media, MediaDocument } from './schemas/media.schema';
import { MEDIA_STORAGE, MediaStorage } from './storage/media-storage.port';
import { readWebpDimensions } from './webp';

/** What multer hands over; narrowed to the fields this service actually uses. */
export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export const ALLOWED_CONTENT_TYPE = 'image/webp';
/**
 * Files accepted in one request.
 *
 * Deliberately not the product's five-image cap: how many images a *product* may
 * have is a catalogue rule, enforced on the product DTO. This is only a bound on
 * one multipart body, so the two can move independently — banners will use the
 * same endpoint and have their own limit.
 */
export const MAX_FILES_PER_UPLOAD = 10;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Guards against a header claiming a canvas no browser will ever paint. */
const MAX_DIMENSION = 10_000;
/** The content hash at the end of one of our URLs, whichever domain it is served from. */
const HASH_IN_URL = /([0-9a-f]{64})\.webp$/i;

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @InjectModel(Media.name) private readonly mediaModel: Model<MediaDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(ContentSection.name)
    private readonly sectionModel: Model<ContentSectionDocument>,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
  ) {}

  // ------------------------------------------------------------------- reads

  async list(limit = 50): Promise<MediaResponseDto[]> {
    const media = await this.mediaModel
      .find({ ...notDeleted })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
    return media.map((item) => this.present(item));
  }

  async findById(id: string): Promise<MediaResponseDto> {
    return this.present(await this.getDocumentOrThrow(id));
  }

  /**
   * Resolve ids for the catalogue, as a Map keyed by id string.
   *
   * One query for a whole product's images rather than one per image. An id with
   * no live media is simply absent, which is how the caller learns a reference
   * is dead.
   */
  async findManyByIds(ids: string[]): Promise<Map<string, MediaResponseDto>> {
    const valid = ids.filter((id) => Types.ObjectId.isValid(id));
    if (valid.length === 0) return new Map();

    const media = await this.mediaModel
      .find({ _id: { $in: valid.map((id) => new Types.ObjectId(id)) }, ...notDeleted })
      .exec();

    return new Map(media.map((item) => [item._id.toString(), this.present(item)]));
  }

  /** Reject ids that do not resolve, so a product cannot reference a dead file. */
  async assertAllExist(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const found = await this.findManyByIds(ids);
    const unknown = [...new Set(ids)].filter((id) => !found.has(id));
    if (unknown.length > 0) {
      throw new ValidationFailedException('One or more images do not exist', { unknown });
    }
  }

  // ------------------------------------------------------------------ writes

  /**
   * Store one uploaded file.
   *
   * The format is proved from the bytes, not from the `Content-Type` the client
   * sent or the extension it used — both are just strings the caller chose. The
   * same parse yields the dimensions, so there is no second pass and no image
   * library to install.
   */
  async upload(file: UploadedFile, actor: AuthenticatedUser): Promise<MediaResponseDto> {
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ValidationFailedException(
        `An image may be at most ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB`,
        { filename: file.originalname, bytes: file.size },
      );
    }

    const dimensions = readWebpDimensions(file.buffer);
    if (!dimensions) {
      throw new ValidationFailedException(
        `"${file.originalname}" is not a WebP image. Only WebP is accepted.`,
        { filename: file.originalname, declaredType: file.mimetype },
      );
    }

    if (dimensions.width > MAX_DIMENSION || dimensions.height > MAX_DIMENSION) {
      throw new ValidationFailedException(`An image may be at most ${MAX_DIMENSION}px on a side`, {
        filename: file.originalname,
        ...dimensions,
      });
    }

    const hash = createHash('sha256').update(file.buffer).digest('hex');

    // Same bytes, same file. A merchant who uploads one photograph to two
    // products stores it once and gets the same URL back.
    const existing = await this.mediaModel.findOne({ hash, ...notDeleted }).exec();
    if (existing) return this.present(existing);

    const storageKey = MediaService.storageKeyFor(hash);
    await this.storage.save(storageKey, file.buffer);

    try {
      const media = await this.mediaModel.create({
        hash,
        storageKey,
        contentType: ALLOWED_CONTENT_TYPE,
        bytes: file.size,
        width: dimensions.width,
        height: dimensions.height,
        uploadedBy: new Types.ObjectId(actor.id),
      });
      return this.present(media);
    } catch (error) {
      // Two uploads of the same new file racing: the unique index rejects the
      // loser, which then reads the winner's row. The bytes are identical, so
      // the file on disk is already correct and must not be removed.
      const raced = await this.mediaModel.findOne({ hash, ...notDeleted }).exec();
      if (raced) return this.present(raced);

      // Genuine failure: do not leave an orphan behind.
      await this.storage.remove(storageKey).catch(() => undefined);
      throw error;
    }
  }

  async uploadMany(files: UploadedFile[], actor: AuthenticatedUser): Promise<MediaResponseDto[]> {
    if (files.length === 0) throw new ValidationFailedException('No file was uploaded');

    // Sequential on purpose: the point of an upload endpoint is that each file
    // either lands or reports why, and a parallel map would interleave the
    // failure of one with the disk writes of the others.
    const stored: MediaResponseDto[] = [];
    for (const file of files) {
      stored.push(await this.upload(file, actor));
    }
    return stored;
  }

  /**
   * Delete a file, refused while the catalogue or a storefront section still
   * points at it.
   *
   * The check is a query rather than a stored counter, the same way a category
   * or a size refuses deletion: there is no number to drift out of step with
   * reality.
   */
  async remove(id: string): Promise<void> {
    const media = await this.getDocumentOrThrow(id);

    const { products, sections } = await this.usage(media);
    if (products > 0) {
      throw new ConflictException(
        `Cannot delete an image used by ${products} product(s); remove it from them first`,
      );
    }
    if (sections > 0) {
      throw new ConflictException(
        `Cannot delete an image shown in ${sections} storefront section(s), such as the ` +
          'homepage banner; remove it there first',
      );
    }

    await this.discard(media);
  }

  /**
   * Delete whichever of these URLs' files nothing uses any more.
   *
   * Called after a storefront section is saved, with the image URLs the save
   * took out. A URL that is not one of ours, or whose file a product or another
   * section still shows, is left alone — so a photograph used on both a product
   * and a banner survives the banner being changed.
   *
   * Never throws. The section is already saved, and failing the request because
   * storage hiccuped would tell the administrator their edit did not happen when
   * it did. A file left behind is logged for an operator instead.
   */
  async releaseUnused(urls: string[]): Promise<void> {
    const hashes = [
      ...new Set(urls.map((url) => HASH_IN_URL.exec(url)?.[1]?.toLowerCase())),
    ].filter((hash): hash is string => Boolean(hash));
    if (hashes.length === 0) return;

    let candidates: MediaDocument[];
    try {
      candidates = await this.mediaModel.find({ hash: { $in: hashes }, ...notDeleted }).exec();
    } catch (error) {
      this.logger.error(`Could not look up released media: ${(error as Error).message}`);
      return;
    }

    for (const media of candidates) {
      try {
        const { products, sections } = await this.usage(media);
        if (products + sections === 0) await this.discard(media);
      } catch (error) {
        this.logger.error(
          `Could not delete unused media ${media.storageKey}: ${(error as Error).message}`,
        );
      }
    }
  }

  // ------------------------------------------------------------------ shared

  /**
   * Where a file is still shown: products by reference, storefront sections by URL.
   *
   * A section stores the URL rather than an id, so it is matched on the content
   * hash at the end of it — which still holds if the public domain in front of
   * the bucket changes. The hash is hex, so it needs no escaping in the pattern.
   */
  private async usage(media: MediaDocument): Promise<{ products: number; sections: number }> {
    const [products, sections] = await Promise.all([
      this.productModel.countDocuments({ 'images.mediaId': media._id, ...notDeleted }),
      this.sectionModel.countDocuments({
        'data.items.url': { $regex: `${media.hash}\\.webp$`, $options: 'i' },
        ...notDeleted,
      }),
    ]);
    return { products, sections };
  }

  /** Remove the row and then the bytes. */
  private async discard(media: MediaDocument): Promise<void> {
    // Row first: if the unlink fails the reference is already gone, which is
    // recoverable. The reverse leaves the catalogue pointing at nothing.
    media.deletedAt = new Date();
    await media.save();

    await this.storage.remove(media.storageKey);
    this.logger.log(`Deleted media ${media.hash.slice(0, 12)}…`);
  }

  /**
   * `media/<hash>.webp`.
   *
   * One prefix for everything this application writes, so its files sit in a
   * single folder of the bucket rather than a scatter of hash-named ones.
   */
  private static storageKeyFor(hash: string): string {
    return `media/${hash}.webp`;
  }

  private present(media: MediaDocument): MediaResponseDto {
    return MediaResponseDto.from(media, this.storage.urlFor(media.storageKey));
  }

  private async getDocumentOrThrow(id: string): Promise<MediaDocument> {
    if (!Types.ObjectId.isValid(id)) throw new ResourceNotFoundException('Media', id);
    const media = await this.mediaModel.findOne({ _id: id, ...notDeleted }).exec();
    if (!media) throw new ResourceNotFoundException('Media', id);
    return media;
  }
}
