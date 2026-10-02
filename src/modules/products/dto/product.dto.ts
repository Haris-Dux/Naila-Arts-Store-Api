import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ProductSizing } from '../enums/product-sizing.enum';
import { ALL_VIDEO_HOSTS, VideoPlatform } from '../enums/video-platform.enum';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsEnum,
  IsArray,
  IsBoolean,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : (value as string);

/** Each colour of a product carries at most this many photographs. */
export const MAX_PRODUCT_IMAGES = 8;

/** A product comes in at most this many colours. */
export const MAX_PRODUCT_VARIANTS = 20;

export class ProductImageDto {
  /**
   * An id from `POST /media`, not a URL.
   *
   * By reference rather than by address, so the catalogue and the disk cannot
   * disagree: an id that does not resolve is rejected at write time, and
   * deleting a file is refused while a product still points at it. A bare URL
   * would allow both a product pointing at nothing and a disk quietly filling
   * with files nothing points at.
   */
  @ApiProperty({ description: 'Media id from POST /media' })
  @IsMongoId()
  mediaId!: string;

  @ApiPropertyOptional({ description: 'Alt text, for accessibility' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  alt?: string;

  @ApiPropertyOptional({ description: 'Display order, ascending', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

/** One form the product is sold in, and its price in that form. */
export class ProductOfferDto {
  @ApiProperty({ enum: ProductSizing, description: 'SIZED is sold stitched, to a size' })
  @IsEnum(ProductSizing)
  sizing!: ProductSizing;

  /**
   * Minor units, as an integer — 1999 means $19.99.
   *
   * The API deliberately does not accept decimals: a JSON float cannot represent
   * 19.99 exactly, and rounding it at the edge is how prices drift by a cent.
   * Currency comes from store configuration, so it is not per-product.
   */
  @ApiProperty({ description: 'Price in minor units (1999 = $19.99)', example: 1999 })
  @IsInt({ message: 'price must be an integer number of minor units (1999 = $19.99)' })
  @Min(0)
  price!: number;

  /**
   * Promotional price in minor units, or null for none.
   *
   * `price` stays the regular price throughout, so clearing this restores it
   * without anyone having to remember what it was. Must be below `price`.
   */
  @ApiPropertyOptional({
    description: 'Promotional price in minor units; null or omitted for none',
    example: 1499,
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: 'promotionalPrice must be an integer number of minor units' })
  @Min(0)
  promotionalPrice?: number | null;
}

/**
 * One colour of the product: an ERP suit, its shade, and its photographs.
 *
 * The suit is what identifies the colour. On an update, an entry whose `erpId`
 * the product already has keeps that colour — its id and its stock — and
 * takes the name, shade and photographs sent; a new `erpId` adds a colour; a
 * colour left out is removed.
 */
export class ProductVariantDto {
  /**
   * The ERP suit — a `suits._id`. The colour's stock is the suit's: the ERP is
   * the source of truth for it.
   *
   * Lower-cased on the way in. An id is valid hex in either case, but it is
   * stored and compared as text — against another colour, another product, and
   * the ERP's change stream, which always reports it in lower case. An upper-case
   * copy would pass as a different suit and never be synced.
   */
  @ApiProperty({ description: 'ERP suit id; the colour’s stock is taken from the suit' })
  @IsMongoId()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : (value as string),
  )
  erpId!: string;

  @ApiProperty({ example: 'Red', description: 'The colour as the storefront names it' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Transform(trim)
  color!: string;

  /** The shade of the colour's button in the storefront. Lower-cased, as a colour picker gives it. */
  @ApiProperty({ example: '#7a1f3d', description: 'The colour’s shade, as #rrggbb' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : (value as string),
  )
  @Matches(/^#[0-9a-f]{6}$/, { message: 'hex must be a colour like #7a1f3d' })
  hex!: string;

  @ApiPropertyOptional({ type: [ProductImageDto], maxItems: MAX_PRODUCT_IMAGES })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PRODUCT_IMAGES, {
    message: `A colour may have at most ${MAX_PRODUCT_IMAGES} images`,
  })
  // Uploading the same bytes twice returns the same media id, so without this a
  // colour could show one photograph twice in its gallery.
  @ArrayUnique((image: ProductImageDto | null | undefined) => image?.mediaId, {
    message: 'Each image may appear only once',
  })
  @ValidateNested({ each: true })
  @Type(() => ProductImageDto)
  images?: ProductImageDto[];
}

export class CreateProductDto {
  @ApiProperty({ example: 'Wireless Mouse' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Transform(trim)
  name!: string;

  @ApiPropertyOptional({ description: 'Derived from the name when omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(220)
  @Transform(trim)
  slug?: string;

  /**
   * Rich text, as HTML. Sanitised to what the dashboard editor can produce
   * before it is stored; anything else in it is dropped.
   */
  @ApiPropertyOptional({ description: 'HTML; sanitised on the way in' })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  @Transform(trim)
  description?: string;

  /**
   * A video of the product on the brand's Facebook page or YouTube channel, or
   * null to remove it. Sent together with `videoPlatform`: the pair is checked
   * in the service, which is where a link can be matched against the platform
   * it claims — this only rules out anything that is on neither.
   */
  @ApiPropertyOptional({
    description: 'An https link to a Facebook or YouTube video; null removes the video',
    example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @IsUrl(
    { protocols: ['https'], require_protocol: true, host_whitelist: [...ALL_VIDEO_HOSTS] },
    { message: 'videoUrl must be an https link to a Facebook or YouTube video' },
  )
  @Transform(trim)
  videoUrl?: string | null;

  /** Which site `videoUrl` is on. Required whenever `videoUrl` is set. */
  @ApiPropertyOptional({ enum: VideoPlatform, nullable: true })
  @IsOptional()
  @IsEnum(VideoPlatform, { message: 'videoPlatform must be FACEBOOK or YOUTUBE' })
  videoPlatform?: VideoPlatform | null;

  /**
   * The forms it is sold in — stitched, unstitched, or both — each with its own
   * price. Every colour shares these prices.
   */
  @ApiProperty({ type: [ProductOfferDto], minItems: 1, maxItems: 2 })
  @IsArray()
  @ArrayMinSize(1, { message: 'A product must be sold stitched, unstitched, or both' })
  @ArrayMaxSize(2)
  @ArrayUnique((offer: ProductOfferDto | null | undefined) => offer?.sizing, {
    message: 'Each form may be priced only once',
  })
  @ValidateNested({ each: true })
  @Type(() => ProductOfferDto)
  offers!: ProductOfferDto[];

  /** The colours it comes in, in display order. */
  @ApiProperty({ type: [ProductVariantDto], minItems: 1, maxItems: MAX_PRODUCT_VARIANTS })
  @IsArray()
  @ArrayMinSize(1, { message: 'A product needs at least one colour' })
  @ArrayMaxSize(MAX_PRODUCT_VARIANTS, {
    message: `A product may come in at most ${MAX_PRODUCT_VARIANTS} colours`,
  })
  @ArrayUnique((variant: ProductVariantDto | null | undefined) => variant?.erpId, {
    message: 'Each ERP suit may be used by only one colour',
  })
  @ArrayUnique(
    (variant: ProductVariantDto | null | undefined) => variant?.color?.trim().toLowerCase(),
    { message: 'Each colour may appear only once' },
  )
  @ValidateNested({ each: true })
  @Type(() => ProductVariantDto)
  variants!: ProductVariantDto[];

  /**
   * The top-level category, required. A product sits in one parent and,
   * optionally, one of that parent's subcategories — so passing a subcategory
   * here is rejected; it belongs in `subcategoryId` alongside its parent.
   */
  @ApiProperty({ description: 'Top-level category' })
  @IsMongoId()
  categoryId!: string;

  /** Must be a direct child of `categoryId`, which is then required. */
  @ApiPropertyOptional({ description: 'A subcategory of categoryId' })
  @IsOptional()
  @IsMongoId()
  subcategoryId?: string;

  /**
   * The sizes it can be stitched to.
   *
   * Required when a SIZED offer is made, and refused without one — so the
   * sizes and the offers can never contradict each other.
   */
  @ApiPropertyOptional({
    type: [String],
    description: 'Size ids, from GET /sizes. Only with a SIZED offer, which needs at least one',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsMongoId({ each: true })
  sizes?: string[];

  /** Refused without a SIZED offer, like `sizes`. */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Size chart id, from GET /size-charts. Only with a SIZED offer; null removes it',
  })
  @IsOptional()
  @IsMongoId()
  sizeChartId?: string | null;

  @ApiPropertyOptional({ description: 'Stock-keeping unit; the ERP join key' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Transform(trim)
  sku?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Every field optional. `offers` and `variants`, when sent, replace the whole
 * list — see `ProductVariantDto` for how colours are matched.
 *
 * There is no stock here, on a product or on a colour: stock is the ERP's, and
 * a catalogue edit must never overwrite a concurrent sale's decrement.
 */
export class UpdateProductDto extends PartialType(CreateProductDto) {}
