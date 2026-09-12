import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Base pagination query. Modules extend this and override `sort` with an
 * @IsIn(...) over their own allow-list of sortable fields.
 *
 * The allow-list is not cosmetic: the old services interpolated the raw `?sort=`
 * value straight into a TypeORM `orderBy`, which is not parameterized — an
 * injection point. Here an unlisted field is rejected as a 400 before it reaches
 * the query layer.
 */
export class PaginationDto {
  @ApiPropertyOptional({ minimum: 1, default: 1, description: '1-indexed page number' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit: number = 20;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsIn(['asc', 'desc'])
  @IsOptional()
  order: 'asc' | 'desc' = 'desc';

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}

export class PageMeta {
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() pages!: number;
  @ApiProperty() hasNext!: boolean;
  @ApiProperty() hasPrevious!: boolean;
}

export class Page<T> {
  @ApiProperty({ isArray: true })
  items!: T[];

  @ApiProperty({ type: PageMeta })
  meta!: PageMeta;

  static of<T>(items: T[], total: number, page: number, limit: number): Page<T> {
    const pages = Math.max(1, Math.ceil(total / limit));
    return {
      items,
      meta: {
        total,
        page,
        limit,
        pages,
        hasNext: page < pages,
        hasPrevious: page > 1,
      },
    };
  }
}

/**
 * What a cursor-paginated response carries instead of page numbers.
 *
 * Deliberately no `total` and no `pages`. Counting the whole matching set is a
 * second query whose answer is stale the moment it is computed, and an endless
 * feed has no use for it — the only question a scroller asks is "is there more,
 * and where do I resume". Paying for a count on every scroll tick would be the
 * dominant cost of the endpoint.
 */
export class CursorMeta {
  @ApiProperty() limit!: number;
  @ApiProperty({ description: 'Whether another page exists' }) hasNext!: boolean;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Opaque. Pass back as `cursor` to fetch the next page; null at the end.',
  })
  nextCursor!: string | null;
}

export class CursorPage<T> {
  @ApiProperty({ isArray: true })
  items!: T[];

  @ApiProperty({ type: CursorMeta })
  meta!: CursorMeta;

  /**
   * Built from one extra row.
   *
   * The service asks for `limit + 1` documents; if the extra one came back there
   * is another page. That answers "is there more" exactly, without a count.
   */
  static of<T>(rows: T[], limit: number, cursorOf: (row: T) => string): CursorPage<T> {
    const hasNext = rows.length > limit;
    const items = hasNext ? rows.slice(0, limit) : rows;

    return {
      items,
      meta: {
        limit,
        hasNext,
        nextCursor: hasNext && items.length > 0 ? cursorOf(items[items.length - 1]) : null,
      },
    };
  }
}
