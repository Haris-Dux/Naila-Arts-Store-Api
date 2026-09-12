import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { MinRole } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { AnalyticsService } from './analytics.service';
import { AnalyticsRangeDto, TopProductsQueryDto } from './dto/analytics-range.dto';
import {
  AnalyticsSummaryDto,
  RevenueSeriesDto,
  SalesByCategoryDto,
  TopProductsDto,
} from './dto/analytics-response.dto';

/**
 * The numbers behind the admin dashboard.
 *
 * Read-only throughout, and admin-only: the class-level @MinRole is enough
 * because RolesGuard resolves the metadata from the handler or the class.
 */
@ApiTags('analytics')
@ApiBearerAuth()
@Controller('analytics')
@MinRole(UserRole.ADMIN)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Headline figures for a period, against the preceding equal-length one (admin)',
    description:
      'Revenue is BOOKED revenue: orders placed in the period that have not been cancelled ' +
      'or refunded. PENDING is included — on a cash-on-delivery store it is where a placed ' +
      'order sits until dispatch, and such an order never reaches PAID at all. The statuses ' +
      'counted are echoed back as `countedStatuses`. Figures are as of now rather than ' +
      'immutable: a later refund reduces the period the order was placed in.',
  })
  @ApiResponse({ status: 200, type: AnalyticsSummaryDto })
  @ApiResponse({ status: 400, description: 'Range is backwards, too long, or unparseable' })
  @ApiResponse({ status: 403, description: 'Requires ADMIN' })
  summary(@Query() query: AnalyticsRangeDto): Promise<AnalyticsSummaryDto> {
    return this.analytics.summary(query);
  }

  @Get('revenue-series')
  @ApiOperation({
    summary: 'Revenue and order count per time bucket (admin)',
    description:
      'Buckets are cut in the store timezone, not UTC. Every bucket in the period is ' +
      'present — one with no orders comes back at zero rather than being omitted.',
  })
  @ApiResponse({ status: 200, type: RevenueSeriesDto })
  @ApiResponse({ status: 403, description: 'Requires ADMIN' })
  revenueSeries(@Query() query: AnalyticsRangeDto): Promise<RevenueSeriesDto> {
    return this.analytics.revenueSeries(query);
  }

  @Get('top-products')
  @ApiOperation({
    summary: 'Best sellers for the period (admin)',
    description:
      'Computed from order line items, not from Product.sellCount — that counter is ' +
      'all-time and mutable (inventory decrements it on a return), so it is a current ' +
      'popularity ranking and will not reconcile with a period figure.',
  })
  @ApiResponse({ status: 200, type: TopProductsDto })
  @ApiResponse({ status: 403, description: 'Requires ADMIN' })
  topProducts(@Query() query: TopProductsQueryDto): Promise<TopProductsDto> {
    return this.analytics.topProducts(query);
  }

  @Get('sales-by-category')
  @ApiOperation({
    summary: 'Merchandise revenue per root category (admin)',
    description:
      'Attribution is as of now, not as of sale: an order line records the product, not its ' +
      'category, so re-filing a product moves its historical revenue with it. Products are ' +
      'grouped by their root category, which already means "everything under this parent".',
  })
  @ApiResponse({ status: 200, type: SalesByCategoryDto })
  @ApiResponse({ status: 403, description: 'Requires ADMIN' })
  salesByCategory(@Query() query: AnalyticsRangeDto): Promise<SalesByCategoryDto> {
    return this.analytics.salesByCategory(query);
  }
}
