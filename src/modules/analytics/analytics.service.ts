import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Cache } from 'cache-manager';
import { Model, PipelineStage, Types } from 'mongoose';

import { ValidationFailedException } from '../../common/exceptions/domain.exception';
import { Money } from '../../common/money';
import { notDeleted } from '../../common/schemas/base.schema';
import { Category, CategoryDocument } from '../categories/schemas/category.schema';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { MoneyDto } from '../products/dto/product-response.dto';

import { AnalyticsWindow, bucketStarts, resolveWindow } from './analytics-window';
import { ANALYTICS_TTL_MS, BOOKED_REVENUE_STATUSES } from './analytics.constants';
import { AnalyticsRangeDto, TopProductsQueryDto } from './dto/analytics-range.dto';
import {
  AnalyticsPeriodDto,
  AnalyticsSummaryDto,
  CountMetricDto,
  MoneyMetricDto,
  RevenueSeriesDto,
  SalesByCategoryDto,
  TopProductsDto,
} from './dto/analytics-response.dto';

/** Both halves of the comparison come back from one pipeline, tagged. */
type WindowTag = 'current' | 'previous';

interface SummaryRow {
  _id: WindowTag;
  revenueMinor: number;
  productRevenueMinor: number;
  orderCount: number;
  unitsSold: number;
  currencies: string[];
}

interface SeriesRow {
  _id: Date;
  revenueMinor: number;
  orderCount: number;
  unitsSold: number;
}

interface TopProductRow {
  _id: Types.ObjectId;
  name: string;
  unitsSold: number;
  productRevenueMinor: number;
}

interface CategorySalesRow {
  _id: Types.ObjectId | null;
  name: string;
  unitsSold: number;
  productRevenueMinor: number;
  productCount: number;
}

interface NewCustomerRow {
  _id: WindowTag;
  count: number;
}

const EMPTY_SUMMARY: Omit<SummaryRow, '_id'> = {
  revenueMinor: 0,
  productRevenueMinor: 0,
  orderCount: 0,
  unitsSold: 0,
  currencies: [],
};

