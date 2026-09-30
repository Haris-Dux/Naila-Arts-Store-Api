import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, FilterQuery, Model, SortOrder, Types } from 'mongoose';
import { CursorPage, Page } from '../../common/dto/pagination.dto';
import {
  ConflictException,
  ResourceNotFoundException,
  ValidationFailedException,
} from '../../common/exceptions/domain.exception';
import { cursorFor, cursorValue, decodeCursor, encodeCursor } from '../../common/cursor';
import { notDeleted } from '../../common/schemas/base.schema';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { UserRole, roleAtLeast } from '../users/enums/user-role.enum';
import { MediaService } from '../media/media.service';
import { CatalogCacheService } from './catalog-cache.service';
import { CategoriesService, CategoryPlacement } from '../categories/categories.service';
import { SizesService } from '../sizes/sizes.service';
import { ListProductsDto } from './dto/list-products.dto';
import { ProductResponseDto, ProductSizeResponseDto } from './dto/product-response.dto';
import {
  CreateProductDto,
  ProductImageDto,
  ProductOfferDto,
  ProductVariantDto,
  UpdateProductDto,
} from './dto/product.dto';
import { ProductSizing } from './enums/product-sizing.enum';
import { VideoPlatform, isVideoOnPlatform } from './enums/video-platform.enum';
import {
  Product,
  ProductDocument,
  ProductImage,
  ProductOffer,
  ProductVariant,
} from './schemas/product.schema';
import { Suit, SuitDocument } from '../erp/schemas/suit.schema';
import { toDescription } from './rich-text';

/** A product's video, as stored: both set, or both null. */
interface VideoFields {
  videoUrl: string | null;
  videoPlatform: VideoPlatform | null;
}

const NO_VIDEO: VideoFields = { videoUrl: null, videoPlatform: null };

