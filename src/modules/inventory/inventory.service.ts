import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import {
  InsufficientStockException,
  ResourceNotFoundException,
  ValidationFailedException,
} from '../../common/exceptions/domain.exception';
import { EVENTS, ProductsChangedEvent } from '../../events/domain-events';
import { Suit, SuitDocument } from '../erp/schemas/suit.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';

export interface StockLine {
  productId: string;
  quantity: number;
}

/**
 * The only component permitted to change `Product.stock`.
 *
 * Everything here is a *conditional* update — the guard on the quantity lives in
 * the query filter, so the check and the write are one atomic operation inside
 * MongoDB. There is no read-modify-write window for a concurrent order to slip
 * through.
 *
 * The old `decreaseStock` did:
 *
 *     const product = await repo.findOne({ where: { id } });
 *     product.stock -= quantity;          // no guard: goes negative
 *     return repo.save(product);          // last writer wins
 *
 * Two simultaneous orders both read the same stock and both wrote it back, so
 * one decrement vanished and the value could fall below zero. Nothing checked
 * stock at order time either, so the store oversold silently.
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Suit.name) private readonly suitModel: Model<SuitDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Announce that these products changed, so their cached views are retired.
   *
   * Stock is written here, bypassing ProductsService, so nothing else would know
   * the cached copy is stale — leaving the storefront advertising units that have
   * already been sold for as long as the entry lives.
   *
   * What that retires is the products module's business, not this one's: this
   * emits `catalog.products-changed` and its listener decides. Named for the
   * effect rather than the mechanism, because the mechanism is no longer
   * inventory's to know.
   *
   * Callers inside a transaction must invoke this *after* the commit, not during
   * it: invalidating early lets a concurrent read repopulate the cache from the
   * pre-commit state, leaving it stale again.
   */
  async invalidateCache(productIds: string[]): Promise<void> {
    if (productIds.length === 0) return;
    const event: ProductsChangedEvent = { productIds };
    await this.eventEmitter.emitAsync(EVENTS.PRODUCTS_CHANGED, event);
  }

  /**
   * Take `quantity` units off the shelf, or fail.
   *
   * `stock: { $gte: quantity }` in the filter is the whole safety property: the
   * document only matches while it still holds enough, so the update either
   * applies in full or does not apply at all.
   */
  async decrease(productId: string, quantity: number, session?: ClientSession): Promise<void> {
    this.assertPositive(quantity);

    const link = await this.stockOwner(productId, session);

    if (link.erpId) {
      // The ERP owns this number. Guard and write it there, with exactly the
      // same atomicity — the filter only matches while the suit still holds
      // enough, so the sale either takes the units or takes none. (The ERP's
      // field is itself called `quantity`, hence `quantity: -quantity`.)
      const claimed = await this.suitModel
        .updateOne(
          { _id: link.erpId, quantity: { $gte: quantity } },
          { $inc: { quantity: -quantity } },
          { session },
        )
        .exec();

      if (claimed.matchedCount !== 1) {
        await this.explainSuitFailure(productId, link.erpId, quantity, session);
      }

      // Mirror, in the same transaction. The change stream will deliver this
      // same value moments later as an idempotent no-op; doing it here means the
      // customer who just bought does not see a stale figure in between.
      await this.productModel
        .updateOne(
          { _id: this.toObjectId(productId) },
          { $inc: { stock: -quantity, sellCount: quantity } },
          { session },
        )
        .exec();

      if (!session) await this.invalidateCache([productId]);
      return;
    }

    const result = await this.productModel
      .updateOne(
        {
          _id: this.toObjectId(productId),
          deletedAt: null,
          stock: { $gte: quantity },
        },
        { $inc: { stock: -quantity, sellCount: quantity } },
        { session },
      )
      .exec();

    if (result.matchedCount === 1) {
      // Outside a transaction there is no commit to wait for, so the cached view
      // can be retired immediately. Inside one, the caller does it post-commit.
      if (!session) await this.invalidateCache([productId]);
      return;
    }

    // Only on the failure path do we pay for a second read, to say *why*.
    await this.explainFailure(productId, quantity, session);
  }

  /**
   * Decrease several products together.
   *
   * Must be called inside a transaction (Phase 5's checkout supplies one), so a
   * shortfall on the third line rolls back the first two. Without a session this
   * would leave stock partially consumed for an order that never existed.
   */
  async decreaseMany(lines: StockLine[], session: ClientSession): Promise<void> {
    // Deterministic order: two concurrent checkouts touching the same products
    // take locks in the same sequence, which avoids a write conflict deadlock.
    const ordered = [...lines].sort((a, b) => a.productId.localeCompare(b.productId));
    for (const line of ordered) {
      await this.decrease(line.productId, line.quantity, session);
    }
  }

  /**
   * Put units from a cancelled or refunded order back on the shelf.
   *
   * Always un-counts the sale, because a return is the only way stock goes up
   * here now. Supplier deliveries used to land in this method too and had to
   * leave `sellCount` alone — they belong to the ERP, which books them when a
   * branch receives the goods.
   */
  async restore(productId: string, quantity: number, session?: ClientSession): Promise<void> {
    this.assertPositive(quantity);

    const link = await this.stockOwner(productId, session);

    if (link.erpId) {
      // Units go back to the ERP's count, because that is where they were taken
      // from. No guard needed: putting stock back cannot go negative.
      await this.suitModel
        .updateOne({ _id: link.erpId }, { $inc: { quantity } }, { session })
        .exec();
    }

    const result = await this.productModel
      .updateOne(
        { _id: this.toObjectId(productId), deletedAt: null },
        { $inc: { stock: quantity, sellCount: -quantity } },
        { session },
      )
      .exec();

    if (result.matchedCount === 0) throw new ResourceNotFoundException('Product', productId);

    // sellCount floors at zero: a return must not drive the popularity counter
    // negative if history is incomplete.
    await this.productModel
      .updateOne(
        { _id: this.toObjectId(productId), sellCount: { $lt: 0 } },
        { $set: { sellCount: 0 } },
        { session },
      )
      .exec();

    if (!session) await this.invalidateCache([productId]);
  }

  /** Units coming back from a cancelled or refunded order. */
  async restoreMany(lines: StockLine[], session?: ClientSession): Promise<void> {
    for (const line of lines) {
      await this.restore(line.productId, line.quantity, session);
    }
  }

  /** Current on-hand quantities, for a stock check before a slow checkout step. */
  async levelsFor(productIds: string[]): Promise<Map<string, number>> {
    const products = await this.productModel
      .find({ _id: { $in: productIds.map((id) => this.toObjectId(id)) }, deletedAt: null })
      .select('_id stock')
      .lean()
      .exec();

    return new Map(products.map((p) => [p._id.toString(), p.stock]));
  }

  private assertPositive(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationFailedException('Quantity must be a positive integer');
    }
  }

  private toObjectId(id: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) throw new ResourceNotFoundException('Product', id);
    return new Types.ObjectId(id);
  }

  /** Distinguish "no such product" from "not enough stock" after a failed update. */
  /**
   * Which collection owns this product's stock.
   *
   * A product built on an ERP suit defers to `suits.quantity`; one that is not
   * keeps its own count. Reading the link rather than assuming it lets the
   * catalogue be attached to the ERP a product at a time.
   */
  private async stockOwner(
    productId: string,
    session?: ClientSession,
  ): Promise<{ erpId: Types.ObjectId | null }> {
    const product = await this.productModel
      .findOne({ _id: this.toObjectId(productId), deletedAt: null })
      .select('erpId')
      .session(session ?? null)
      .lean()
      .exec();

    if (!product) throw new ResourceNotFoundException('Product', productId);

    if (!product.erpId) return { erpId: null };

    if (!Types.ObjectId.isValid(product.erpId)) {
      // A link that cannot resolve is worse than no link: it would silently fall
      // back to the mirror and start selling from a number nobody maintains.
      throw new ValidationFailedException(
        'Product is linked to an ERP record whose id is not valid',
        { productId, erpId: product.erpId },
      );
    }

    return { erpId: new Types.ObjectId(product.erpId) };
  }

  /** Say why an ERP-backed decrement did not apply. */
  private async explainSuitFailure(
    productId: string,
    erpId: Types.ObjectId,
    quantity: number,
    session?: ClientSession,
  ): Promise<never> {
    const suit = await this.suitModel
      .findById(erpId)
      .select('quantity')
      .session(session ?? null)
      .lean()
      .exec();

    if (!suit) {
      // The product points at a suit that is gone. Refusing the sale is the only
      // safe answer — there is no stock figure to trust.
      throw new ResourceNotFoundException('ERP record for product', productId);
    }

    throw new InsufficientStockException(productId, quantity, suit.quantity ?? 0);
  }

  private async explainFailure(
    productId: string,
    quantity: number,
    session?: ClientSession,
  ): Promise<never> {
    const product = await this.productModel
      .findOne({ _id: this.toObjectId(productId), deletedAt: null })
      .select('_id stock')
      .session(session ?? null)
      .lean()
      .exec();

    if (!product) throw new ResourceNotFoundException('Product', productId);

    this.logger.warn(
      `Rejected stock decrease for ${productId}: wanted ${quantity}, had ${product.stock}`,
    );
    throw new InsufficientStockException(productId, quantity, product.stock);
  }
}
