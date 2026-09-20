import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Money } from '../../../common/money';
import { MoneyDto } from '../../products/dto/product-response.dto';
import { OrderStatus } from '../enums/order-status.enum';
import { Address, OrderDocument } from '../schemas/order.schema';

export class OrderItemResponseDto {
  @ApiProperty() productId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) sku!: string | null;
  @ApiPropertyOptional({ type: Object, nullable: true }) size!: {
    sizeId: string;
    name: string;
    code: string;
  } | null;
  @ApiProperty() quantity!: number;
  @ApiProperty({ type: MoneyDto }) unitPrice!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) lineTotal!: MoneyDto;
}

export class OrderStatusChangeDto {
  @ApiProperty({ enum: OrderStatus }) status!: OrderStatus;
  @ApiProperty() at!: Date;
  @ApiPropertyOptional({ type: String, nullable: true }) note!: string | null;
}

export class OrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orderNumber!: string;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Null for a guest order' })
  userId!: string | null;

  @ApiProperty({ description: 'Where the confirmation was sent' }) contactEmail!: string;
  @ApiProperty() contactName!: string;
  @ApiProperty({ description: 'True when placed without an account' }) isGuestOrder!: boolean;
  @ApiProperty({ enum: OrderStatus }) status!: OrderStatus;
  @ApiProperty({ type: [OrderItemResponseDto] }) items!: OrderItemResponseDto[];

  @ApiProperty({ type: MoneyDto }) subtotal!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) shippingTotal!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) taxTotal!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) discountTotal!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) grandTotal!: MoneyDto;

  @ApiProperty() shippingAddress!: Address;
  @ApiPropertyOptional({ nullable: true }) billingAddress!: Address | null;
  @ApiPropertyOptional({ type: String, nullable: true }) customerNote!: string | null;
  @ApiProperty({ type: [OrderStatusChangeDto] }) statusHistory!: OrderStatusChangeDto[];

  @ApiProperty() placedAt!: Date;
  @ApiPropertyOptional({ type: Date, nullable: true }) paidAt!: Date | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) cancelledAt!: Date | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) returnedAt!: Date | null;
  @ApiProperty() createdAt!: Date;

  static from(this: void, order: OrderDocument): OrderResponseDto {
    const money = (amount: number): MoneyDto => Money.fromMinor(amount, order.currency).toJSON();

    return {
      id: order._id.toString(),
      orderNumber: order.orderNumber,
      userId: order.userId ? order.userId.toString() : null,
      contactEmail: order.contactEmail,
      contactName: order.contactName,
      isGuestOrder: order.userId === null,
      status: order.status,
      items: order.items.map((item) => ({
        productId: item.productId.toString(),
        name: item.name,
        sku: item.sku,
        size: item.size
          ? {
              sizeId: item.size.sizeId.toString(),
              name: item.size.name,
              code: item.size.code,
            }
          : null,
        quantity: item.quantity,
        unitPrice: money(item.unitPrice),
        lineTotal: money(item.lineTotal),
      })),
      subtotal: money(order.subtotal),
      shippingTotal: money(order.shippingTotal),
      taxTotal: money(order.taxTotal),
      discountTotal: money(order.discountTotal),
      grandTotal: money(order.grandTotal),
      shippingAddress: order.shippingAddress,
      billingAddress: order.billingAddress,
      customerNote: order.customerNote,
      statusHistory: order.statusHistory.map((change) => ({
        status: change.status,
        at: change.at,
        note: change.note,
      })),
      placedAt: order.placedAt,
      paidAt: order.paidAt,
      cancelledAt: order.cancelledAt,
      returnedAt: order.returnedAt,
      createdAt: order.createdAt,
    };
  }
}
