import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Money } from '../../../common/money';
import { ProductSizing } from '../enums/product-sizing.enum';
import { VideoPlatform } from '../enums/video-platform.enum';
import { ProductDocument, ProductImage } from '../schemas/product.schema';

export class MoneyDto {
  @ApiProperty({ description: 'Minor units', example: 1999 }) amount!: number;
  @ApiProperty({ example: 'USD' }) currency!: string;
  @ApiProperty({ example: '$19.99' }) formatted!: string;
}

export class ProductImageResponseDto {
  @ApiProperty() mediaId!: string;
  /** Immutable: the filename is the content hash, so this URL never restates. */
  @ApiProperty() url!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) alt!: string | null;
  @ApiProperty() position!: number;
  /** Known before the bytes arrive, so a grid can reserve the right box. */
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
}

/** A size a product is offered in. `name`/`code` are null when not resolved. */
export class ProductSizeResponseDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) name!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) code!: string | null;
}

/** One form the product is sold in, and its price in that form. */
export class ProductOfferResponseDto {
  @ApiProperty({ enum: ProductSizing, description: 'SIZED is sold stitched, to a size' })
  sizing!: ProductSizing;
  /** The regular price. Shown struck through while a promotion is running. */
  @ApiProperty({ type: MoneyDto }) price!: MoneyDto;
  @ApiPropertyOptional({ type: MoneyDto, nullable: true }) promotionalPrice!: MoneyDto | null;
  /** What the customer pays in this form. Clients should render this one. */
  @ApiProperty({ type: MoneyDto }) effectivePrice!: MoneyDto;
  @ApiProperty() isOnPromotion!: boolean;
}

/** One colour of the product. */
export class ProductVariantResponseDto {
  /** What a basket line and an order line send as `variantId`. */
  @ApiProperty() id!: string;
  @ApiProperty() color!: string;
  /** The shade to fill this colour's button with, as `#rrggbb`. */
  @ApiProperty({ example: '#7a1f3d' }) hex!: string;
  /** The ERP suit this colour is; its stock lives there. */
  @ApiProperty() erpId!: string;
  @ApiProperty({ description: 'Units on hand in this colour' }) stock!: number;
  @ApiProperty() inStock!: boolean;
  @ApiProperty({ type: [ProductImageResponseDto] }) images!: ProductImageResponseDto[];
}

type MediaFiles = Map<string, { url: string; width: number; height: number }>;

/**
 * Explicit field-by-field mapping, like UserResponseDto — adding an internal
 * field to the schema must never silently publish it.
 */
export class ProductResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) description!: string | null;
  /** The forms it is sold in, stitched first, each with its own price. */
  @ApiProperty({ type: [ProductOfferResponseDto] }) offers!: ProductOfferResponseDto[];
  /** The lowest price among `offers` — the "from" price a listing shows. */
  @ApiProperty({ type: MoneyDto }) effectivePrice!: MoneyDto;
  @ApiProperty({ description: 'Units on hand across every colour' }) stock!: number;
  @ApiProperty() inStock!: boolean;
  @ApiProperty() categoryId!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) subcategoryId!: string | null;
  /** The colours it comes in, in display order, each with its own photographs. */
  @ApiProperty({ type: [ProductVariantResponseDto] }) variants!: ProductVariantResponseDto[];
  @ApiProperty({ type: [ProductSizeResponseDto] }) sizes!: ProductSizeResponseDto[];
  @ApiProperty() rating!: { average: number; count: number };
  @ApiProperty() sellCount!: number;
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) sku!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) videoUrl!: string | null;
  /** Which player to embed `videoUrl` in. Null exactly when `videoUrl` is. */
  @ApiPropertyOptional({ enum: VideoPlatform, nullable: true })
  videoPlatform!: VideoPlatform | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;

  static from(
    this: void,
    product: ProductDocument,
    currency: string,
    sizes?: ProductSizeResponseDto[],
    media?: MediaFiles,
  ): ProductResponseDto {
    const money = (amount: number) => Money.fromMinor(amount, currency).toJSON();

    return {
      id: product._id.toString(),
      name: product.name,
      slug: product.slug,
      description: product.description,
      offers: product.offers.map((offer) => ({
        sizing: offer.sizing,
        price: money(offer.price),
        promotionalPrice: offer.promotionalPrice === null ? null : money(offer.promotionalPrice),
        effectivePrice: money(offer.effectivePrice),
        isOnPromotion: offer.promotionalPrice !== null,
      })),
      effectivePrice: money(product.effectivePrice),
      stock: product.stock,
      inStock: product.stock > 0,
      categoryId: product.categoryId.toString(),
      subcategoryId: product.subcategoryId ? product.subcategoryId.toString() : null,
      variants: product.variants.map((variant) => ({
        id: variant._id.toString(),
        color: variant.color,
        hex: variant.hex,
        erpId: variant.erpId,
        stock: variant.stock,
        inStock: variant.stock > 0,
        images: ProductResponseDto.images(variant.images, media),
      })),
      // Populated when the caller asked for it; ids alone otherwise, so a list
      // page does not silently fan out into a lookup per product.
      sizes: sizes ?? product.sizes.map((id) => ({ id: id.toString(), name: null, code: null })),
      rating: { average: product.rating.average, count: product.rating.count },
      sellCount: product.sellCount,
      isActive: product.isActive,
      sku: product.sku,
      videoUrl: product.videoUrl ?? null,
      videoPlatform: product.videoPlatform ?? null,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }

  /**
   * A colour's images, in display order, with their files resolved.
   *
   * An image whose media row has been removed is dropped rather than rendered
   * as a broken tag. Deletion refuses while a product references it, so this
   * only happens if something bypassed the API.
   */
  private static images(images: ProductImage[], media?: MediaFiles): ProductImageResponseDto[] {
    return [...images]
      .sort((a, b) => a.position - b.position)
      .flatMap((image) => {
        const file = media?.get(image.mediaId.toString());
        if (!file) return [];
        return [
          {
            mediaId: image.mediaId.toString(),
            url: file.url,
            alt: image.alt,
            position: image.position,
            width: file.width,
            height: file.height,
          },
        ];
      });
  }
}
