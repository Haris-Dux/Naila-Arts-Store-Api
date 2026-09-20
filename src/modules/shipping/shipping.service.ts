import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, FilterQuery, Model, Types } from 'mongoose';
import { Page } from '../../common/dto/pagination.dto';
import {
  InvalidStateTransitionException,
  ResourceNotFoundException,
} from '../../common/exceptions/domain.exception';
import { notDeleted } from '../../common/schemas/base.schema';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { ownsRecord } from '../../common/ownership';
import { OrderStatus, isTerminal } from '../orders/enums/order-status.enum';
import { OrdersService } from '../orders/orders.service';
import { OutboxService } from '../outbox/outbox.service';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { UserRole, roleAtLeast } from '../users/enums/user-role.enum';
import { DispatchShipmentDto, ListShipmentsDto, ShipmentResponseDto } from './dto/shipment.dto';
import { ShipmentStatus, canTransitionShipment } from './enums/shipment-status.enum';
import { Shipment, ShipmentDocument } from './schemas/shipment.schema';

/**
 * Shipment status → the order status it implies.
 *
 * Kept in one table so the two state machines cannot drift apart: dispatching a
 * shipment is what makes an order SHIPPED, and nothing else does.
 */
const ORDER_STATUS_FOR_SHIPMENT: Readonly<Partial<Record<ShipmentStatus, OrderStatus>>> = {
  [ShipmentStatus.PREPARING]: OrderStatus.FULFILLING,
  [ShipmentStatus.IN_TRANSIT]: OrderStatus.SHIPPED,
  [ShipmentStatus.DELIVERED]: OrderStatus.DELIVERED,
  // The parcel came back, so the order did too — which is what returns its
  // units to the shelf. Legal from SHIPPED as well as DELIVERED, because a
  // cash-on-delivery parcel refused at the door never reached the customer.
  [ShipmentStatus.RETURNED]: OrderStatus.RETURNED,
};

