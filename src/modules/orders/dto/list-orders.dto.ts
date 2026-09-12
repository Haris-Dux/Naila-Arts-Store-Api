import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsMongoId, IsOptional } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { OrderStatus } from '../enums/order-status.enum';

export const ORDER_SORT_FIELDS = ['createdAt', 'placedAt', 'grandTotal', 'status'] as const;
export type OrderSortField = (typeof ORDER_SORT_FIELDS)[number];

export class ListOrdersDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ORDER_SORT_FIELDS, default: 'createdAt' })
  @IsIn(ORDER_SORT_FIELDS)
  @IsOptional()
  sort: OrderSortField = 'createdAt';

  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  /**
   * Ignored for non-staff callers, who always see only their own orders — the
   * service scopes the query to the authenticated user regardless of what is
   * passed here.
   */
  @ApiPropertyOptional({ description: 'Filter by customer (staff only)' })
  @IsOptional()
  @IsMongoId()
  userId?: string;
}