@Injectable()
export class ProductsService {
  private readonly currency: string;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Suit.name) private readonly suitModel: Model<SuitDocument>,
    private readonly cache: CatalogCacheService,
    private readonly categories: CategoriesService,
    private readonly sizes: SizesService,
    private readonly media: MediaService,
    config: ConfigService,
  ) {
    this.currency = config.getOrThrow<string>('store.currency');
  }

  // ------------------------------------------------------------------- reads

  async list(
    query: ListProductsDto,
    viewer?: AuthenticatedUser,
  ): Promise<Page<ProductResponseDto>> {
    const staff = viewer ? roleAtLeast(viewer.role, UserRole.ADMIN) : false;
    // `includeInactive` is honoured only for staff. An anonymous shopper always
    // sees active products, whatever they put in the query string.
    const includeInactive = staff && query.includeInactive === true;

    const fingerprint = CatalogCacheService.fingerprint({
      ...query,
      page: query.page,
      limit: query.limit,
      includeInactive,
    });

    // Only the public view is cached. Staff views vary by permission and are
    // low-traffic, so caching them buys little and risks leaking a draft product
    // into a shopper's cached page.
    // Looked up before the database is read: the entry remembers the cache
    // version it saw, so a page read before a write can never be stored as
    // current after it.
    const cached = includeInactive
      ? undefined
      : await this.cache.list<Page<ProductResponseDto>>(fingerprint);
    if (cached?.value) return cached.value;

    const filter = this.matchFilter(query, includeInactive);

    const [documents, total] = await Promise.all([
      this.productModel
        .find(filter, query.search ? { score: { $meta: 'textScore' } } : {})
        .sort(this.sortSpec(query))
        .skip(query.skip)
        .limit(query.limit)
        .exec(),
      this.productModel.countDocuments(filter).exec(),
    ]);

    // One lookup for the whole page, not one per product. A grid is the place
    // images matter most, so unlike sizes — which stay as bare ids on a listing —
    // these are resolved: without a URL there is nothing to render.
    const images = await this.media.findManyByIds(ProductsService.imageIds(documents));

    const page = Page.of(
      documents.map((d) => ProductResponseDto.from(d, this.currency, undefined, images)),
      total,
      query.page,
      query.limit,
    );

    await cached?.save(page);
    return page;
  }

  async findById(id: string, viewer?: AuthenticatedUser): Promise<ProductResponseDto> {
    const cached = await this.cache.product<ProductResponseDto>(id);
    // A cached entry is only served to shoppers if the product is still active;
    // staff always read through, so they see drafts.
    if (cached.value && cached.value.isActive && !this.isStaff(viewer)) return cached.value;

    const product = await this.getDocumentOrThrow(id);
    if (!product.isActive && !this.isStaff(viewer)) {
      // Same response as a missing product, so an inactive one cannot be probed.
      throw new ResourceNotFoundException('Product', id);
    }

    const response = ProductResponseDto.from(
      product,
      this.currency,
      await this.describeSizes(product),
      await this.describeImages(product),
    );
    // Cached only after a successful save — unlike the old create(), which built
    // the key from `newProduct.id` before persisting and so wrote every product
    // to `product_undefined`.
    await cached.save(response);
    return response;
  }

  /**
   * Bulk lookup by id, returned as a Map keyed by id string.
   *
   * One query for a whole order rather than N. Callers get the raw
   * documents — price, stock, isActive — because they are pricing against them,
   * not rendering them. Unknown and soft-deleted ids are simply absent from the
   * map, which is how the caller learns a line is no longer orderable.
   */
  async findManyByIds(
    ids: string[],
    session?: ClientSession,
  ): Promise<Map<string, ProductDocument>> {
    const valid = ids.filter((id) => Types.ObjectId.isValid(id));
    if (valid.length === 0) return new Map();

    const products = await this.productModel
      .find({ _id: { $in: valid.map((id) => new Types.ObjectId(id)) }, ...notDeleted })
      // Reading inside the checkout transaction, so prices cannot change between
      // being read and being charged.
      .session(session ?? null)
      .exec();

    return new Map(products.map((product) => [product._id.toString(), product]));
  }

  /**
   * The published products among `ids`, in the order they were asked for.
   *
   * What a favourites list replays from localStorage. Unknown, deleted,
   * unpublished and malformed ids are simply absent from the result — never an
   * error — so the client learns which to forget by comparing what it sent with
   * what came back. Published only, whoever asks: this is a storefront view.
   */
  async findActiveByIds(ids: string[]): Promise<ProductResponseDto[]> {
    const unique = [...new Set(ids)];
    const found = await this.findManyByIds(unique);

    const products = unique.flatMap((id) => {
      const product = found.get(id);
      return product?.isActive ? [product] : [];
    });

    // One media lookup for the whole list, as on a listing page.
    const images = await this.media.findManyByIds(ProductsService.imageIds(products));

    return products.map((p) => ProductResponseDto.from(p, this.currency, undefined, images));
  }

  async findBySlug(slug: string): Promise<ProductResponseDto> {
    const normalised = slug.toLowerCase();

    // Only published products are ever returned here, whoever asks, so one
    // cached copy serves everyone. Unpublishing, deleting or renaming is a
    // catalogue write, and every write retires it.
    const cached = await this.cache.slug<ProductResponseDto>(normalised);
    if (cached.value) return cached.value;

    const product = await this.productModel
      .findOne({ slug: normalised, isActive: true, ...notDeleted })
      .exec();
    if (!product) throw new ResourceNotFoundException('Product', slug);

    const response = ProductResponseDto.from(
      product,
      this.currency,
      await this.describeSizes(product),
      await this.describeImages(product),
    );
    await cached.save(response);
    return response;
  }

  // ----------------------------------------------------------------- writes

  async create(dto: CreateProductDto): Promise<ProductResponseDto> {
    const slug = await this.uniqueSlug(dto.slug ?? dto.name);
    await this.assertSkuAvailable(dto.sku);
    // Both category ids are checked against the tree before either is stored, so
    // a product can never claim a branch that does not exist.
    const placement = await this.categories.assertPlacement(
      dto.categoryId,
      dto.subcategoryId ?? null,
    );
    const offers = ProductsService.resolveOffers(dto.offers);
    const sizeIds = await this.resolveSizes(dto.sizes ?? [], offers);
    const video = ProductsService.resolveVideo(dto.videoUrl, dto.videoPlatform) ?? NO_VIDEO;
    const variants = await this.resolveVariants(dto.variants);
    const description = toDescription(dto.description);

    const product = await this.productModel.create({
      name: dto.name,
      slug,
      description: description.html,
      descriptionText: description.text,
      videoUrl: video.videoUrl,
      videoPlatform: video.videoPlatform,
      offers,
      effectivePrice: ProductsService.lowestPrice(offers),
      variants,
      stock: ProductsService.totalStock(variants),
      categoryId: placement.categoryId,
      subcategoryId: placement.subcategoryId,
      sizes: sizeIds,
      sku: dto.sku ?? null,
      isActive: dto.isActive ?? true,
    });

    await this.cache.invalidate();
    return ProductResponseDto.from(
      product,
      this.currency,
      await this.describeSizes(product),
      await this.describeImages(product),
    );
  }

  async update(id: string, dto: UpdateProductDto): Promise<ProductResponseDto> {
    const session = await this.connection.startSession();

    try {
      let updated: ProductDocument | undefined;

      /**
       * One transaction, because replacing the colours rewrites each kept
       * colour's stock with the figure read here. A sale or an ERP change that
       * lands on this product in between is a write conflict, and
       * `withTransaction` runs the whole edit again against the new figures —
       * rather than writing back the old ones and selling units that are gone.
       */
      await session.withTransaction(async () => {
        // One read, and it is awaited. The old gateway called `getProduct(id)`
        // without awaiting, so `if (!product)` tested a Promise — always truthy —
        // and the 404 branch was unreachable dead code. It then re-fetched the
        // same product downstream, paying for two round trips to check nothing.
        const product = await this.getDocumentOrThrow(id, session);

        if (dto.name !== undefined) product.name = dto.name;
        if (dto.slug !== undefined) product.slug = await this.uniqueSlug(dto.slug, product._id);
        if (dto.description !== undefined) {
          const description = toDescription(dto.description);
          product.description = description.html;
          product.descriptionText = description.text;
        }
        const video = ProductsService.resolveVideo(dto.videoUrl, dto.videoPlatform);
        if (video) {
          product.videoUrl = video.videoUrl;
          product.videoPlatform = video.videoPlatform;
        }
        if (dto.isActive !== undefined) product.isActive = dto.isActive;

        // Offers and sizes are resolved together from the merged state: dropping
        // the stitched offer, or clearing the sizes, both have to be judged
        // against the value the other one ends up with.
        if (dto.offers !== undefined || dto.sizes !== undefined) {
          const offers = dto.offers ? ProductsService.resolveOffers(dto.offers) : product.offers;
          product.sizes = await this.resolveSizes(
            dto.sizes ?? product.sizes.map((size) => size.toString()),
            offers,
          );
          if (dto.offers) {
            product.offers = offers;
            product.effectivePrice = ProductsService.lowestPrice(offers);
          }
        }
        const placement = await this.resolvePlacement(product, dto);
        if (placement) {
          product.categoryId = placement.categoryId;
          product.subcategoryId = placement.subcategoryId;
        }
        if (dto.variants !== undefined) {
          product.variants = await this.resolveVariants(dto.variants, product);
          product.stock = ProductsService.totalStock(product.variants);
        }
        if (dto.sku !== undefined) {
          await this.assertSkuAvailable(dto.sku, product._id);
          product.sku = dto.sku ?? null;
        }

        await product.save({ session });
        updated = product;
      });

      const product = updated!;
      // After the commit, for the same reason as checkout: retiring the cache
      // any earlier lets a concurrent read repopulate it from the old state.
      await this.cache.invalidate();
      return ProductResponseDto.from(
        product,
        this.currency,
        await this.describeSizes(product),
        await this.describeImages(product),
      );
    } finally {
      await session.endSession();
    }
  }

  /**
   * Soft delete, awaited to completion.
   *
   * The old version did neither: it called `findOne` without `await` (so the
   * 404 check was dead), then called `delete(id)` without `await` and returned
   * the pending Promise as though it were the deleted product.
   */
  async remove(id: string): Promise<void> {
    const product = await this.getDocumentOrThrow(id);

    product.deletedAt = new Date();
    product.isActive = false;
    // Free the slug and SKU for reuse — both unique indexes are scoped to live
    // documents, but leaving the values in place is needlessly confusing.
    product.slug = `${product.slug}-deleted-${Date.now()}`;
    if (product.sku) product.sku = `${product.sku}-deleted-${Date.now()}`;

    await product.save();
    await this.cache.invalidate();
  }

  // ------------------------------------------------------------------ shared

  /**
   * The placement this update produces, or `undefined` if it touches neither id.
   *
   * Validated from the *merged* state, never from the patch alone: moving a
   * product to a different parent while leaving its old subcategory in place is
   * a contradiction, and it is one the caller has to see. Resolving it silently
   * — by clearing the subcategory, say — would drop a placement the caller never
   * asked to lose. Sending `categoryId: null` is likewise rejected rather than
   * applied: a product always belongs to a category.
   */
  private async resolvePlacement(
    product: ProductDocument,
    dto: UpdateProductDto,
  ): Promise<CategoryPlacement | undefined> {
    if (dto.categoryId === undefined && dto.subcategoryId === undefined) return undefined;

    const categoryId =
      dto.categoryId !== undefined ? (dto.categoryId ?? null) : product.categoryId.toString();
    const subcategoryId =
      dto.subcategoryId !== undefined
        ? (dto.subcategoryId ?? null)
        : (product.subcategoryId?.toString() ?? null);

    return this.categories.assertPlacement(categoryId, subcategoryId);
  }

  /**
   * Validate a promotion against the price it discounts.
   *
   * A promotion at or above the list price is a data-entry mistake every time —
   * it would render as a strike-through that saves the customer nothing, or
   * costs them more. Refused rather than silently ignored, so the admin sees it.
   */
  private static resolvePromotion(price: number, promotional?: number | null): number | null {
    if (promotional === undefined || promotional === null) return null;

    if (promotional >= price) {
      throw new ValidationFailedException(
        'A promotional price must be lower than the regular price',
        { price, promotionalPrice: promotional },
      );
    }
    return promotional;
  }

  /**
   * Resolve the video URL and its platform together, or `undefined` when the
   * request touches neither.
   *
   * The two are stored as separate fields but only ever mean something as a
   * pair, so they are validated as one — the same reasoning as `resolveSizes`.
   * Checked here rather than on the DTO because only here are both values in
   * hand: the DTO has already ruled out any host that is on neither platform.
   *
   *  - a URL needs its platform, and must actually be on it;
   *  - `videoUrl: null` removes the video, platform and all;
   *  - a platform on its own changes nothing it could be applied to, so it is
   *    refused rather than silently ignored.
   */
  private static resolveVideo(
    url: string | null | undefined,
    platform: VideoPlatform | null | undefined,
  ): VideoFields | undefined {
    if (url === undefined && platform === undefined) return undefined;

    if (url === undefined) {
      throw new ValidationFailedException(
        'Send videoUrl with videoPlatform; to remove the video, send videoUrl: null',
      );
    }

    if (url === null) {
      if (platform) {
        throw new ValidationFailedException(
          'videoPlatform needs a videoUrl; to remove the video, send videoUrl: null alone',
        );
      }
      return NO_VIDEO;
    }

    if (!platform) {
      throw new ValidationFailedException(
        'Choose the platform the video is on: videoPlatform must be FACEBOOK or YOUTUBE',
        { videoUrl: url },
      );
    }

    if (!isVideoOnPlatform(url, platform)) {
      throw new ValidationFailedException(
        `That link is not a ${platform === VideoPlatform.YOUTUBE ? 'YouTube' : 'Facebook'} video`,
        { videoUrl: url, videoPlatform: platform },
      );
    }

    return { videoUrl: url, videoPlatform: platform };
  }

  /**
   * Price each form the product is sold in.
   *
   * Stored stitched first, whatever order they arrived in, so every client
   * lists them the same way. The DTO has already refused a form priced twice.
   */
  private static resolveOffers(offers: ProductOfferDto[]): ProductOffer[] {
    const order = Object.values(ProductSizing);

    return [...offers]
      .sort((a, b) => order.indexOf(a.sizing) - order.indexOf(b.sizing))
      .map((offer) => {
        const promotionalPrice = ProductsService.resolvePromotion(
          offer.price,
          offer.promotionalPrice,
        );
        return {
          sizing: offer.sizing,
          price: offer.price,
          promotionalPrice,
          effectivePrice: promotionalPrice ?? offer.price,
        };
      });
  }

  /** The "from" price: the least the product can be bought for, in any form. */
  private static lowestPrice(offers: ProductOffer[]): number {
    return Math.min(...offers.map((offer) => offer.effectivePrice));
  }

  /**
   * Resolve the size list against the forms on offer.
   *
   * A size is what a stitched piece is cut to, so a SIZED offer needs at least
   * one and a product sold only unstitched may have none. Judged together, so
   * the two can never end up disagreeing.
   */
  private async resolveSizes(sizeIds: string[], offers: ProductOffer[]): Promise<Types.ObjectId[]> {
    const resolved = await this.sizes.resolveMany(sizeIds);
    const stitched = offers.some((offer) => offer.sizing === ProductSizing.SIZED);

    if (stitched && resolved.length === 0) {
      throw new ValidationFailedException('A product sold stitched must offer at least one size');
    }
    if (!stitched && resolved.length > 0) {
      throw new ValidationFailedException('Only a product sold stitched can be offered in sizes');
    }

    // Stored in the merchant's display order, not the order the ids arrived in.
    return resolved.map((size) => size.id);
  }

  /**
   * The colours a write leaves the product with, in the order they were sent.
   *
   * A colour is its ERP suit. One the product already has keeps its id, its
   * stock and when it was linked, and takes the name, shade and photographs
   * sent; a new suit is checked and brings its stock with it. Every photograph must
   * resolve before anything is written, so the catalogue can never point at a
   * file that is not there.
   */
  private async resolveVariants(
    variants: ProductVariantDto[],
    product?: ProductDocument,
  ): Promise<ProductVariant[]> {
    await this.media.assertAllExist(
      variants.flatMap((variant) => (variant.images ?? []).map((image) => image.mediaId)),
    );

    const resolved: ProductVariant[] = [];
    for (const variant of variants) {
      const kept = product?.variants.find((existing) => existing.erpId === variant.erpId);

      resolved.push({
        _id: kept?._id ?? new Types.ObjectId(),
        color: variant.color,
        hex: variant.hex,
        erpId: variant.erpId,
        erpSyncedAt: kept?.erpSyncedAt ?? new Date(),
        // A new colour starts with its suit's stock; from there on the ERP owns
        // that number. A kept colour carries over the figure read inside the
        // update's transaction — see `update`.
        stock: kept ? kept.stock : (await this.resolveSuit(variant.erpId, product?._id)).stock,
        images: ProductsService.toImages(variant.images),
      });
    }
    return resolved;
  }

  private static totalStock(variants: ProductVariant[]): number {
    return variants.reduce((total, variant) => total + variant.stock, 0);
  }

  /** Look up the size names for one product, for a detail page. */
  private async describeSizes(product: ProductDocument): Promise<ProductSizeResponseDto[]> {
    if (product.sizes.length === 0) return [];
    const resolved = await this.sizes.resolveMany(product.sizes.map((id) => id.toString()));
    return resolved.map((size) => ({
      id: size.id.toString(),
      name: size.name,
      code: size.code,
    }));
  }

  /**
   * Position defaults to the order the admin sent them in, which is the order
   * they arranged the photographs in.
   */
  private static toImages(images: ProductImageDto[] = []): ProductImage[] {
    return images.map((image, index) => ({
      mediaId: new Types.ObjectId(image.mediaId),
      alt: image.alt ?? null,
      position: image.position ?? index,
    }));
  }

  /** Resolve a product's image references to URLs and dimensions. */
  private async describeImages(product: ProductDocument) {
    return this.media.findManyByIds(ProductsService.imageIds([product]));
  }

  /** Every image the products' colours show, for one media lookup. */
  private static imageIds(products: ProductDocument[]): string[] {
    return products.flatMap((product) =>
      product.variants.flatMap((variant) =>
        variant.images.map((image) => image.mediaId.toString()),
      ),
    );
  }

  private isStaff(viewer?: AuthenticatedUser): boolean {
    return viewer ? roleAtLeast(viewer.role, UserRole.ADMIN) : false;
  }

  private async getDocumentOrThrow(id: string, session?: ClientSession): Promise<ProductDocument> {
    if (!Types.ObjectId.isValid(id)) throw new ResourceNotFoundException('Product', id);
    const product = await this.productModel
      .findOne({ _id: id, ...notDeleted })
      .session(session ?? null)
      .exec();
    if (!product) throw new ResourceNotFoundException('Product', id);
    return product;
  }

  /**
   * Which products match, independent of how they are paged.
   *
   * Extracted so page and cursor pagination cannot drift into filtering
   * different sets — the one thing that would make the two modes disagree about
   * what the catalogue contains.
   */
  private matchFilter(
    query: ListProductsDto,
    includeInactive: boolean,
  ): FilterQuery<ProductDocument> {
    const filter: FilterQuery<ProductDocument> = { ...notDeleted };
    if (!includeInactive) filter.isActive = true;
    // A product in a subcategory also carries its parent's id, so filtering by a
    // top-level category returns the whole branch without a second query.
    if (query.categoryId) filter.categoryId = new Types.ObjectId(query.categoryId);
    if (query.subcategoryId) filter.subcategoryId = new Types.ObjectId(query.subcategoryId);
    if (query.inStock) filter.stock = { $gt: 0 };
    // A product sold both ways is offered in either form, so it matches both.
    if (query.sizing) filter['offers.sizing'] = query.sizing;
    if (query.sizeId) filter.sizes = new Types.ObjectId(query.sizeId);
    // Any form on promotion. `$type` rather than `$ne: null`: on an array path,
    // `$ne` would demand that *no* form lacks a promotion.
    if (query.onPromotion) filter['offers.promotionalPrice'] = { $type: 'number' };

    // Against what is actually charged, not the list price: a shopper filtering
    // "under 3000" means what they will pay, and a promoted product must fall
    // into the band its promotional price puts it in. With two forms, that is
    // the cheaper one — the "from" price the listing shows.
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      filter.effectivePrice = {
        ...(query.minPrice !== undefined ? { $gte: query.minPrice } : {}),
        ...(query.maxPrice !== undefined ? { $lte: query.maxPrice } : {}),
      };
    }

    if (query.search) filter.$text = { $search: query.search };
    return filter;
  }

  /**
   * A page of the endless feed, anchored to a position rather than an offset.
   *
   * Cached like a list page, keyed by the whole query including the cursor. The
   * feed is deterministic, so every shopper scrolling the same sort and filters
   * asks for the same sequence of cursors — each batch is shared, not one-shot.
   * Any catalogue write retires every cached batch; a cursor a shopper is still
   * holding keeps working afterwards, it simply reads through to the database.
   */
  async feed(
    query: ListProductsDto,
    viewer?: AuthenticatedUser,
  ): Promise<CursorPage<ProductResponseDto>> {
    const staff = viewer ? roleAtLeast(viewer.role, UserRole.ADMIN) : false;
    const includeInactive = staff && query.includeInactive === true;

    if (query.sort === 'relevance') {
      // textScore is computed per query, not stored, so there is no value a
      // cursor could be compared against without rescoring every candidate.
      throw new ValidationFailedException(
        'Cursor pagination cannot sort by relevance; use paginate=page for search',
        { sort: query.sort },
      );
    }

    // Only the public view is cached, as with list pages: a staff view that
    // includes drafts must never be served to a shopper.
    const fingerprint = CatalogCacheService.fingerprint({ ...query, includeInactive });
    const cached = includeInactive
      ? undefined
      : await this.cache.feed<CursorPage<ProductResponseDto>>(fingerprint);
    if (cached?.value) return cached.value;

    const field = query.sort;
    const direction: SortOrder = query.order === 'asc' ? 1 : -1;
    const filter = this.matchFilter(query, includeInactive);

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      const value = cursorValue(cursor);
      const after = direction === 1 ? '$gt' : '$lt';

      // Strictly after the anchor in the *total* ordering: past the anchor's
      // sort value, or level with it but past its id. Without the id leg, every
      // product sharing a sort value with the anchor would be skipped — and on
      // a field like `sellCount`, where most products sit at 0, that is most of
      // the catalogue.
      filter.$and = [
        ...((filter.$and as FilterQuery<ProductDocument>[]) ?? []),
        {
          $or: [
            { [field]: { [after]: value } },
            { [field]: value, _id: { [after]: new Types.ObjectId(cursor.id) } },
          ],
        },
      ];
    }

    // One row beyond the page: its presence is the answer to "is there more",
    // which is what lets this skip the count entirely.
    const documents = await this.productModel
      .find(filter)
      .sort({ [field]: direction, _id: direction })
      .limit(query.limit + 1)
      .exec();

    const images = await this.media.findManyByIds(ProductsService.imageIds(documents));

    const rows = documents.map((document) => ({
      dto: ProductResponseDto.from(document, this.currency, undefined, images),
      document,
    }));

    const page = CursorPage.of(rows, query.limit, (row) =>
      // Read off the document, not the DTO: the sort field may be a stored value
      // the response never exposes.
      encodeCursor(cursorFor(row.document._id.toString(), row.document.get(field))),
    );

    const result: CursorPage<ProductResponseDto> = {
      items: page.items.map((row) => row.dto),
      meta: page.meta,
    };
    await cached?.save(result);
    return result;
  }

  private sortSpec(query: ListProductsDto): Record<string, SortOrder | { $meta: 'textScore' }> {
    const direction: SortOrder = query.order === 'asc' ? 1 : -1;

    if (query.sort === 'relevance') {
      // Relevance is only defined for a text search; without one, fall back
      // rather than producing an error or an arbitrary order.
      return query.search ? { score: { $meta: 'textScore' } } : { createdAt: -1 };
    }
    return { [query.sort]: direction };
  }

  /** Slugify, then disambiguate with a counter if the slug is taken. */
  private async uniqueSlug(source: string, excludeId?: Types.ObjectId): Promise<string> {
    const base =
      source
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 200) || 'product';

    for (let suffix = 0; suffix < 50; suffix += 1) {
      const candidate = suffix === 0 ? base : `${base}-${suffix}`;
      const clash = await this.productModel.exists({
        slug: candidate,
        ...notDeleted,
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
      });
      if (!clash) return candidate;
    }
    // Deterministic attempts exhausted; fall back to something certainly free.
    return `${base}-${Date.now()}`;
  }

  /**
   * The suit a new colour is to be, and the stock it starts with.
   *
   * Refuses a suit that does not exist, one with nothing to sell (the dashboard
   * never offers those, and the API should not accept them either), and one
   * another live product already sells — two listings drawing on one stock
   * figure would each advertise the same units. `excludeId` is the product
   * being edited, which may of course keep its own suits.
   */
  private async resolveSuit(erpId: string, excludeId?: Types.ObjectId): Promise<{ stock: number }> {
    const suit = await this.suitModel.findById(erpId).select('_id quantity').lean().exec();
    if (!suit) throw new ResourceNotFoundException('Suit', erpId);

    const stock = Math.max(0, Math.trunc(suit.quantity ?? 0));
    if (stock === 0) throw new ValidationFailedException(`Suit ${erpId} has no stock`);

    const taken = await this.productModel.exists({
      'variants.erpId': erpId,
      ...notDeleted,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (taken) throw new ConflictException(`Suit ${erpId} is already used by another product`);

    return { stock };
  }

  private async assertSkuAvailable(sku?: string, excludeId?: Types.ObjectId): Promise<void> {
    if (!sku) return;
    const clash = await this.productModel.exists({
      sku,
      ...notDeleted,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (clash) throw new ConflictException(`A product with SKU ${sku} already exists`);
  }
}
