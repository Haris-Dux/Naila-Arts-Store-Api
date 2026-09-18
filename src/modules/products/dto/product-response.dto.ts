import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Money } from '../../../common/money';
import { ProductSizing } from '../enums/product-sizing.enum';
import { VideoPlatform } from '../enums/video-platform.enum';
import { ProductDocument } from '../schemas/product.schema';

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

/**
 * Explicit field-by-field mapping, like UserResponseDto — adding an internal
 * field to the schema must never silently publish it.
 */
export class ProductResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) description!: string | null;
  /** The regular price. Shown struck through while a promotion is running. */
  @ApiProperty({ type: MoneyDto }) price!: MoneyDto;
  @ApiPropertyOptional({ type: MoneyDto, nullable: true }) promotionalPrice!: MoneyDto | null;
  /** What the customer pays. Clients should render this one. */
  @ApiProperty({ type: MoneyDto }) effectivePrice!: MoneyDto;
  @ApiProperty() isOnPromotion!: boolean;
  @ApiProperty({ description: 'Units on hand' }) stock!: number;
  @ApiProperty() inStock!: boolean;
  @ApiProperty() categoryId!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) subcategoryId!: string | null;
  @ApiProperty({ type: [ProductImageResponseDto] }) images!: ProductImageResponseDto[];
  @ApiProperty({ type: [ProductSizeResponseDto] }) sizes!: ProductSizeResponseDto[];
  @ApiProperty({ enum: ProductSizing }) sizing!: ProductSizing;
  @ApiProperty() rating!: { average: number; count: number };
  @ApiProperty() sellCount!: number;
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) sku!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) videoUrl!: string | null;
  /** Which player to embed `videoUrl` in. Null exactly when `videoUrl` is. */
  @ApiPropertyOptional({ enum: VideoPlatform, nullable: true })
  videoPlatform!: VideoPlatform | null;
  /** The ERP suit this product is built on; its stock lives there. */
  @ApiPropertyOptional({ type: String, nullable: true }) erpId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;

  static from(
    this: void,
    product: ProductDocument,
    currency: string,
    sizes?: ProductSizeResponseDto[],
    media?: Map<string, { url: string; width: number; height: number }>,
  ): ProductResponseDto {
    return {
      id: product._id.toString(),
      name: product.name,
      slug: product.slug,
      description: product.description,
      price: Money.fromMinor(product.price, currency).toJSON(),
      promotionalPrice:
        product.promotionalPrice === null
          ? null
          : Money.fromMinor(product.promotionalPrice, currency).toJSON(),
      effectivePrice: Money.fromMinor(product.effectivePrice, currency).toJSON(),
      isOnPromotion: product.promotionalPrice !== null,
      stock: product.stock,
      inStock: product.stock > 0,
      categoryId: product.categoryId.toString(),
      subcategoryId: product.subcategoryId ? product.subcategoryId.toString() : null,
      // An image whose media row has been removed is dropped rather than
      // rendered as a broken tag. Deletion refuses while a product references
      // it, so this only happens if something bypassed the API.
      images: [...product.images]
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
        }),
      // Populated when the caller asked for it; ids alone otherwise, so a list
      // page does not silently fan out into a lookup per product.
      sizes: sizes ?? product.sizes.map((id) => ({ id: id.toString(), name: null, code: null })),
      sizing: product.sizing,
      rating: { average: product.rating.average, count: product.rating.count },
      sellCount: product.sellCount,
      isActive: product.isActive,
      sku: product.sku,
      videoUrl: product.videoUrl ?? null,
      videoPlatform: product.videoPlatform ?? null,
      erpId: product.erpId ?? null,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }
}
