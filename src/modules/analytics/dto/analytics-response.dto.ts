import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderStatus } from '../../orders/enums/order-status.enum';
import { MoneyDto } from '../../products/dto/product-response.dto';

/** A figure, the same figure for the preceding period, and the move between. */
export class MoneyMetricDto {
  @ApiProperty({ type: MoneyDto }) current!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) previous!: MoneyDto;
  @ApiProperty({ type: MoneyDto, description: 'current − previous; negative when down' })
  change!: MoneyDto;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Null when the previous period is zero — there is no baseline to divide by.',
  })
  changePercent!: number | null;
}

export class CountMetricDto {
  @ApiProperty() current!: number;
  @ApiProperty() previous!: number;
  @ApiProperty({ description: 'current − previous; negative when down' }) change!: number;
  @ApiPropertyOptional({ type: Number, nullable: true }) changePercent!: number | null;
}

/** The period a response covers, echoed so the client never has to re-derive it. */
export class AnalyticsPeriodDto {
  @ApiProperty() from!: string;
  @ApiProperty({ description: 'Exclusive' }) to!: string;
  @ApiProperty() previousFrom!: string;
  @ApiProperty({ description: 'Exclusive; equals `from`' }) previousTo!: string;
  @ApiProperty({ example: 'Asia/Karachi' }) timezone!: string;
  @ApiProperty({ enum: ['day', 'week', 'month'] }) granularity!: string;
}

export class AnalyticsSummaryDto {
  @ApiProperty({ type: AnalyticsPeriodDto }) period!: AnalyticsPeriodDto;
  @ApiProperty({ example: 'USD' }) currency!: string;

  /**
   * The revenue definition, travelling with the number it produced.
   *
   * When someone asks why this does not match their own tally, the answer is in
   * the payload rather than in a document somewhere.
   */
  @ApiProperty({
    enum: OrderStatus,
    isArray: true,
    description: 'Order statuses counted as booked revenue. PENDING is one of them.',
  })
  countedStatuses!: OrderStatus[];

  @ApiProperty({
    type: MoneyMetricDto,
    description: 'Σ grandTotal — what customers were charged, including shipping and tax',
  })
  revenue!: MoneyMetricDto;

  @ApiProperty({
    type: MoneyMetricDto,
    description:
      'Σ subtotal — merchandise only. This is the figure top-products and sales-by-category ' +
      'sum to exactly; `revenue` is not, because it carries shipping, tax and discount.',
  })
  productRevenue!: MoneyMetricDto;

  @ApiProperty({ type: CountMetricDto }) orders!: CountMetricDto;

  @ApiProperty({ type: MoneyMetricDto, description: 'revenue ÷ orders, rounded to the minor unit' })
  averageOrderValue!: MoneyMetricDto;

  @ApiProperty({ type: CountMetricDto }) unitsSold!: CountMetricDto;

  @ApiProperty({
    type: CountMetricDto,
    description: 'Distinct contact emails whose first ever booked order fell in the period',
  })
  newCustomers!: CountMetricDto;

  @ApiProperty({
    description:
      'These figures mutate: a cancellation or return reduces the period the order was placed in.',
  })
  generatedAt!: string;
}

export class RevenueBucketDto {
  @ApiProperty({ description: 'Start of the bucket, in the store timezone' })
  bucket!: string;
  @ApiProperty({ type: MoneyDto }) revenue!: MoneyDto;
  @ApiProperty() orders!: number;
  @ApiProperty() unitsSold!: number;
}

export class RevenueSeriesDto {
  @ApiProperty({ type: AnalyticsPeriodDto }) period!: AnalyticsPeriodDto;
  @ApiProperty({ example: 'USD' }) currency!: string;
  @ApiProperty({
    type: RevenueBucketDto,
    isArray: true,
    description: 'Every bucket in the period. A bucket with no orders is present, at zero.',
  })
  buckets!: RevenueBucketDto[];
  @ApiProperty() generatedAt!: string;
}

export class TopProductDto {
  @ApiProperty() productId!: string;
  @ApiProperty({ description: 'Name as snapshotted on the most recent sale in the period' })
  name!: string;
  @ApiProperty() unitsSold!: number;
  @ApiProperty({
    type: MoneyDto,
    description:
      'Merchandise value of this product’s lines (unitPrice × quantity). Excludes shipping, ' +
      'tax and order-level discount, so it does NOT sum to summary.revenue. It sums exactly ' +
      'to summary.productRevenue.',
  })
  productRevenue!: MoneyDto;
}

export class TopProductsDto {
  @ApiProperty({ type: AnalyticsPeriodDto }) period!: AnalyticsPeriodDto;
  @ApiProperty({ example: 'USD' }) currency!: string;
  @ApiProperty({ type: TopProductDto, isArray: true }) items!: TopProductDto[];
  @ApiProperty() generatedAt!: string;
}

export class CategorySalesDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Null for lines whose product no longer exists',
  })
  categoryId!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty() unitsSold!: number;
  @ApiProperty({ type: MoneyDto }) productRevenue!: MoneyDto;
  @ApiProperty({ description: 'Distinct products of this category sold in the period' })
  productCount!: number;
}

export class SalesByCategoryDto {
  @ApiProperty({ type: AnalyticsPeriodDto }) period!: AnalyticsPeriodDto;
  @ApiProperty({ example: 'USD' }) currency!: string;
  @ApiProperty({ type: CategorySalesDto, isArray: true }) items!: CategorySalesDto[];
  @ApiProperty() generatedAt!: string;
}