/**
 * Read-only reporting over orders, the catalogue and the customer list.
 *
 * Every figure is bucketed by `placedAt` and filtered to BOOKED_REVENUE_STATUSES
 * — see analytics.constants.ts for why PENDING counts and why the definition is
 * a deny-list.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly currency: string;
  private readonly timezone: string;

  /** Bump when a metric definition changes, so old entries cannot outlive it. */
  private static readonly CACHE_VERSION = 1;

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Category.name) private readonly categoryModel: Model<CategoryDocument>,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    config: ConfigService,
  ) {
    this.currency = config.getOrThrow<string>('store.currency');
    this.timezone = config.getOrThrow<string>('store.timezone');
  }

  // ---------------------------------------------------------------- endpoints

  async summary(query: AnalyticsRangeDto): Promise<AnalyticsSummaryDto> {
    const window = resolveWindow(query, this.timezone);

    return this.cached(this.key('summary', window), async () => {
      const [rows, newCustomers] = await Promise.all([
        this.orderModel.aggregate<SummaryRow>(this.summaryPipeline(window)).exec(),
        this.newCustomers(window),
      ]);

      // Either group is absent when that window had no orders at all.
      const current = rows.find((row) => row._id === 'current') ?? EMPTY_SUMMARY;
      const previous = rows.find((row) => row._id === 'previous') ?? EMPTY_SUMMARY;

      this.assertSingleCurrency([...current.currencies, ...previous.currencies]);

      return {
        period: this.period(window),
        currency: this.currency,
        countedStatuses: [...BOOKED_REVENUE_STATUSES],
        revenue: this.moneyMetric(current.revenueMinor, previous.revenueMinor),
        productRevenue: this.moneyMetric(
          current.productRevenueMinor,
          previous.productRevenueMinor,
        ),
        orders: this.countMetric(current.orderCount, previous.orderCount),
        averageOrderValue: this.moneyMetric(
          averageOrderValue(current.revenueMinor, current.orderCount),
          averageOrderValue(previous.revenueMinor, previous.orderCount),
        ),
        unitsSold: this.countMetric(current.unitsSold, previous.unitsSold),
        newCustomers,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  async revenueSeries(query: AnalyticsRangeDto): Promise<RevenueSeriesDto> {
    const window = resolveWindow(query, this.timezone);

    return this.cached(this.key('revenue-series', window), async () => {
      const rows = await this.orderModel.aggregate<SeriesRow>(this.seriesPipeline(window)).exec();

      const byBucket = new Map(rows.map((row) => [new Date(row._id).getTime(), row]));

      // Zero-filled in TypeScript rather than with $densify: $densify has no
      // timezone parameter and would step calendar units against offset
      // instants, drifting an hour across a DST boundary. The output is at most
      // 366 points, and this way it is testable without a database.
      const buckets = bucketStarts(window).map((start) => {
        const row = byBucket.get(start.getTime());
        return {
          bucket: start.toISOString(),
          revenue: this.money(row?.revenueMinor ?? 0),
          orders: row?.orderCount ?? 0,
          unitsSold: row?.unitsSold ?? 0,
        };
      });

      return {
        period: this.period(window),
        currency: this.currency,
        buckets,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  async topProducts(query: TopProductsQueryDto): Promise<TopProductsDto> {
    const window = resolveWindow(query, this.timezone);

    return this.cached(
      this.key('top-products', window, { sort: query.sort, limit: query.limit }),
      async () => {
        const rows = await this.orderModel
          .aggregate<TopProductRow>(this.topProductsPipeline(window, query.sort, query.limit))
          .exec();

        return {
          period: this.period(window),
          currency: this.currency,
          items: rows.map((row) => ({
            // Aggregation output is raw BSON — the id/__v transform is a schema
            // plugin and does not run here, so ObjectIds must be stringified by
            // hand or they serialise as { buffer: ... }.
            productId: row._id.toString(),
            name: row.name,
            unitsSold: row.unitsSold,
            productRevenue: this.money(row.productRevenueMinor),
          })),
          generatedAt: new Date().toISOString(),
        };
      },
    );
  }

  async salesByCategory(query: AnalyticsRangeDto): Promise<SalesByCategoryDto> {
    const window = resolveWindow(query, this.timezone);

    return this.cached(this.key('sales-by-category', window), async () => {
      const rows = await this.orderModel
        .aggregate<CategorySalesRow>(this.categorySalesPipeline(window))
        .exec();

      return {
        period: this.period(window),
        currency: this.currency,
        items: rows.map((row) => ({
          categoryId: row._id ? row._id.toString() : null,
          name: row.name,
          unitsSold: row.unitsSold,
          productRevenue: this.money(row.productRevenueMinor),
          productCount: row.productCount,
        })),
        generatedAt: new Date().toISOString(),
      };
    });
  }

  // ---------------------------------------------------------------- pipelines

  /** Live orders in a booked status. Every pipeline starts from this shape. */
  private bookedOrdersMatch(from: Date, to: Date): PipelineStage.Match {
    return {
      $match: {
        ...notDeleted,
        status: { $in: [...BOOKED_REVENUE_STATUSES] },
        placedAt: { $gte: from, $lt: to },
      },
    };
  }

  /**
   * Both windows in one pass.
   *
   * A single $match over `[previousFrom, to)` is one contiguous range on
   * analytics_status_placedAt, and — the real reason — with one $match the two
   * windows' definitions cannot drift apart. Two queries is how a
   * period-over-period comparison quietly ends up comparing different things.
   */
  private summaryPipeline(window: AnalyticsWindow): PipelineStage[] {
    return [
      this.bookedOrdersMatch(window.previousFrom, window.to),
      {
        $group: {
          _id: { $cond: [{ $gte: ['$placedAt', window.from] }, 'current', 'previous'] },
          revenueMinor: { $sum: '$grandTotal' },
          productRevenueMinor: { $sum: '$subtotal' },
          orderCount: { $sum: 1 },
          // No $unwind: '$items.quantity' resolves to an array of numbers, the
          // inner $sum folds it, the outer accumulates across orders. $unwind
          // here would multiply the revenue accumulators beside it by the line
          // count.
          unitsSold: { $sum: { $sum: '$items.quantity' } },
          // Currency is per-order. Collected so the service can refuse to add
          // PKR to USD rather than silently doing it.
          currencies: { $addToSet: '$currency' },
        },
      },
      // Deliberately no $avg for the order value: it yields a fraction and
      // Money.fromMinor throws on non-integers. The division happens in
      // TypeScript where the divide-by-zero guard is visible.
    ];
  }

  private seriesPipeline(window: AnalyticsWindow): PipelineStage[] {
    return [
      this.bookedOrdersMatch(window.from, window.to),
      {
        $group: {
          _id: {
            $dateTrunc: {
              date: '$placedAt',
              unit: window.granularity,
              binSize: 1,
              // The merchant's day, not UTC's. For a UTC+5 store a UTC day runs
              // 05:00 to 05:00 local, which files every after-midnight order
              // under the day before.
              timezone: window.timezone,
              ...(window.granularity === 'week' ? { startOfWeek: 'monday' } : {}),
            },
          },
          revenueMinor: { $sum: '$grandTotal' },
          orderCount: { $sum: 1 },
          unitsSold: { $sum: { $sum: '$items.quantity' } },
        },
      },
      { $sort: { _id: 1 } },
    ];
  }

  private topProductsPipeline(
    window: AnalyticsWindow,
    sort: 'units' | 'revenue',
    limit: number,
  ): PipelineStage[] {
    return [
      this.bookedOrdersMatch(window.from, window.to),
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.productId',
          unitsSold: { $sum: '$items.quantity' },
          // lineTotal is unitPrice × quantity for this line, written by
          // CheckoutService. Never $sum '$grandTotal' after an $unwind: the
          // order total is copied onto every line, so a three-line order would
          // contribute its whole total to each of three products.
          productRevenueMinor: { $sum: '$items.lineTotal' },
          // The name as snapshotted on the most recent sale, so a renamed or
          // withdrawn product still has a label.
          name: { $top: { sortBy: { placedAt: -1 }, output: '$items.name' } },
        },
      },
      {
        // _id breaks ties so the ordering is stable between calls.
        $sort:
          sort === 'units'
            ? { unitsSold: -1, productRevenueMinor: -1, _id: 1 }
            : { productRevenueMinor: -1, unitsSold: -1, _id: 1 },
      },
      { $limit: limit },
    ];
  }

  private categorySalesPipeline(window: AnalyticsWindow): PipelineStage[] {
    return [
      this.bookedOrdersMatch(window.from, window.to),
      { $unwind: '$items' },
      {
        // Collapse to one document per distinct product BEFORE the join. This is
        // what bounds the lookup count by the catalogue (hundreds) instead of by
        // sales volume (every line item ever sold in the window).
        $group: {
          _id: '$items.productId',
          unitsSold: { $sum: '$items.quantity' },
          productRevenueMinor: { $sum: '$items.lineTotal' },
        },
      },
      {
        $lookup: {
          from: this.productModel.collection.name,
          localField: '_id',
          foreignField: '_id',
          as: 'product',
          // Deliberately no deletedAt filter: a soft-deleted product still made
          // those sales, and dropping it here would delete revenue from the
          // report rather than merely mislabel it.
          pipeline: [{ $project: { _id: 0, categoryId: 1 } }],
        },
      },
      // Product.categoryId is always the ROOT category, even when subcategoryId
      // is set, so this one field already means "everything under this parent".
      // No $graphLookup, no parent resolution.
      { $set: { categoryId: { $first: '$product.categoryId' } } },
      {
        $group: {
          // Null for a product that is genuinely gone. Kept as its own bucket
          // rather than dropped, so the totals still add up.
          _id: '$categoryId',
          unitsSold: { $sum: '$unitsSold' },
          productRevenueMinor: { $sum: '$productRevenueMinor' },
          productCount: { $sum: 1 },
        },
      },
      {
        $lookup: {
          from: this.categoryModel.collection.name,
          localField: '_id',
          foreignField: '_id',
          as: 'category',
          // Again no deletedAt/isActive filter — a retired category's history is
          // still history, and it needs a readable name.
          pipeline: [{ $project: { _id: 0, name: 1 } }],
        },
      },
      { $set: { category: { $first: '$category' } } },
      {
        $project: {
          _id: 1,
          name: { $ifNull: ['$category.name', 'Uncategorised'] },
          unitsSold: 1,
          productRevenueMinor: 1,
          productCount: 1,
        },
      },
      { $sort: { productRevenueMinor: -1, _id: 1 } },
    ];
  }

  /**
   * First-time buyers, keyed by contact email.
   *
   * Not by userId: guest orders have `userId: null`, so a userId key would count
   * every guest as nobody. `contactEmail` is read from the account for a
   * registered customer and never from the request body, so it also dedupes a
   * guest who later registers with the same address. A household sharing an
   * address counts once — the right trade against double-counting every guest.
   *
   * This scans the whole live booked order set on a cache miss, and no index
   * avoids it ($min per group is not a distinct scan). At a few hundred thousand
   * orders the answer is a materialised firstOrderAt maintained off the existing
   * order.placed outbox event; it is not worth building yet.
   */
  private async newCustomers(window: AnalyticsWindow): Promise<CountMetricDto> {
    const rows = await this.orderModel
      .aggregate<NewCustomerRow>([
        {
          $match: {
            ...notDeleted,
            status: { $in: [...BOOKED_REVENUE_STATUSES] },
            // No lower bound: "first" means first ever.
            placedAt: { $lt: window.to },
          },
        },
        {
          $group: {
            // The schema lowercases contactEmail on write; $toLower also covers
            // anything inserted by a migration or the raw driver.
            _id: { $toLower: '$contactEmail' },
            firstOrderAt: { $min: '$placedAt' },
          },
        },
        { $match: { firstOrderAt: { $gte: window.previousFrom } } },
        {
          $group: {
            _id: { $cond: [{ $gte: ['$firstOrderAt', window.from] }, 'current', 'previous'] },
            count: { $sum: 1 },
          },
        },
      ])
      .exec();

    const current = rows.find((row) => row._id === 'current')?.count ?? 0;
    const previous = rows.find((row) => row._id === 'previous')?.count ?? 0;

    return this.countMetric(current, previous);
  }

  // ------------------------------------------------------------------ mapping

  private period(window: AnalyticsWindow): AnalyticsPeriodDto {
    return {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      previousFrom: window.previousFrom.toISOString(),
      previousTo: window.from.toISOString(),
      timezone: window.timezone,
      granularity: window.granularity,
    };
  }

  private money(minor: number): MoneyDto {
    // Everything reaching here is an integer: $sum over integer fields stays
    // integral, and the order value is rounded in TypeScript rather than left as
    // $avg's fraction. Money.fromMinor throwing is the guard on that claim.
    return Money.fromMinor(minor, this.currency).toJSON();
  }

  private moneyMetric(current: number, previous: number): MoneyMetricDto {
    return {
      current: this.money(current),
      previous: this.money(previous),
      change: this.money(current - previous),
      changePercent: percentChange(current, previous),
    };
  }

  private countMetric(current: number, previous: number): CountMetricDto {
    return {
      current,
      previous,
      change: current - previous,
      changePercent: percentChange(current, previous),
    };
  }

  private assertSingleCurrency(currencies: string[]): void {
    const distinct = [...new Set(currencies)];
    const foreign = distinct.filter((currency) => currency !== this.currency);

    if (foreign.length > 0) {
      // Summing across currencies is not a smaller error than failing.
      throw new ValidationFailedException(
        'Orders in this period were placed in more than one currency',
        { expected: this.currency, found: distinct },
      );
    }
  }

  // -------------------------------------------------------------------- cache

  /** Keyed on the RESOLVED window, so two spellings of one range share a hit. */
  private key(
    endpoint: string,
    window: AnalyticsWindow,
    extra: Record<string, unknown> = {},
  ): string {
    const parts = {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      granularity: window.granularity,
      tz: window.timezone,
      ...extra,
    };

    const fingerprint = Object.entries(parts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}=${String(value)}`)
      .join('&');

    return `analytics:${endpoint}:v${AnalyticsService.CACHE_VERSION}:${fingerprint}`;
  }

  /**
   * A cache is an optimisation, never a dependency — the same bargain
   * CatalogCacheService makes. If Redis is unreachable the dashboard still
   * loads, just slower.
   *
   * There is no invalidation: the TTL is the invalidation, and this module has
   * no write path to hang a listener off.
   */
  private async cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
    try {
      const hit = await this.cache.get<T>(key);
      if (hit !== undefined && hit !== null) return hit;
    } catch (error) {
      this.logger.warn(`Analytics cache unavailable on read: ${asMessage(error)}`);
    }

    const value = await compute();

    try {
      await this.cache.set(key, value, ANALYTICS_TTL_MS);
    } catch (error) {
      this.logger.warn(`Analytics cache unavailable on write: ${asMessage(error)}`);
    }

    return value;
  }
}

/** Integer minor units, so it can go straight into Money.fromMinor. */
function averageOrderValue(revenueMinor: number, orderCount: number): number {
  return orderCount === 0 ? 0 : Math.round(revenueMinor / orderCount);
}

/**
 * Null when there is no baseline.
 *
 * Never 0, never 100, never Infinity — "up from nothing" is not a percentage,
 * and rendering it as one is how a dashboard claims a 100% rise on its first day
 * of trading.
 */
function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