@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Shipment.name) private readonly shipmentModel: Model<ShipmentDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly ordersService: OrdersService,
    private readonly outboxService: OutboxService,
  ) {}

  /**
   * Create the shipment for a paid order, idempotently.
   *
   * One `findOneAndUpdate` with `upsert` and `$setOnInsert`: the first call
   * inserts, every subsequent call matches the existing document and changes
   * nothing. Combined with the unique index on `orderId`, a redelivered
   * `order.paid` cannot produce a second shipment — and outbox delivery is
   * at-least-once, so redelivery is expected rather than exceptional.
   *
   * The old handler managed to duplicate without any redelivery at all: it built
   * a document, called `create()` with identical data, then `save()`d the first
   * one — two inserts on every order.
   */
  async createForOrder(orderId: string): Promise<ShipmentDocument | null> {
    const order = await this.orderModel.findOne({ _id: orderId, ...notDeleted }).exec();
    if (!order) throw new ResourceNotFoundException('Order', orderId);

    // A late or retried `order.paid` can arrive after the order was cancelled.
    // Opening a shipment then would put a cancelled order back in the warehouse
    // queue, so nothing is created.
    if (isTerminal(order.status)) {
      this.logger.warn(`Not opening a shipment for ${order.orderNumber}: order is ${order.status}`);
      return null;
    }

    const now = new Date();
    const shipment = await this.shipmentModel
      .findOneAndUpdate(
        { orderId: order._id },
        {
          // Only applied on insert, so a replay never overwrites a shipment the
          // warehouse has already started working on.
          $setOnInsert: {
            orderId: order._id,
            orderNumber: order.orderNumber,
            userId: order.userId,
            status: ShipmentStatus.PENDING,
            shippingAddress: order.shippingAddress,
            items: order.items.map((item) => ({
              productId: item.productId,
              name: item.name,
              quantity: item.quantity,
            })),
            events: [
              {
                status: ShipmentStatus.PENDING,
                at: now,
                location: null,
                note: 'Awaiting fulfilment',
                by: null,
              },
            ],
            deletedAt: null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();

    this.logger.log(`Shipment ready for ${order.orderNumber} (${shipment.status})`);
    return shipment;
  }

  /**
   * Close the shipment of a cancelled order, idempotently.
   *
   * Only a shipment that has not left the building can be cancelled; one already
   * in transit is a return, which is a person's decision, not this handler's. A
   * missing shipment is normal — an order cancelled before payment never had one.
   */
  async cancelForOrder(orderId: string): Promise<void> {
    if (!Types.ObjectId.isValid(orderId)) return;

    const shipment = await this.shipmentModel
      .findOne({ orderId: new Types.ObjectId(orderId), ...notDeleted })
      .exec();
    if (!shipment) return;

    if (
      shipment.status !== ShipmentStatus.PENDING &&
      shipment.status !== ShipmentStatus.PREPARING
    ) {
      // RETURNED is an ordinary ending now that a returned parcel closes its
      // order, so it is no more remarkable here than CANCELLED.
      if (
        shipment.status !== ShipmentStatus.CANCELLED &&
        shipment.status !== ShipmentStatus.RETURNED
      ) {
        this.logger.warn(
          `Order ${shipment.orderNumber} was cancelled but its shipment is already ${shipment.status}`,
        );
      }
      return;
    }

    this.applyStatus(shipment, ShipmentStatus.CANCELLED, null, null, 'Order cancelled');
    await shipment.save();
    this.logger.log(`Shipment for ${shipment.orderNumber} cancelled with its order`);
  }

  /**
   * Record that the parcel came back, when the order was closed directly.
   *
   * The usual direction is the other way — the warehouse marks the shipment
   * RETURNED and `mirrorToOrder` closes the order. But staff can also move the
   * order straight to RETURNED from the order screen, which is the recovery
   * path when the parcel was never tracked properly. Without this the shipment
   * would sit at DELIVERED forever, disagreeing with its own order.
   *
   * Idempotent, and silent when the shipment cannot legally follow: a parcel
   * that never shipped has nothing to come back, which is not a problem worth
   * a warning.
   */
  async markReturnedForOrder(orderId: string): Promise<void> {
    if (!Types.ObjectId.isValid(orderId)) return;

    const shipment = await this.shipmentModel
      .findOne({ orderId: new Types.ObjectId(orderId), ...notDeleted })
      .exec();
    if (!shipment) return;

    if (shipment.status === ShipmentStatus.RETURNED) return;
    if (!canTransitionShipment(shipment.status, ShipmentStatus.RETURNED)) return;

    this.applyStatus(shipment, ShipmentStatus.RETURNED, null, null, 'Order marked returned');
    await shipment.save();
    this.logger.log(`Shipment for ${shipment.orderNumber} recorded as returned with its order`);
  }

  // ------------------------------------------------------------------- reads

  async list(
    query: ListShipmentsDto,
    actor: AuthenticatedUser,
  ): Promise<Page<ShipmentResponseDto>> {
    const staff = roleAtLeast(actor.role, UserRole.ADMIN);

    const filter: FilterQuery<ShipmentDocument> = { ...notDeleted };
    if (staff) {
      if (query.userId) filter.userId = new Types.ObjectId(query.userId);
    } else {
      // Built from the token, so the query parameter cannot widen it.
      filter.userId = new Types.ObjectId(actor.id);
    }
    if (query.status) filter.status = query.status;

    const [documents, total] = await Promise.all([
      this.shipmentModel
        .find(filter)
        .sort({ [query.sort]: query.order === 'asc' ? 1 : -1 })
        .skip(query.skip)
        .limit(query.limit)
        .exec(),
      this.shipmentModel.countDocuments(filter).exec(),
    ]);

    return Page.of(documents.map(ShipmentResponseDto.from), total, query.page, query.limit);
  }

  async findById(id: string, actor: AuthenticatedUser): Promise<ShipmentResponseDto> {
    const shipment = await this.getDocumentOrThrow(id);
    this.assertMayView(shipment, actor);
    return ShipmentResponseDto.from(shipment);
  }

  async findByOrder(orderId: string, actor: AuthenticatedUser): Promise<ShipmentResponseDto> {
    if (!Types.ObjectId.isValid(orderId)) throw new ResourceNotFoundException('Shipment', orderId);

    const shipment = await this.shipmentModel
      .findOne({ orderId: new Types.ObjectId(orderId), ...notDeleted })
      .exec();
    if (!shipment) throw new ResourceNotFoundException('Shipment for order', orderId);

    this.assertMayView(shipment, actor);
    return ShipmentResponseDto.from(shipment);
  }

  // ---------------------------------------------------------- state changes

  /**
   * Attach carrier details and move the shipment into transit.
   *
   * **The order moves first, and that ordering is the lock.** Dispatch used to
   * read the order's status, check it was not terminal, and then commit the
   * shipment in a separate transaction — so a customer cancelling in between
   * (now legal right up to dispatch) got their stock restored while the parcel
   * still went out. The units ended up in the courier's van *and* on the shelf,
   * and the customer received a cancellation notice and a tracking number.
   *
   * Moving the order first makes the state machine settle it, with no new
   * locking:
   *
   *   - cancel commits first → `canTransition(CANCELLED, …)` fails, this throws
   *     409, and the shipment is never touched;
   *   - this commits first → the order is SHIPPED, and SHIPPED has no CANCELLED
   *     edge, so the cancel is refused.
   *
   * A snapshot read inside a transaction would not have done it: this writes
   * only the shipment, so there is no conflict on the order document to detect.
   */
  async dispatch(
    id: string,
    dto: DispatchShipmentDto,
    actor: AuthenticatedUser,
  ): Promise<ShipmentResponseDto> {
    const existing = await this.getDocumentOrThrow(id);

    // Idempotent: re-dispatching a parcel already in transit returns it
    // unchanged rather than a permanent 409. Without this a failure anywhere
    // after the shipment save left no way to finish the job, because the
    // machine has no IN_TRANSIT → IN_TRANSIT edge.
    if (existing.status === ShipmentStatus.IN_TRANSIT) {
      return ShipmentResponseDto.from(existing);
    }

    const note = `Dispatched with ${dto.carrier} (${dto.trackingNumber})`;

    /**
     * PENDING → IN_TRANSIT skips PREPARING, which the machine disallows, so let
     * dispatching imply it rather than forcing two calls for one real action.
     *
     * The order mirrors each step in turn: the order machine has no
     * PAID → SHIPPED edge either, so skipping the implied PREPARING would leave
     * the order stuck at PAID.
     */
    const applied: ShipmentStatus[] =
      existing.status === ShipmentStatus.PENDING
        ? [ShipmentStatus.PREPARING, ShipmentStatus.IN_TRANSIT]
        : [ShipmentStatus.IN_TRANSIT];

    // Not mirrorToOrder: that swallows failures so a recorded parcel movement
    // is never lost. Here the opposite is wanted — if the order cannot move,
    // nothing should be recorded at all.
    for (const status of applied) {
      const orderStatus = ORDER_STATUS_FOR_SHIPMENT[status];
      if (!orderStatus) continue;
      await this.ordersService.updateStatus(existing.orderId.toString(), orderStatus, actor, note);
    }

    let saved!: ShipmentDocument;

    /**
     * The save and the announcement commit together, so a customer whose parcel
     * is marked dispatched is guaranteed to be told about it.
     *
     * The document is re-read inside the callback: `withTransaction` re-runs
     * this on a transient conflict, and Mongoose clears a document's modified
     * paths on a successful save, so retrying a document mutated outside would
     * write nothing while the outbox row committed.
     */
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const shipment = await this.shipmentModel
          .findOne({ _id: existing._id, ...notDeleted })
          .session(session)
          .exec();
        if (!shipment) throw new ResourceNotFoundException('Shipment', id);
        if (shipment.status === ShipmentStatus.IN_TRANSIT) {
          saved = shipment;
          return;
        }

        if (shipment.status === ShipmentStatus.PENDING) {
          this.applyStatus(
            shipment,
            ShipmentStatus.PREPARING,
            actor,
            null,
            'Preparing for dispatch',
          );
        }

        shipment.carrier = dto.carrier;
        shipment.trackingNumber = dto.trackingNumber;
        shipment.trackingUrl = dto.trackingUrl ?? null;
        shipment.estimatedDeliveryAt = dto.estimatedDeliveryAt
          ? new Date(dto.estimatedDeliveryAt)
          : null;

        this.applyStatus(shipment, ShipmentStatus.IN_TRANSIT, actor, null, note);
        await shipment.save({ session });

        await this.outboxService.record(
          {
            aggregateType: 'shipment',
            aggregateId: shipment._id,
            eventType: 'shipment.dispatched',
            payload: {
              shipmentId: shipment._id.toString(),
              orderId: shipment.orderId.toString(),
              orderNumber: shipment.orderNumber,
              carrier: dto.carrier,
              trackingNumber: dto.trackingNumber,
            },
          },
          session,
        );

        saved = shipment;
      });
    } finally {
      await session.endSession();
    }

    return ShipmentResponseDto.from(saved);
  }

  async updateStatus(
    id: string,
    next: ShipmentStatus,
    actor: AuthenticatedUser,
    location?: string,
    note?: string,
  ): Promise<ShipmentResponseDto> {
    const shipment = await this.getDocumentOrThrow(id);

    // Idempotent: repeating the current status is a no-op, not an error, because
    // carrier feeds routinely repeat themselves.
    //
    // Note this returns before mirrorToOrder, so a mirror that failed on the
    // first call cannot be repaired by repeating the request — the shipment
    // already holds the target status. Recovery is to move the order directly,
    // which staff can do from the order screen.
    if (shipment.status === next) return ShipmentResponseDto.from(shipment);

    this.applyStatus(shipment, next, actor, location ?? null, note ?? null);
    await shipment.save();

    await this.mirrorToOrder(shipment, next, actor, note ?? null);
    return ShipmentResponseDto.from(shipment);
  }

  // -------------------------------------------------------------- internals

  /**
   * Move the shipment in memory. Pure: no I/O, so the caller decides which
   * transaction the resulting save belongs to.
   */
  private applyStatus(
    shipment: ShipmentDocument,
    next: ShipmentStatus,
    actor: AuthenticatedUser | null,
    location: string | null,
    note: string | null,
  ): void {
    if (!canTransitionShipment(shipment.status, next)) {
      throw new InvalidStateTransitionException('Shipment', shipment.status, next);
    }

    shipment.status = next;
    shipment.events.push({
      status: next,
      at: new Date(),
      location,
      note,
      by: actor ? new Types.ObjectId(actor.id) : null,
    });

    if (next === ShipmentStatus.IN_TRANSIT) shipment.shippedAt = new Date();
    if (next === ShipmentStatus.DELIVERED) shipment.deliveredAt = new Date();
  }

  /**
   * Reflect the shipment's new state onto its order.
   *
   * Best-effort and outside the shipment's transaction: an already-closed
   * order must not stop the warehouse recording that a parcel physically moved.
   */
  private async mirrorToOrder(
    shipment: ShipmentDocument,
    next: ShipmentStatus,
    actor: AuthenticatedUser | null,
    note: string | null,
  ): Promise<void> {
    const orderStatus = ORDER_STATUS_FOR_SHIPMENT[next];
    if (!orderStatus) return;

    try {
      await this.ordersService.updateStatus(
        shipment.orderId.toString(),
        orderStatus,
        actor,
        note ?? `Shipment ${next}`,
      );
    } catch (error) {
      /**
       * Nothing the order does may undo a parcel that physically moved.
       *
       * This used to rethrow anything that was not a transition conflict, which
       * meant a restock failure — a soft-deleted product was enough — surfaced
       * as a 404 on a shipment that had *already been saved* as RETURNED. Worse,
       * the retry was useless: `updateStatus` short-circuits once the shipment
       * holds the target status, so the order stayed stranded with no way back
       * through this endpoint.
       *
       * The shipment record is the one that must not be lost, so every failure
       * here is logged and swallowed. The order can still be moved by hand from
       * the order screen, which is now a legal transition staff can see.
       */
      const reason = error instanceof Error ? error.message : String(error);
      const level = error instanceof InvalidStateTransitionException ? 'warn' : 'error';
      this.logger[level](
        `Shipment ${shipment._id.toString()} moved to ${next} but order ` +
          `${shipment.orderNumber} could not follow: ${reason}`,
      );
    }
  }

  private async getDocumentOrThrow(id: string): Promise<ShipmentDocument> {
    if (!Types.ObjectId.isValid(id)) throw new ResourceNotFoundException('Shipment', id);
    const shipment = await this.shipmentModel.findOne({ _id: id, ...notDeleted }).exec();
    if (!shipment) throw new ResourceNotFoundException('Shipment', id);
    return shipment;
  }

  /** 404 rather than 403 for someone else's shipment, so ids cannot be probed. */
  private assertMayView(shipment: ShipmentDocument, actor: AuthenticatedUser): void {
    if (roleAtLeast(actor.role, UserRole.ADMIN)) return;
    if (ownsRecord(actor.id, shipment)) return;
    throw new ResourceNotFoundException('Shipment', shipment._id.toString());
  }
}
