import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { IntervalOption } from '../analytics-window';

const INTERVALS = ['auto', 'day', 'week', 'month'] as const;

/**
 * The reporting period.
 *
 * Only the shape is validated here. The cross-field rules — `from` before `to`,
 * at most a year, defaults, date-only to instant — live in `resolveWindow`,
 * because that resolution has to happen anyway and one place should know what a
 * window is.
 */
export class AnalyticsRangeDto {
  @ApiPropertyOptional({
    description:
      'Inclusive start. A date-only value (2026-08-01) means local midnight in the store ' +
      'timezone. Defaults to 30 days before `to`.',
    example: '2026-08-01',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    description:
      'End of the window. A date-only value (2026-08-31) means the END of that day, so the ' +
      'day you name is included. A full timestamp is used as the exact exclusive instant. ' +
      'Defaults to now.',
    example: '2026-08-31',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;

  @ApiPropertyOptional({
    enum: INTERVALS,
    default: 'auto',
    description: 'Bucket size for the series. `auto` picks by window length.',
  })
  @IsOptional()
  @IsIn(INTERVALS)
  interval: IntervalOption = 'auto';
}

const TOP_PRODUCT_SORTS = ['units', 'revenue'] as const;
export type TopProductSort = (typeof TOP_PRODUCT_SORTS)[number];

export class TopProductsQueryDto extends AnalyticsRangeDto {
  @ApiPropertyOptional({ enum: TOP_PRODUCT_SORTS, default: 'units' })
  @IsOptional()
  @IsIn(TOP_PRODUCT_SORTS)
  sort: TopProductSort = 'units';

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 10;
}
