import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, HydratedDocument, Types } from 'mongoose';
import { BaseSchemaClass } from '../../../common/schemas/base.schema';
import { ProductSizing } from '../enums/product-sizing.enum';
import { VideoPlatform } from '../enums/video-platform.enum';

export type ProductDocument = HydratedDocument<Product>;

/**
 * A colour's images: an ordered list of references into the `media` collection.
 *
 * The list is embedded, so a product's images always load with it — the old
 * stack modelled them as a separate table and then never passed
 * `relations: ['images']`, so the catalogue had no images at all. What is
 * embedded is the *reference* and its presentation, not the file's address:
 * where the bytes live is the media module's business, and a URL copied in here
 * would go stale the day storage moves.
 */
@Schema({ _id: false })
export class ProductImage {
  /** References the `media` collection; resolved to a URL on the way out. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Media', required: true })
  mediaId!: Types.ObjectId;

  @Prop({ type: String, default: null })
  alt!: string | null;

  @Prop({ type: Number, default: 0 })
  position!: number;
}

export const ProductImageSchema = SchemaFactory.createForClass(ProductImage);

/**
 * Aggregate rating. A single number cannot be updated correctly — you need the
 * count to fold in a new review — which is why the old `rating: number` field
 * could only ever be set, never maintained.
 */
@Schema({ _id: false })
export class ProductRating {
  @Prop({ type: Number, default: 0, min: 0, max: 5 })
  average!: number;

  @Prop({ type: Number, default: 0, min: 0 })
  count!: number;
}

export const ProductRatingSchema = SchemaFactory.createForClass(ProductRating);

/**
 * One form the product is sold in, and what it costs in that form.
 *
 * A product offers one form or both, each at most once — stitched and
 * unstitched are priced independently because they are different goods made
 * from the same cloth. Every colour of the product shares these prices.
 */
@Schema({ _id: false })
export class ProductOffer {
  @Prop({ type: String, enum: Object.values(ProductSizing), required: true })
  sizing!: ProductSizing;

  /**
   * Integer minor units (cents). Never a float, never a decimal string.
   *
   * The old entity used SQL `decimal`, which the pg driver returns as a *string* —
   * so `totalPrice` reached the order-created event as text and any arithmetic on
   * it silently concatenated. See `common/money.ts`.
   */
  @Prop({ required: true, type: Number, min: 0 })
  price!: number;

  /**
   * Promotional price, in minor units. Null when this form is not on offer.
   *
   * Deliberately a second field rather than editing `price` down: ending a
   * promotion is then nulling one value, not remembering what the price used to
   * be. It has no schedule — the merchant sets it and clears it — which is what
   * was asked for and avoids a clock the storefront would have to agree with.
   *
   * Always below `price`; the service refuses anything else, because a
   * "promotion" that costs more is a data-entry mistake every time.
   */
  @Prop({ type: Number, default: null, min: 0 })
  promotionalPrice!: number | null;

  /** What the customer actually pays in this form: `promotionalPrice ?? price`. */
  @Prop({ required: true, type: Number, min: 0 })
  effectivePrice!: number;
}

export const ProductOfferSchema = SchemaFactory.createForClass(ProductOffer);

/**
 * One colour of the product: one ERP suit, with its own photographs.
 *
 * Keeps its `_id` — that is what a basket line and an order line name, and it
 * survives edits to the colour's name and photographs.
 */
@Schema()
export class ProductVariant {
  _id!: Types.ObjectId;

  /** The colour as the storefront names it. */
  @Prop({ required: true, trim: true })
  color!: string;

  /**
   * The ERP suit this colour is — a `suits._id`. Chosen when the colour is
   * added and never changed afterwards: moving it would move where the
   * colour's stock lives.
   */
  @Prop({ type: String, required: true })
  erpId!: string;

  @Prop({ type: Date, required: true })
  erpSyncedAt!: Date;

  /**
   * On-hand quantity: a mirror of the suit's `quantity`, which is the truth.
   *
   * Only InventoryService and ErpStockSyncService may write this, and only
   * through updates that keep `Product.stock` in step. Nothing in the catalogue
   * layer touches it.
   */
  @Prop({ required: true, type: Number, default: 0, min: 0 })
  stock!: number;

  @Prop({ type: [ProductImageSchema], default: [] })
  images!: ProductImage[];
}

export const ProductVariantSchema = SchemaFactory.createForClass(ProductVariant);

@Schema({ timestamps: true, collection: 'products' })
export class Product extends BaseSchemaClass {
  @Prop({ required: true, trim: true })
  name!: string;

  @Prop({ required: true, lowercase: true, trim: true })
  slug!: string;

  /** Rich text: HTML, sanitised before it is stored. See `rich-text.ts`. */
  @Prop({ type: String, default: null })
  description!: string | null;

  /**
   * The description's words without its markup — what full-text search reads.
   * Internal: never returned by the API.
   */
  @Prop({ type: String, default: null })
  descriptionText!: string | null;

  /** A video of the product on the brand's Facebook page or YouTube channel. */
  @Prop({ type: String, default: null })
  videoUrl!: string | null;

  /**
   * Which site `videoUrl` is on, so the storefront can embed the right player.
   * Set and cleared together with the URL — ProductsService never stores one
   * without the other.
   */
  @Prop({ type: String, enum: Object.values(VideoPlatform), default: null })
  videoPlatform!: VideoPlatform | null;

