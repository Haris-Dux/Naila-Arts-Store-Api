import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { ProductSizing } from '../enums/product-sizing.enum';

/**
 * Sortable fields, as an allow-list.
 *
 * `relevance` is only meaningful alongside `search`; the service falls back to
 * `createdAt` when no search term is present.
 */
export const PRODUCT_SORT_FIELDS = [
  'createdAt',
  'effectivePrice',
  'name',
  'sellCount',
  // Ascending gives the low-stock report the dashboard needs; there is no
  // dedicated inventory-alert endpoint, and `inStock` is a boolean that only
  // narrows to stock > 0, so it cannot express "running out".
  'stock',
  'rating.average',
  'relevance',
] as const;
export type ProductSortField = (typeof PRODUCT_SORT_FIELDS)[number];

/**
 * Sorts a cursor can anchor to.
 *
 * `relevance` is absent on purpose: it is a computed `textScore`, not a stored
 * field, so there is nothing to compare a cursor against without recomputing the
 * score for every candidate document. Search stays on page pagination, where a
 * short result set makes drift immaterial.
 */
export const CURSOR_SORT_FIELDS = PRODUCT_SORT_FIELDS.filter(
  (field) => field !== 'relevance',
);

export class ListProductsDto extends PaginationDto {
  /**
   * `page` counts from the start of a result set that changes underneath the
   * reader; `cursor` names a position in the ordering and is what an endless
   * feed needs. Page remains the default so existing callers — the dashboard,
   * which shows numbered pages and a total — are unaffected.
   */
  @ApiPropertyOptional({
    enum: ['page', 'cursor'],
    default: 'page',
    description: 'Use `cursor` for infinite scroll; `page` for numbered pages.',
  })
  @IsIn(['page', 'cursor'])
  @IsOptional()
  paginate: 'page' | 'cursor' = 'page';

  @ApiPropertyOptional({
    description:
      'Opaque position from the previous response’s `meta.nextCursor`. Omit for the first page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  /**
   * Validated against the allow-list above. The old services interpolated this
   * straight into a TypeORM `orderBy` — which is not parameterized — so `?sort=`
   * was an injection point reachable without authentication.
   */
  @ApiPropertyOptional({ enum: PRODUCT_SORT_FIELDS, default: 'createdAt' })
  @IsIn(PRODUCT_SORT_FIELDS)
  @IsOptional()
  sort: ProductSortField = 'createdAt';

  @ApiPropertyOptional({ description: 'Full-text search over name and description' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : (value as string),
  )
  search?: string;

  /**
   * Matches everything in the branch, not just products placed directly in the
   * parent — a product in a subcategory carries its parent's id too, so this
   * stays a plain equality match.
   */
  @ApiPropertyOptional({ description: 'Every product under this top-level category' })
  @IsOptional()
  @IsMongoId()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Narrow to a single subcategory' })
  @IsOptional()
  @IsMongoId()
  subcategoryId?: string;

  @ApiPropertyOptional({
    enum: ProductSizing,
    description: 'Only products sold in this form; one sold both ways matches either',
  })
  @IsOptional()
  @IsEnum(ProductSizing)
  sizing?: ProductSizing;

  @ApiPropertyOptional({ description: 'Only products offered in this size' })
  @IsOptional()
  @IsMongoId()
  sizeId?: string;

  @ApiPropertyOptional({ description: 'Only products with a promotional price, in any form' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  onPromotion?: boolean;

  @ApiPropertyOptional({
    description: 'Minimum price, minor units — the price charged, in the cheaper form',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({ description: 'Maximum price, minor units' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({ description: 'Only products with stock remaining' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  inStock?: boolean;

  /**
   * Admin only — the service ignores it for shoppers, who always see active
   * products exclusively.
   */
  @ApiPropertyOptional({ description: 'Include inactive products (staff only)' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}
