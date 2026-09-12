import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, FilterQuery, Model, SortOrder, Types } from 'mongoose';
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
import { CreateProductDto, ProductImageDto, UpdateProductDto } from './dto/product.dto';
import { ProductSizing } from './enums/product-sizing.enum';
import { Product, ProductDocument, ProductImage } from './schemas/product.schema';
import { Suit, SuitDocument } from '../erp/schemas/suit.schema';
import { toDescription } from './rich-text';

@Injectable()
export class ProductsService {
  private readonly currency: string;

  constructor(
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
    const images = await this.media.findManyByIds(
      documents.flatMap((d) => d.images.map((image) => image.mediaId.toString())),
    );

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
    const promotionalPrice = ProductsService.resolvePromotion(dto.price, dto.promotionalPrice);
    // Every image must resolve before the product is written, so the catalogue
    // can never point at a file that is not there.
    await this.media.assertAllExist((dto.images ?? []).map((image) => image.mediaId));
    const sizing = await this.resolveSizing(dto.sizes ?? [], dto.sizing);
    const suit = dto.erpId ? await this.resolveSuit(dto.erpId) : null;
    const description = toDescription(dto.description);

    const product = await this.productModel.create({
      name: dto.name,
      slug,
      description: description.html,
      descriptionText: description.text,
      facebookVideoUrl: dto.facebookVideoUrl ?? null,
      price: dto.price,
      promotionalPrice,
      effectivePrice: promotionalPrice ?? dto.price,
      // A product built on a suit starts with the suit's stock, whatever the
      // request says: from here on the ERP owns that number.
      stock: suit ? suit.stock : (dto.stock ?? 0),
      erpId: suit ? dto.erpId : null,
      erpSyncedAt: suit ? new Date() : null,
      categoryId: placement.categoryId,
      subcategoryId: placement.subcategoryId,
      sizes: sizing.sizeIds,
      sizing: sizing.sizing,
      images: ProductsService.toImages(dto.images),
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
    // One read, and it is awaited. The old gateway called `getProduct(id)`
    // without awaiting, so `if (!product)` tested a Promise — always truthy —
    // and the 404 branch was unreachable dead code. It then re-fetched the same
    // product downstream, paying for two round trips to check nothing.
    const product = await this.getDocumentOrThrow(id);

    if (dto.name !== undefined) product.name = dto.name;
    if (dto.slug !== undefined) product.slug = await this.uniqueSlug(dto.slug, product._id);
    if (dto.description !== undefined) {
      const description = toDescription(dto.description);
      product.description = description.html;
      product.descriptionText = description.text;
    }
    if (dto.facebookVideoUrl !== undefined) product.facebookVideoUrl = dto.facebookVideoUrl ?? null;
    if (dto.isActive !== undefined) product.isActive = dto.isActive;

    // Price and promotion are resolved together from the merged state: raising
    // the list price above a running promotion, or lowering it beneath one, both
    // have to be judged against the value the other one ends up with.
    if (dto.price !== undefined || dto.promotionalPrice !== undefined) {
      const price = dto.price ?? product.price;
      const promotionalPrice = ProductsService.resolvePromotion(
        price,
        dto.promotionalPrice !== undefined ? dto.promotionalPrice : product.promotionalPrice,
      );
      product.price = price;
      product.promotionalPrice = promotionalPrice;
      product.effectivePrice = promotionalPrice ?? price;
    }

    if (dto.sizes !== undefined || dto.sizing !== undefined) {
      const sizing = await this.resolveSizing(
        dto.sizes ?? product.sizes.map((id) => id.toString()),
        dto.sizing,
      );
      product.sizes = sizing.sizeIds;
      product.sizing = sizing.sizing;
    }
    const placement = await this.resolvePlacement(product, dto);
    if (placement) {
      product.categoryId = placement.categoryId;
      product.subcategoryId = placement.subcategoryId;
    }
    if (dto.images !== undefined) {
      await this.media.assertAllExist(dto.images.map((image) => image.mediaId));
      product.images = ProductsService.toImages(dto.images);
    }
    if (dto.sku !== undefined) {
      await this.assertSkuAvailable(dto.sku, product._id);
      product.sku = dto.sku ?? null;
    }

    await product.save();
    await this.cache.invalidate();
    return ProductResponseDto.from(
      product,
      this.currency,
      await this.describeSizes(product),
      await this.describeImages(product),
    );
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
   * Resolve the size list and the sizing mode together.
   *
   * When the client states `sizing`, the pair is checked; when it does not, the
   * mode follows the list. Either way they cannot end up disagreeing, which is
   * the point of deriving rather than storing two independent fields.
   */
  private async resolveSizing(
    sizeIds: string[],
    stated?: ProductSizing,
  ): Promise<{ sizeIds: Types.ObjectId[]; sizing: ProductSizing }> {
    const resolved = await this.sizes.resolveMany(sizeIds);
    const inferred = resolved.length > 0 ? ProductSizing.SIZED : ProductSizing.UNSTITCHED;
    const sizing = stated ?? inferred;

    if (sizing === ProductSizing.SIZED && resolved.length === 0) {
      throw new ValidationFailedException('A sized product must offer at least one size');
    }
    if (sizing === ProductSizing.UNSTITCHED && resolved.length > 0) {
      throw new ValidationFailedException('An unstitched product cannot be offered in sizes');
    }

    // Stored in the merchant's display order, not the order the ids arrived in.
    return { sizeIds: resolved.map((size) => size.id), sizing };
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
    if (product.images.length === 0) return new Map();
    return this.media.findManyByIds(product.images.map((image) => image.mediaId.toString()));
  }

  private isStaff(viewer?: AuthenticatedUser): boolean {
    return viewer ? roleAtLeast(viewer.role, UserRole.ADMIN) : false;
  }

  private async getDocumentOrThrow(id: string): Promise<ProductDocument> {
    if (!Types.ObjectId.isValid(id)) throw new ResourceNotFoundException('Product', id);
    const product = await this.productModel.findOne({ _id: id, ...notDeleted }).exec();
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
    if (query.sizing) filter.sizing = query.sizing;
    if (query.sizeId) filter.sizes = new Types.ObjectId(query.sizeId);
    if (query.onPromotion) filter.promotionalPrice = { $ne: null };

    // Against what is actually charged, not the list price: a shopper filtering
    // "under 3000" means what they will pay, and a promoted product must fall
    // into the band its promotional price puts it in.
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

    const images = await this.media.findManyByIds(
      documents.flatMap((d) => d.images.map((image) => image.mediaId.toString())),
    );

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
   * The suit a new product is to be built on, and the stock it starts with.
   *
   * Refuses a suit that does not exist, one with nothing to sell (the dashboard
   * never offers those, and the API should not accept them either), and one
   * another live product is already built on — two listings drawing on one
   * stock figure would each advertise the same units.
   */
  private async resolveSuit(erpId: string): Promise<{ stock: number }> {
    const suit = await this.suitModel.findById(erpId).select('_id quantity').lean().exec();
    if (!suit) throw new ResourceNotFoundException('Suit', erpId);

    const stock = Math.max(0, Math.trunc(suit.quantity ?? 0));
    if (stock === 0) throw new ValidationFailedException(`Suit ${erpId} has no stock`);

    const taken = await this.productModel.exists({ erpId, ...notDeleted });
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
