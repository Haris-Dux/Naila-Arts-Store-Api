import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { ValidationFailedException } from '../../common/exceptions/domain.exception';
import { Money, sumMoney } from '../../common/money';
import { ProductSizing } from '../products/enums/product-sizing.enum';
import { ProductsService } from '../products/products.service';
import { SizesService } from '../sizes/sizes.service';
import { InventoryService, StockLine } from '../inventory/inventory.service';
import { OutboxService } from '../outbox/outbox.service';
import { RequestOwner } from '../../common/request-owner';
import { UsersService } from '../users/users.service';
import { CheckoutDto, CheckoutItemDto, MAX_LINE_QUANTITY } from './dto/checkout.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { OrderStatus } from './enums/order-status.enum';
import { Order, OrderDocument, OrderItem, OrderItemSize } from './schemas/order.schema';

/** One basket line after duplicate folding, keyed by product *and* size. */
interface CheckoutLine {
  productId: string;
  sizeId: string | null;
  quantity: number;
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);
  private readonly currency: string;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly productsService: ProductsService,
    private readonly sizesService: SizesService,
    private readonly inventoryService: InventoryService,
    private readonly outboxService: OutboxService,
    private readonly usersService: UsersService,
    config: ConfigService,
  ) {
    this.currency = config.getOrThrow<string>('store.currency');
  }

  /**
   * Place an order.
   *
   * The entire operation is one MongoDB transaction:
   *
   *   1. reprice every submitted line from the catalogue
   *   2. decrement stock atomically
   *   3. write the order
   *   4. record an outbox message
   *
   * All of it commits, or none of it does. The old flow had no transaction and
   * spanned two databases: an order could be written while the stock decrement
   * failed, or stock could be consumed for an order that was never created, and
   * nothing reconciled the two afterwards.
   *
   * `withTransaction` also retries automatically on a transient write conflict,
   * which is what two customers checking out the same product produce.
   */
  async checkout(owner: RequestOwner, dto: CheckoutDto): Promise<OrderResponseDto> {
    const contact = await this.resolveContact(owner, dto);
    const session = await this.connection.startSession();

    try {
      let placed: OrderDocument | undefined;

      await session.withTransaction(async () => {
        placed = await this.placeOrder(owner, contact, dto, session);
      });

      // withTransaction only returns after a successful commit.
      const order = placed!;

      // Retire the cached product views now that the sale is durable. Done here
      // rather than inside the transaction: invalidating before the commit lets
      // a concurrent read repopulate the cache from the pre-commit state.
      await this.inventoryService.invalidateCache(
        order.items.map((item) => item.productId.toString()),
      );

      this.logger.log(
        `Order ${order.orderNumber} placed by ${owner.userId ?? 'guest'}: ` +
          `${order.items.length} line(s), ` +
          `${Money.fromMinor(order.grandTotal, order.currency).format()}`,
      );
      return OrderResponseDto.from(order);
    } finally {
      await session.endSession();
    }
  }

  /**
   * Work out who to bill and where to write.
   *
   * A signed-in customer's details come from their account — never from the
   * request — so the same rule that keeps prices and `userId` server-side also
   * covers the contact address. A guest must supply both, because there is no
   * account to read them from and an order nobody can be told about is useless.
   */
  private async resolveContact(
    owner: RequestOwner,
    dto: CheckoutDto,
  ): Promise<{ email: string; name: string }> {
    if (owner.userId) {
      const user = await this.usersService.findActiveById(owner.userId);
      if (!user) throw new ValidationFailedException('Your account is no longer active');
      return { email: user.email, name: user.name };
    }

    if (!owner.guestToken) {
      // The controller mints a token for a caller who has neither, so this is
      // unreachable through the API — kept because the service is a public
      // entry point and an order with no owner is unrecoverable.
      throw new ValidationFailedException('Could not identify the shopper placing this order');
    }

    if (!dto.email || !dto.name) {
      throw new ValidationFailedException(
        'An email address and a name are required to check out as a guest',
        { missing: [!dto.email && 'email', !dto.name && 'name'].filter(Boolean) },
      );
    }

    return { email: dto.email, name: dto.name };
  }

  private async placeOrder(
    owner: RequestOwner,
    contact: { email: string; name: string },
    dto: CheckoutDto,
    session: ClientSession,
  ): Promise<OrderDocument> {
    const lines = CheckoutService.mergeLines(dto.items);

    // Reprice from the catalogue, inside the transaction. This is the step the
    // old implementation skipped: it fetched the products and then used them
    // only for a `length` check, charging whatever the client had sent. It
    // matters more now that the basket is client-side: the catalogue is the only
    // thing standing between a shopper and a price of their choosing.
    const products = await this.productsService.findManyByIds(
      [...new Set([...lines.values()].map((line) => line.productId))],
      session,
    );

    const items: OrderItem[] = [];
    const stockLines: StockLine[] = [];

    for (const { productId, sizeId, quantity } of lines.values()) {
      const product = products.get(productId);

      if (!product || !product.isActive) {
        throw new ValidationFailedException(
          `"${product?.name ?? 'One of the items in your order'}" is no longer available`,
          { productId },
        );
      }

      const size = await this.resolveSize(product, sizeId);

      // The *effective* price: a promotion running now is what the customer is
      // charged, and the order records that rather than the list price.
      const unitPrice = Money.fromMinor(product.effectivePrice, this.currency);
      items.push({
        productId: product._id,
        // Snapshot: the order must still read correctly after the catalogue moves on.
        name: product.name,
        sku: product.sku,
        size,
        unitPrice: unitPrice.amount,
        quantity,
        lineTotal: unitPrice.times(quantity).amount,
      });

      stockLines.push({ productId, quantity });
    }

    // Atomic, guarded, and inside the transaction — a shortfall on any line
    // aborts the whole order rather than leaving stock partly consumed.
    await this.inventoryService.decreaseMany(stockLines, session);

    const subtotal = sumMoney(
      items.map((item) => Money.fromMinor(item.lineTotal, this.currency)),
      this.currency,
    );

    // Shipping, tax and discounts are zero until their own phases land; the
    // fields exist so the totals do not have to be restructured later.
    const shippingTotal = Money.zero(this.currency);
    const taxTotal = Money.zero(this.currency);
    const discountTotal = Money.zero(this.currency);
    const grandTotal = subtotal.plus(shippingTotal).plus(taxTotal).minus(discountTotal);

    const [order] = await this.orderModel.create(
      [
        {
          orderNumber: CheckoutService.generateOrderNumber(),
          // From the token or the signed cookie. Never from the request body.
          userId: owner.userId ? new Types.ObjectId(owner.userId) : null,
          guestToken: owner.userId ? null : owner.guestToken,
          contactEmail: contact.email,
          contactName: contact.name,
          status: OrderStatus.PENDING,
          items,
          subtotal: subtotal.amount,
          shippingTotal: shippingTotal.amount,
          taxTotal: taxTotal.amount,
          discountTotal: discountTotal.amount,
          grandTotal: grandTotal.amount,
          currency: this.currency,
          shippingAddress: dto.shippingAddress,
          billingAddress: dto.billingAddress ?? dto.shippingAddress,
          customerNote: dto.customerNote ?? null,
          statusHistory: [
            { status: OrderStatus.PENDING, at: new Date(), by: null, note: 'Placed' },
          ],
          placedAt: new Date(),
        },
      ],
      { session },
    );

    // Written in the same transaction as the order, so the announcement cannot
    // be lost if the process dies immediately after the commit.
    await this.outboxService.record(
      {
        aggregateType: 'order',
        aggregateId: order._id,
        eventType: 'order.placed',
        payload: {
          orderId: order._id.toString(),
          orderNumber: order.orderNumber,
          userId: owner.userId,
          email: order.contactEmail,
          currency: order.currency,
          grandTotal: order.grandTotal,
          items: order.items.map((item) => ({
            productId: item.productId.toString(),
            name: item.name,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            lineTotal: item.lineTotal,
          })),
        },
      },
      session,
    );

    return order;
  }

  /**
   * Collapse repeated products into one line each.
   *
   * A browser-held basket can send the same product twice — two tabs, or a UI
   * that appends rather than increments. An order with the same product on two
   * lines reads as a bug to whoever opens it, so they are folded here.
   * A `Map` also preserves first-seen order, which is the order the shopper
   * built the basket in.
   */
  private static mergeLines(items: CheckoutItemDto[]): Map<string, CheckoutLine> {
    const merged = new Map<string, CheckoutLine>();

    for (const item of items) {
      // Keyed by product *and* size: the same shirt in M and in L is two lines a
      // picker has to see separately, not a duplicate to fold.
      const key = `${item.productId}:${item.sizeId ?? ''}`;
      const existing = merged.get(key);
      const total = (existing?.quantity ?? 0) + item.quantity;

      // The per-line cap has to hold for the combined quantity too, or splitting
      // a line in two would be a way around it.
      if (total > MAX_LINE_QUANTITY) {
        throw new ValidationFailedException(
          `You cannot order more than ${MAX_LINE_QUANTITY} of the same product`,
          { productId: item.productId, quantity: total },
        );
      }

      merged.set(key, { productId: item.productId, sizeId: item.sizeId ?? null, quantity: total });
    }

    return merged;
  }

  /**
   * Resolve the size a line was ordered in, and refuse a mismatch.
   *
   * A sized product without a size cannot be picked; an unstitched one with a
   * size describes a choice the storefront never offered. Both are rejected
   * rather than normalised, because either means the client and the catalogue
   * disagree about what is being sold.
   */
  private async resolveSize(
    product: { _id: Types.ObjectId; name: string; sizing: ProductSizing; sizes: Types.ObjectId[] },
    sizeId: string | null,
  ): Promise<OrderItemSize | null> {
    if (product.sizing === ProductSizing.UNSTITCHED) {
      if (sizeId) {
        throw new ValidationFailedException(`"${product.name}" is unstitched and has no sizes`, {
          productId: product._id.toString(),
        });
      }
      return null;
    }

    if (!sizeId) {
      throw new ValidationFailedException(`Choose a size for "${product.name}"`, {
        productId: product._id.toString(),
      });
    }

    if (!product.sizes.some((offered) => offered.toString() === sizeId)) {
      throw new ValidationFailedException(`"${product.name}" is not available in that size`, {
        productId: product._id.toString(),
        sizeId,
      });
    }

    const size = await this.sizesService.resolveOne(sizeId);
    return { sizeId: size.id, name: size.name, code: size.code };
  }

  /**
   * Human-readable reference: date plus random suffix.
   *
   * Not sequential on purpose — a guessable order number lets anyone probe how
   * many orders the store takes, and invites enumeration.
   */
  private static generateOrderNumber(): string {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = randomBytes(4).toString('hex').toUpperCase();
    return `ORD-${date}-${suffix}`;
  }
}
