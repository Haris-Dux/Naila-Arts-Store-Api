import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Money } from '../../common/money';
import { ResourceNotFoundException } from '../../common/exceptions/domain.exception';
import { notDeleted } from '../../common/schemas/base.schema';
import { Payment, PaymentDocument } from '../payments/schemas/payment.schema';
import { Shipment, ShipmentDocument } from '../shipping/schemas/shipment.schema';
import { OrderTrackingDto } from './dto/order-tracking.dto';
import { Address, Order, OrderDocument } from './schemas/order.schema';

/**
 * "Where is my order?", answered without an account.
 *
 * This is the whole of a guest's access to their order, replacing the signed
 * cookie that used to identify them. That cookie worked only in the browser that
 * placed the order and only for thirty days; an order number works from any
 * device, for as long as the order exists.
 *
 * The trade is that an order number is not a secret — it is printed on parcels
 * and quoted in emails — so this reads like a public tracking page rather than
 * the order itself: see `OrderTrackingDto` for what is withheld and why. It is
 * also the reason nothing here can *change* an order. Cancelling needs an
 * account or a word with support.
 *
 * Registered with the Payment and Shipment models rather than their services, so
 * one lookup answers the status question in full without OrdersModule taking a
 * dependency on ShippingModule, which already depends on it.
 */
@Injectable()
export class OrderTrackingService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<PaymentDocument>,
    @InjectModel(Shipment.name) private readonly shipmentModel: Model<ShipmentDocument>,
  ) {}

  async lookup(orderNumber: string): Promise<OrderTrackingDto> {
    const order = await this.orderModel.findOne({ orderNumber, ...notDeleted }).exec();
    if (!order) throw new ResourceNotFoundException('Order', orderNumber);

    // The live attempt, or the most recent one if it failed and was retried.
    const [payment, shipment] = await Promise.all([
      this.paymentModel
        .findOne({ orderId: order._id, ...notDeleted })
        .sort({ createdAt: -1 })
        .exec(),
      this.shipmentModel.findOne({ orderId: order._id, ...notDeleted }).exec(),
    ]);

    const money = (amount: number) => Money.fromMinor(amount, order.currency).toJSON();

    return {
      orderNumber: order.orderNumber,
      status: order.status,
      recipient: OrderTrackingService.shortenName(order.shippingAddress.fullName),
      destination: OrderTrackingService.cityAndCountry(order.shippingAddress),
      items: order.items.map((item) => ({
        productId: item.productId.toString(),
        name: item.name,
        color: item.color,
        size: item.size ? item.size.name : null,
        quantity: item.quantity,
        lineTotal: money(item.lineTotal),
      })),
      subtotal: money(order.subtotal),
      shippingTotal: money(order.shippingTotal),
      grandTotal: money(order.grandTotal),
      payment: payment ? { method: payment.method, status: payment.status } : null,
      shipment: shipment
        ? {
            status: shipment.status,
            carrier: shipment.carrier,
            trackingNumber: shipment.trackingNumber,
            trackingUrl: shipment.trackingUrl,
            shippedAt: shipment.shippedAt,
            estimatedDeliveryAt: shipment.estimatedDeliveryAt,
            deliveredAt: shipment.deliveredAt,
          }
        : null,
      // Statuses and their timestamps only: the notes on a status change are
      // written by staff for staff.
      statusHistory: order.statusHistory.map((change) => ({
        status: change.status,
        at: change.at,
      })),
      placedAt: order.placedAt,
      cancelledAt: order.cancelledAt,
      returnedAt: order.returnedAt,
    };
  }

  /**
   * "Ayesha Khan" → "Ayesha K." — enough for the customer to recognise their own
   * order, not enough to learn who bought what from a number on a parcel.
   */
  private static shortenName(fullName: string): string {
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return parts[0] ?? '';
    return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
  }

  private static cityAndCountry(address: Address): string {
    return [address.city, address.country].filter(Boolean).join(', ');
  }
}
