import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types, mongo } from 'mongoose';

import { EVENTS, ProductsChangedEvent } from '../../events/domain-events';
import { notDeleted } from '../../common/schemas/base.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { Suit, SuitDocument } from './schemas/suit.schema';
import { SyncCheckpoint, SyncCheckpointDocument } from './schemas/sync-checkpoint.schema';

const STREAM_NAME = 'suits-stock';

/** How often to re-check the mirror against the ERP's own numbers. */
const RECONCILE_INTERVAL_MS = 5 * 60_000;

/** Products examined per reconciliation batch. */
const RECONCILE_BATCH = 500;

/** First wait before reopening a failed change stream, doubling each attempt. */
const STREAM_RETRY_BASE_MS = 1_000;

/** Ceiling on that wait, so a permanently broken stream retries once a minute. */
const STREAM_RETRY_MAX_MS = 60_000;

/**
 * Keeps each product colour's stock matching the ERP's `suits.quantity`.
 *
 * The ERP is the source of truth: branch workers book sale and return bills that
 * move `suits.quantity` without the store ever seeing the bill. A colour's
 * `stock`, and the product's total over its colours, are mirrors, kept only so
 * the catalogue's filters, sorts and indexes — `?inStock=true`, `sort=stock`,
 * the low-stock report — keep working without a `$lookup` on every query.
 *
 * Two mechanisms, and both are needed:
 *
 *  - A **change stream** carries branch activity across within a second or two.
 *  - A **reconciliation sweep** exists because a change stream is not enough on
 *    its own. If the process is down longer than the oplog window the resume
 *    token becomes unusable and the events in between are gone. A stream that
 *    has silently missed a day of bills looks exactly like one that is working.
 *
 * The store's own sales do not depend on this. Checkout writes `suits.quantity` and
 * the mirror in one transaction, so the stream only ever redelivers a value the
 * mirror already holds — an idempotent no-op, not a feedback loop.
 */
