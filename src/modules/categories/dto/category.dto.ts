import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { CategoryDocument } from '../schemas/category.schema';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : (value as string);

/**
 * A branch's children, in the order the merchant just dragged them into.
 *
 * The whole sibling list rather than one moved id and a target index: the
 * client already knows the resulting order, and sending it entire means the
 * server assigns dense positions in one pass instead of reasoning about a shift.
 * It is also idempotent — replaying the same request is a no-op.
 */
export class ReorderCategoriesDto {
  @ApiPropertyOptional({
    description: 'The parent whose children these are. Omit or null for the top level.',
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsMongoId()
  parentId?: string | null;

  @ApiProperty({
    type: [String],
    description: 'Every child of that parent, in the new display order',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsMongoId({ each: true })
  orderedIds!: string[];
}

export class CreateCategoryDto {
  @ApiProperty({ example: 'Electronics' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(trim)
  name!: string;

  @ApiPropertyOptional({ description: 'Derived from the name when omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  @Transform(trim)
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(trim)
  description?: string;

  /**
   * The parent to nest under, or omitted for a top-level category. The parent
   * must itself be top-level — the tree is two levels deep by design.
   */
  @ApiPropertyOptional({ description: 'Nest under this top-level category' })
  @IsOptional()
  @IsMongoId()
  parentId?: string;

  @ApiPropertyOptional({ description: 'Display position among siblings, ascending', default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  order?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {}

export class ListCategoriesDto {
  /**
   * Admin only — the service ignores it for shoppers, exactly as it does on the
   * product listing, so a hidden section cannot be revealed from the query
   * string.
   */
  @ApiPropertyOptional({ description: 'Include inactive categories (staff only)' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

export class CategoryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) description!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) parentId!: string | null;
  @ApiProperty({ description: 'Display position among siblings, ascending' }) order!: number;
  @ApiProperty() isActive!: boolean;

  static from(this: void, category: CategoryDocument): CategoryResponseDto {
    return {
      id: category._id.toString(),
      name: category.name,
      slug: category.slug,
      description: category.description,
      parentId: category.parentId ? category.parentId.toString() : null,
      order: category.order,
      isActive: category.isActive,
    };
  }
}

/**
 * A top-level category with its subcategories nested, both levels already in
 * display order.
 *
 * The storefront renders a navigation menu from one request; assembling it from
 * the flat list would mean the client re-deriving the parent/child split and the
 * sort on every page load.
 */
export class CategoryTreeDto extends CategoryResponseDto {
  @ApiProperty({ type: [CategoryResponseDto] })
  children!: CategoryResponseDto[];
}