  /** The forms it is sold in, stitched first. One or both, never empty. */
  @Prop({ type: [ProductOfferSchema], default: [] })
  offers!: ProductOffer[];

  /**
   * The lowest `effectivePrice` among `offers` — the "from" price.
   *
   * Denormalised on every write so that sorting and filtering by price mean what
   * a shopper means by price: what they would be charged, at the cheapest.
   * Sorting on a list price while a promotion is running would order the
   * storefront by a number nobody is being charged.
   */
  @Prop({ required: true, type: Number, min: 0 })
  effectivePrice!: number;

  /** The colours it comes in, in the merchant's display order. Never empty. */
  @Prop({ type: [ProductVariantSchema], default: [] })
  variants!: ProductVariant[];

  /**
   * Units on hand across every colour: the sum of `variants[].stock`.
   *
   * Kept so the catalogue's filters, sorts and indexes — `?inStock=true`,
   * `sort=stock` — work on one field. Every writer of a colour's stock moves
   * this in the same statement, so the two cannot disagree.
   */
  @Prop({ required: true, type: Number, default: 0, min: 0 })
  stock!: number;

  /**
   * The top-level category. Required — every product is filed somewhere, so the
   * storefront has no unreachable shelf and the ERP has no unmapped row. Present
   * on the old DTO but absent from the entity, so silently dropped.
   *
   * Always a root: even when the product also sits in a subcategory, this holds
   * that subcategory's parent, not the subcategory. Denormalising the parent
   * this way is what makes "everything under Electronics" a plain equality
   * match instead of a lookup of the branch followed by an `$in`.
   */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Category', required: true, index: true })
  categoryId!: Types.ObjectId;

  /**
   * Optional second level, always a direct child of `categoryId`.
   *
   * A product sits in one parent and at most one of its subcategories — so the
   * two valid shapes are (parent) and (parent, subcategory). A subcategory
   * without a parent is not a placement the storefront can render, and
   * `CategoriesService.assertPlacement` refuses it.
   */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Category', default: null })
  subcategoryId!: Types.ObjectId | null;

  /**
   * The sizes it can be stitched to, in the merchant's display order.
   *
   * Non-empty exactly when a SIZED offer exists. Note there is no per-size
   * stock: a size is a choice the customer records, and every size of a colour
   * is cut from that colour's one stock.
   */
  @Prop({ type: [MongooseSchema.Types.ObjectId], ref: 'Size', default: [] })
  sizes!: Types.ObjectId[];

  @Prop({ type: ProductRatingSchema, default: () => ({ average: 0, count: 0 }) })
  rating!: ProductRating;

  /**
   * Units sold, all time. Maintained by `InventoryService`, which is the only
   * writer of `stock` and therefore the only place that knows a sale happened.
   *
   * Reduced when an order is cancelled or returned — those units never left —
   * but *not* when a delivery arrives, which is stock movement without a sale.
   */
  @Prop({ type: Number, default: 0, min: 0 })
  sellCount!: number;

  @Prop({ type: Boolean, default: true, index: true })
  isActive!: boolean;

  /** Stock-keeping unit — the natural join key for an ERP. */
  @Prop({ type: String, default: null, trim: true })
  sku!: string | null;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

// Live-scoped uniqueness, so soft-deleted products release their slug and SKU.
ProductSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
ProductSchema.index(
  { sku: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null, sku: { $type: 'string' } } },
);

// Storefront listing: active products in a category, newest first.
ProductSchema.index({ isActive: 1, deletedAt: 1, categoryId: 1, createdAt: -1 });
// The same listing narrowed to one subcategory.
ProductSchema.index({ isActive: 1, deletedAt: 1, subcategoryId: 1, createdAt: -1 });
// Size filtering: multikey over the array.
ProductSchema.index({ isActive: 1, deletedAt: 1, sizes: 1 });
// Price and popularity sorts. Price sorts and filters run on what is actually
// charged, so the index is on the effective price rather than the list price.
ProductSchema.index({ isActive: 1, deletedAt: 1, effectivePrice: 1 });
// "What is on offer?" — a storefront section in its own right.
ProductSchema.index({ isActive: 1, deletedAt: 1, 'offers.promotionalPrice': 1 });
ProductSchema.index({ isActive: 1, deletedAt: 1, sellCount: -1 });
// Stitched or unstitched: multikey over the offers.
ProductSchema.index({ 'offers.sizing': 1 });
// Full-text search over name and description — the description's words, not
// its HTML, or a search for "strong" would match every bold word. Named
// explicitly, so the index has one stable name in every database.
ProductSchema.index(
  { name: 'text', descriptionText: 'text' },
  { name: 'product_text', weights: { name: 10, descriptionText: 1 } },
);
// "Which colour is this suit?" — asked on every ERP stock change.
ProductSchema.index({ 'variants.erpId': 1 });
// "Is this image still used by a product?" — asked before an image may be deleted.
// A new name rather than the old `image_references`: an index keeps its name
// across a deploy, and the old one indexes a path that no longer exists.
ProductSchema.index({ 'variants.images.mediaId': 1 }, { name: 'variant_image_references' });
