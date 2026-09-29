import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, FilterQuery, Model, Types } from 'mongoose';
import { Page } from '../../common/dto/pagination.dto';
import {
  AuthorizationException,
  InvalidStateTransitionException,
  ResourceNotFoundException,
} from '../../common/exceptions/domain.exception';
import { notDeleted } from '../../common/schemas/base.schema';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ownsRecord } from '../../common/ownership';
import { InventoryService } from '../inventory/inventory.service';
import { OutboxService } from '../outbox/outbox.service';
import { UserRole, roleAtLeast } from '../users/enums/user-role.enum';
import { ListOrdersDto } from './dto/list-orders.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import {
  CUSTOMER_CANCELLABLE_STATUSES,
  OrderStatus,
  canTransition,
  isTerminal,
} from './enums/order-status.enum';
import { Order, OrderDocument } from './schemas/order.schema';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly inventoryService: InventoryService,
    private readonly outboxService: OutboxService,
  ) {}

  // ------------------------------------------------------------------ reads

  /**
   * List orders.
   *
   * A customer sees only their own — the filter is built from the token, so the
   * `userId` query parameter cannot widen it. Staff may filter by customer.
   *
   * There is no listing for guests: a guest order belongs to no account, and the
   * order number is the only handle on it. `OrderTrackingService` looks one up
   * at a time, which is all a receipt or a parcel label can identify.
   */
  async list(query: ListOrdersDto, actor: AuthenticatedUser): Promise<Page<OrderResponseDto>> {
    const staff = roleAtLeast(actor.role, UserRole.ADMIN);

    const filter: FilterQuery<OrderDocument> = { ...notDeleted };
    if (staff) {
      if (query.userId) filter.userId = new Types.ObjectId(query.userId);
    } else {
      filter.userId = new Types.ObjectId(actor.id);
    }
    if (query.status) filter.status = query.status;

    const [documents, total] = await Promise.all([
      this.orderModel
        .find(filter)
        .sort({ [query.sort]: query.order === 'asc' ? 1 : -1 })
        .skip(query.skip)
        .limit(query.limit)
        .exec(),
      this.orderModel.countDocuments(filter).exec(),
    ]);

    return Page.of(documents.map(OrderResponseDto.from), total, query.page, query.limit);
  }

  async findById(id: string, actor: AuthenticatedUser): Promise<OrderResponseDto> {
    const order = await this.getDocumentOrThrow(id);
    this.assertMayView(order, actor);
    return OrderResponseDto.from(order);
  }

  // --------------------------------------------------------- state changes

  /**
   * Move an order to a new status. Staff only, and only along a declared edge.
   *
   * The old endpoint was reachable without any authentication at all — its guard
   * had no branch for PATCH and fell through to `return true` — and accepted any
   * status from any other.
   */
  async updateStatus(
    id: string,
    next: OrderStatus,
    // Null for a system transition — a payment capture or a provider webhook,
    // which act on the order without a person behind them.
    actor: AuthenticatedUser | null,
    note?: string,
  ): Promise<OrderResponseDto> {
    const session = await this.connection.startSession();

    try {
      let updated: OrderDocument | undefined;
      // Collected inside the transaction, used after it commits.
      let restockedProductIds: string[] = [];

      await session.withTransaction(async () => {
        // Reset per attempt: withTransaction retries on a transient conflict,
        // and a stale list from an aborted attempt would be wrong.
        restockedProductIds = [];
        const order = await this.orderModel
          .findOne({ _id: id, ...notDeleted })
          .session(session)
          .exec();
        if (!order) throw new ResourceNotFoundException('Order', id);

        if (order.status === next) {
          updated = order;
          return;
        }

        if (!canTransition(order.status, next)) {
          throw new InvalidStateTransitionException('Order', order.status, next);
        }

        /**
         * Reaching an ending returns the units, and that commits with the
         * status change or a cancellation could consume stock permanently.
         *
         * Terminality alone is the whole rule. There are exactly two endings
         * and the machine keeps them on opposite sides of dispatch: CANCELLED
         * is unreachable once the parcel has left, RETURNED unreachable before
         * it has. So either ending means the units are back with us.
         */
        if (isTerminal(next)) {
          restockedProductIds = await this.restoreStock(order, session);
        }

        this.applyStatus(order, next, actor ? new Types.ObjectId(actor.id) : null, note ?? null);
        await order.save({ session });

        await this.outboxService.record(
          {
            aggregateType: 'order',
            aggregateId: order._id,
            eventType: `order.${next.toLowerCase()}`,
            payload: {
              orderId: order._id.toString(),
              orderNumber: order.orderNumber,
              userId: order.userId ? order.userId.toString() : null,
              status: next,
              previousStatus: order.statusHistory.at(-2)?.status ?? null,
            },
          },
          session,
        );

        updated = order;
      });

      const order = updated!;

      // A cancellation or return put stock back; the cached catalogue view still
      // shows the pre-restock figure until it is retired. After the commit, for
      // the same reason as in CheckoutService.
      if (restockedProductIds.length > 0) {
        await this.inventoryService.invalidateCache(restockedProductIds);
      }

      this.logger.log(`Order ${order.orderNumber} → ${order.status} by ${actor?.id ?? 'system'}`);
      return OrderResponseDto.from(order);
    } finally {
      await session.endSession();
    }
  }

  /**
   * Cancel an order.
   *
   * A customer may cancel their own before it ships; staff may cancel at any
   * point the state machine allows. Either way the stock goes back on the shelf
   * in the same transaction.
   *
   * A guest order has no owner to authenticate, so only staff can cancel one —
   * which is why the route requires a token rather than accepting an order
   * number. Cancelling on nothing but a number would let anyone who saw a parcel
   * label empty somebody else's order.
   */
  async cancel(id: string, actor: AuthenticatedUser, reason?: string): Promise<OrderResponseDto> {
    const order = await this.getDocumentOrThrow(id);
    this.assertMayView(order, actor);

    // A terminal order is a state conflict, not a permissions problem — telling
    // someone they "may not cancel" an order they already cancelled is both
    // wrong and confusing. Fall through to the state machine, which reports 409.
    if (
      !isTerminal(order.status) &&
      !roleAtLeast(actor.role, UserRole.ADMIN) &&
      !CUSTOMER_CANCELLABLE_STATUSES.includes(order.status)
    ) {
      throw new AuthorizationException(
        `An order that is ${order.status} can no longer be cancelled; please contact support`,
      );
    }

    return this.updateStatus(id, OrderStatus.CANCELLED, actor, reason ?? 'Cancelled');
  }

  // -------------------------------------------------------------- internals

  private async getDocumentOrThrow(id: string): Promise<OrderDocument> {
    if (!Types.ObjectId.isValid(id)) throw new ResourceNotFoundException('Order', id);
    const order = await this.orderModel.findOne({ _id: id, ...notDeleted }).exec();
    if (!order) throw new ResourceNotFoundException('Order', id);
    return order;
  }

  /**
   * Customers see their own orders; staff see all.
   *
   * 404 rather than 403 for somebody else's order, so order ids cannot be probed
   * for existence.
   */
  private assertMayView(order: OrderDocument, actor: AuthenticatedUser): void {
    if (roleAtLeast(actor.role, UserRole.ADMIN)) return;
    if (ownsRecord(actor.id, order)) return;
    throw new ResourceNotFoundException('Order', order._id.toString());
  }

  /**
   * Put the order's units back, and report which products moved so the caller
   * can retire their cached figures after the commit.
   *
   * Tolerant of a line whose product or colour no longer exists, and that is
   * the whole point. `InventoryService` resolves stock through the product
   * document and throws when it has been soft-deleted, or the colour removed —
   * so a single retired product used to make its orders impossible to close:
   * cancelling 404'd, and a returned parcel left the order stranded
   * mid-transition with the shipment already saved. An order must always be
   * able to reach an ending. The units that still have somewhere to go are
   * restored; the rest are logged loudly enough for someone to reconcile by hand.
   */
  private async restoreStock(order: OrderDocument, session: ClientSession): Promise<string[]> {
    // The flag is the guard against restocking twice — a second cancellation, or
    // a retry of a transaction that already committed the restock.
    if (order.stockReleased) return [];

    const restored: string[] = [];
    const skipped: string[] = [];

    for (const item of order.items) {
      const productId = item.productId.toString();
      try {
        await this.inventoryService.restore(
          productId,
          item.variantId.toString(),
          item.quantity,
          session,
        );
        restored.push(productId);
      } catch (error) {
        // Only a product that can no longer be resolved is survivable. Anything
        // else — a write conflict, a lost connection — must still abort the
        // transaction, or the order would close claiming a restock that never
        // happened.
        if (!(error instanceof ResourceNotFoundException)) throw error;
        skipped.push(`${productId} (${item.color})`);
      }
    }

    if (skipped.length > 0) {
      this.logger.warn(
        `Order ${order.orderNumber} closed without restocking ${skipped.length} line(s): ` +
          `product colour(s) ${skipped.join(', ')} no longer exist. Adjust stock by hand if ` +
          `those units came back.`,
      );
    }

    // The latch is set even when some lines were skipped: those units have no
    // home to go back to, and leaving it false would let a later transition
    // restock the surviving lines a second time.
    order.stockReleased = true;
    return restored;
  }

  private applyStatus(
    order: OrderDocument,
    next: OrderStatus,
    by: Types.ObjectId | null,
    note: string | null,
  ): void {
    order.status = next;
    order.statusHistory.push({ status: next, at: new Date(), by, note });

    if (next === OrderStatus.PAID) order.paidAt = new Date();
    if (next === OrderStatus.CANCELLED) order.cancelledAt = new Date();
    if (next === OrderStatus.RETURNED) order.returnedAt = new Date();
  }
}
