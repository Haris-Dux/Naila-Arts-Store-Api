import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { ProductSizing } from '../enums/product-sizing.enum';
import { ALL_VIDEO_HOSTS, VideoPlatform } from '../enums/video-platform.enum';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : (value as string);

/** A product carries at most this many photographs. */
export const MAX_PRODUCT_IMAGES = 8;

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
   * The ERP suit this product is built on — a `suits._id`.
   *
   * When given, the product's stock is the suit's, and any `stock` sent
   * alongside is ignored: the ERP is the source of truth for it.
   */
  @ApiPropertyOptional({ description: 'ERP suit id; stock is then taken from the suit' })
  @IsOptional()
  @IsMongoId()
  erpId?: string;

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
   * Promotional price in minor units, or null to end a promotion.
   *
   * `price` stays the regular price throughout, so clearing this restores it
   * without anyone having to remember what it was. Must be below `price`.
   */
  @ApiPropertyOptional({
    description: 'Promotional price in minor units; null ends the promotion',
    example: 1999,
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: 'promotionalPrice must be an integer number of minor units' })
  @Min(0)
  promotionalPrice?: number | null;

  /**
   * Initial on-hand quantity. Present only on create — afterwards stock moves
   * exclusively through the inventory endpoints, so a catalogue edit can never
   * overwrite a concurrent sale's decrement.
   */
  @ApiPropertyOptional({ description: 'Opening stock', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number;

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
   * The sizes this product is offered in.
   *
   * Leave empty for an unstitched piece. `sizing` is derived from this when it
   * is not stated, so the two can never contradict each other.
   */
  @ApiPropertyOptional({ type: [String], description: 'Size ids, from GET /sizes' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsMongoId({ each: true })
  sizes?: string[];

  @ApiPropertyOptional({
    enum: ProductSizing,
    description: 'Derived from `sizes` when omitted: empty means UNSTITCHED',
  })
  @IsOptional()
  @IsEnum(ProductSizing)
  sizing?: ProductSizing;

  @ApiPropertyOptional({ type: [ProductImageDto], maxItems: MAX_PRODUCT_IMAGES })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PRODUCT_IMAGES, {
    message: `A product may have at most ${MAX_PRODUCT_IMAGES} images`,
  })
  @ValidateNested({ each: true })
  @Type(() => ProductImageDto)
  images?: ProductImageDto[];

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
 * Every field optional, with `stock` and `erpId` removed outright.
 *
 * `OmitType` strips the validation metadata, not just the TypeScript type — so
 * with `forbidNonWhitelisted` it becomes a 400 rather than a silently accepted
 * key. Adjusting stock is an inventory operation with its own concurrency
 * guarantees, not a catalogue edit; and the suit a product is built on is
 * chosen once, at creation, because moving it would move where its stock lives.
 */
export class UpdateProductDto extends PartialType(
  OmitType(CreateProductDto, ['stock', 'erpId'] as const),
) {}
