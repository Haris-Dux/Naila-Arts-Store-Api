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
import { OrderStatus } from '../orders/enums/order-status.enum';
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
  async createForOrder(orderId: string): Promise<ShipmentDocument> {
    const order = await this.orderModel.findOne({ _id: orderId, ...notDeleted }).exec();
    if (!order) throw new ResourceNotFoundException('Order', orderId);

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

  /** Attach carrier details and move the shipment into transit. */
  async dispatch(
    id: string,
    dto: DispatchShipmentDto,
    actor: AuthenticatedUser,
  ): Promise<ShipmentResponseDto> {
    const shipment = await this.getDocumentOrThrow(id);

    // PENDING → IN_TRANSIT skips PREPARING, which the machine disallows, so let
    // dispatching imply it rather than forcing two calls for one real action.
    //
    // Each applied step is mirrored onto the order afterwards, in order: the
    // order machine also has no PAID → SHIPPED edge, so skipping the implied
    // PREPARING here would leave the order stuck at PAID.
    const applied: ShipmentStatus[] = [];
    if (shipment.status === ShipmentStatus.PENDING) {
      this.applyStatus(shipment, ShipmentStatus.PREPARING, actor, null, 'Preparing for dispatch');
      applied.push(ShipmentStatus.PREPARING);
    }

    shipment.carrier = dto.carrier;
    shipment.trackingNumber = dto.trackingNumber;
    shipment.trackingUrl = dto.trackingUrl ?? null;
    shipment.estimatedDeliveryAt = dto.estimatedDeliveryAt
      ? new Date(dto.estimatedDeliveryAt)
      : null;

    const note = `Dispatched with ${dto.carrier} (${dto.trackingNumber})`;
    this.applyStatus(shipment, ShipmentStatus.IN_TRANSIT, actor, null, note);
    applied.push(ShipmentStatus.IN_TRANSIT);

    // The save and the announcement commit together, so a customer whose parcel
    // is marked dispatched is guaranteed to be told about it.
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
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
      });
    } finally {
      await session.endSession();
    }

    for (const status of applied) {
      await this.mirrorToOrder(shipment, status, actor, note);
    }
    return ShipmentResponseDto.from(shipment);
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
   * Best-effort and outside the shipment's transaction: a cancelled or refunded
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
      if (error instanceof InvalidStateTransitionException) {
        this.logger.warn(
          `Shipment ${shipment._id.toString()} moved to ${next} but order could not follow: ${error.message}`,
        );
      } else {
        throw error;
      }
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