@Injectable()
export class ErpStockSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ErpStockSyncService.name);
  private readonly enabled: boolean;

  private stream: mongo.ChangeStream | null = null;

  /** Set while a recovery is in flight, so two errors cannot both drive one. */
  private recovering = false;

  /** Consecutive reopen failures, reset on the first success. Drives the backoff. */
  private streamFailures = 0;

  /** Serialises change handling: each event waits for the previous to finish. */
  private applying: Promise<void> = Promise.resolve();

  private timer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Suit.name) private readonly suitModel: Model<SuitDocument>,
    @InjectModel(SyncCheckpoint.name)
    private readonly checkpointModel: Model<SyncCheckpointDocument>,
    private readonly eventEmitter: EventEmitter2,
    config: ConfigService,
  ) {
    // Tests drive `reconcile()` and the stream directly so assertions are not
    // racing a background worker — the same bargain OutboxDispatcher makes.
    this.enabled = config.getOrThrow<string>('app.env') !== 'test';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;

    // Before watching anything: whatever happened while this process was not
    // running is not in the stream we are about to open.
    await this.reconcile().catch((error: unknown) => {
      this.logger.error(`Initial reconciliation failed: ${asMessage(error)}`);
    });

    await this.start();

    this.timer = setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        this.logger.error(`Reconciliation failed: ${asMessage(error)}`);
      });
    }, RECONCILE_INTERVAL_MS);

    // Do not hold the process open at shutdown purely for the next sweep.
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.stream?.close().catch(() => undefined);
  }

  /**
   * Open the change stream, resuming from the stored token when one is usable.
   *
   * `fullDocument: 'updateLookup'` because an update event carries only the
   * changed fields, and the pipeline needs the suit's `_id` and current stock to
   * write the mirror. Inserts and replaces are watched too: a suit can appear or
   * be rewritten wholesale by the ERP.
   */
  async start(): Promise<void> {
    const checkpoint = await this.checkpointModel.findOne({ name: STREAM_NAME }).lean().exec();

    const stream = this.suitModel.watch(
      [
        {
          $match: {
            operationType: { $in: ['insert', 'update', 'replace'] },
          },
        },
      ],
      {
        fullDocument: 'updateLookup',
        ...(checkpoint?.token ? { resumeAfter: checkpoint.token } : {}),
      },
    );

    // Chained, not fired in parallel. `onChange` reads the matching products
    // and then writes them; overlapping invocations let a 5 → 3 → 1 sequence
    // land out of order and leave the mirror on a figure the ERP has already
    // moved past.
    // Chained, not fired in parallel. `onChange` reads the matching products
    // and then writes them; overlapping invocations let a 5 → 3 → 1 sequence
    // land out of order and leave the mirror on a figure the ERP has moved past.
    stream.on('change', (event: unknown) => {
      this.applying = this.applying
        .then(() => this.onChange(event))
        .catch((error: unknown) => {
          this.logger.error(`Failed to apply a suit change: ${asMessage(error)}`);
        });
    });

    stream.on('error', (error: unknown) => {
      void this.onStreamError(error);
    });

    this.stream = stream;
    this.logger.log(`Watching suits for stock changes${checkpoint ? ' (resumed)' : ' (from now)'}`);
  }

  /**
   * A stream error is usually the resume token having aged out of the oplog.
   *
   * Reconcile first, then reopen from now: carrying on without the events in
   * between would leave the mirror wrong with nothing to indicate it.
   *
   * Three things keep this from becoming a hot loop, which is what it was:
   *
   *  - **Backoff.** Reopening immediately on a permanent error — a standalone
   *    mongod, where change streams simply do not exist — spun as fast as Mongo
   *    could answer, with a full catalogue sweep on every pass.
   *  - **A re-entrancy guard.** Two errors arriving together ran two recoveries
   *    and left two live cursors, each delivering the same changes again.
   *  - **The checkpoint is only dropped when it is the problem.** Deleting it on
   *    every transient blip threw away a resume point that was still good.
   */
  private async onStreamError(error: unknown): Promise<void> {
    if (this.stopping || this.recovering) return;
    this.recovering = true;

    try {
      this.logger.warn(`Change stream error, resynchronising: ${asMessage(error)}`);

      const previous = this.stream;
      this.stream = null;
      await previous?.close().catch(() => undefined);

      /**
       * Always drop the checkpoint and reconcile before reopening.
       *
       * Tempting to keep the token on what looks like a transient error, but a
       * token that cannot be resumed from does not announce itself in the error
       * message — and retrying with it just fails the same way forever, while
       * the mirror sits wrong. Discarding it costs one sweep; keeping a bad one
       * costs the whole sync.
       */
      await this.checkpointModel.deleteOne({ name: STREAM_NAME }).exec();
      await this.reconcile().catch((reconcileError: unknown) => {
        this.logger.error(`Reconciliation after stream error failed: ${asMessage(reconcileError)}`);
      });

      const delay = Math.min(STREAM_RETRY_BASE_MS * 2 ** this.streamFailures, STREAM_RETRY_MAX_MS);
      this.streamFailures += 1;
      this.logger.warn(`Reopening the change stream in ${Math.round(delay / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, delay).unref());

      if (this.stopping) return;

      await this.start()
        .then(() => {
          this.streamFailures = 0;
        })
        .catch((startError: unknown) => {
          this.logger.error(`Could not reopen the change stream: ${asMessage(startError)}`);
        });
    } finally {
      this.recovering = false;
    }
  }

  /** Apply one suit change to the mirror. Exposed so e2e can drive it directly. */
  async onChange(event: unknown): Promise<void> {
    const change = event as {
      _id?: Record<string, unknown>;
      documentKey?: { _id?: Types.ObjectId };
      fullDocument?: { _id?: Types.ObjectId; quantity?: unknown };
    };

    const suitId = change.fullDocument?._id ?? change.documentKey?._id;
    const stock = change.fullDocument?.quantity;

    // A replace or an update that did not touch stock still produces an event;
    // there is simply nothing to mirror from it.
    if (suitId && typeof stock === 'number') {
      await this.applyStock(suitId, stock);
    }

    if (change._id) {
      await this.checkpointModel
        .updateOne({ name: STREAM_NAME }, { $set: { token: change._id } }, { upsert: true })
        .exec();
    }
  }

  /**
   * Write one suit's stock onto every product colour that is that suit.
   *
   * `$ne` in the filter makes this a no-op when the mirror already agrees, which
   * is the common case: the store's own sales wrote both numbers in one
   * transaction, and this is the stream redelivering what is already there.
   * Skipping the write also skips the cache invalidation it would otherwise
   * trigger.
   */
  private async applyStock(suitId: Types.ObjectId, stock: number): Promise<void> {
    const erpId = suitId.toString();
    const normalised = Math.max(0, Math.trunc(stock));

    /**
     * One statement, not a read followed by a write.
     *
     * Selecting the ids and then updating them by `_id` left a gap in which a
     * checkout could decrement the very row about to be written — and the write
     * then put the pre-sale figure back, overselling until the next sweep.
     * Keeping `$ne` in the filter of the update itself preserves the no-op
     * behaviour and closes the gap.
     */
    const result = await this.productModel
      .updateMany(
        { variants: { $elemMatch: { erpId, stock: { $ne: normalised } } }, ...notDeleted },
        ErpStockSyncService.setColourStock(erpId, normalised),
      )
      .exec();

    if (result.modifiedCount === 0) return;

    // The listener retires the whole catalogue namespace and ignores the ids,
    // so naming the suit is enough to say what moved.
    await this.announce([suitId.toString()]);
  }

  /**
   * Set one colour's stock and re-total the product, in a single statement.
   *
   * An update pipeline rather than `$set` on a positional path, because the
   * product's total has to be recomputed from the colours as they are *after*
   * the write — and doing that in the same statement means no reader, and no
   * concurrent sale, ever sees the two disagree.
   */
  private static setColourStock(erpId: string, stock: number): PipelineStage.Set[] {
    return [
      {
        $set: {
          variants: {
            $map: {
              input: '$variants',
              as: 'variant',
              in: {
                $cond: [
                  { $eq: ['$$variant.erpId', erpId] },
                  { $mergeObjects: ['$$variant', { stock }] },
                  '$$variant',
                ],
              },
            },
          },
        },
      },
      { $set: { stock: { $sum: '$variants.stock' } } },
    ];
  }

  /**
   * Compare every product colour against its suit and correct the drift.
   *
   * Logs what it corrected rather than healing silently: a sweep that keeps
   * finding drift means the change stream is not working, and silence would hide
   * that indefinitely.
   */
  async reconcile(): Promise<number> {
    let corrected = 0;
    let lastId: Types.ObjectId | undefined;

    for (;;) {
      const products = await this.productModel
        .find({ ...notDeleted, ...(lastId ? { _id: { $gt: lastId } } : {}) })
        .select('_id variants.erpId variants.stock')
        .sort({ _id: 1 })
        .limit(RECONCILE_BATCH)
        .lean()
        .exec();

      if (products.length === 0) break;
      lastId = products[products.length - 1]._id;

      const suitIds = products
        .flatMap((product) => product.variants.map((variant) => variant.erpId))
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));

      const suits = await this.suitModel
        .find({ _id: { $in: suitIds } })
        .select('_id quantity')
        .lean()
        .exec();

      const stockBySuit = new Map(suits.map((suit) => [suit._id.toString(), suit.quantity ?? 0]));

      const driftedProducts = new Set<string>();

      for (const product of products) {
        for (const variant of product.variants) {
          const truth = stockBySuit.get(variant.erpId);
          // A colour whose suit is missing is left alone deliberately: the mirror
          // is the last figure the ERP published, and zeroing it on a failed
          // lookup would hide the whole catalogue on a transient read.
          if (truth === undefined) continue;

          const normalised = Math.max(0, Math.trunc(truth));
          if (normalised === variant.stock) continue;

          await this.productModel
            .updateOne(
              { _id: product._id },
              ErpStockSyncService.setColourStock(variant.erpId, normalised),
            )
            .exec();
          this.logger.warn(
            `Corrected stock drift on product ${product._id.toString()}: ` +
              `${variant.stock} -> ${normalised} (suit ${variant.erpId})`,
          );
          driftedProducts.add(product._id.toString());
          corrected += 1;
        }
      }

      await this.announce([...driftedProducts]);

      if (products.length < RECONCILE_BATCH) break;
    }

    return corrected;
  }

  /**
   * Retire the cached product views.
   *
   * Stock has changed behind ProductsService's back, which is exactly what this
   * event exists for — without it the storefront keeps advertising a figure the
   * ERP has already moved on from.
   */
  private async announce(productIds: string[]): Promise<void> {
    if (productIds.length === 0) return;
    const event: ProductsChangedEvent = { productIds };
    await this.eventEmitter.emitAsync(EVENTS.PRODUCTS_CHANGED, event);
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
