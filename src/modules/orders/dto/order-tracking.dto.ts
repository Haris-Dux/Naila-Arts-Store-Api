import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { MoneyDto } from '../../products/dto/product-response.dto';
import { PaymentMethod, PaymentStatus } from '../../payments/enums/payment-status.enum';
import { ShipmentStatus } from '../../shipping/enums/shipment-status.enum';
import { OrderStatus } from '../enums/order-status.enum';

export class LookupOrderDto {
  /**
   * Upper-cased on the way in: order numbers are generated upper-case, and a
   * customer copying one off a parcel should not have to match its case.
   */
  @ApiProperty({ example: 'ORD-20260918-4C2A9F31' })
  @IsString()
  @IsNotEmpty({ message: 'An order number is required' })
  @MaxLength(40)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : (value as string),
  )
  orderNumber!: string;
}

export class OrderTrackingItemDto {
  @ApiProperty() productId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) size!: string | null;
  @ApiProperty() quantity!: number;
  @ApiProperty({ type: MoneyDto }) lineTotal!: MoneyDto;
}

export class OrderTrackingStepDto {
  @ApiProperty({ enum: OrderStatus }) status!: OrderStatus;
  @ApiProperty() at!: Date;
}

export class OrderTrackingPaymentDto {
  @ApiProperty({ enum: PaymentMethod }) method!: PaymentMethod;
  @ApiProperty({ enum: PaymentStatus }) status!: PaymentStatus;
}

export class OrderTrackingShipmentDto {
  @ApiProperty({ enum: ShipmentStatus }) status!: ShipmentStatus;
  @ApiPropertyOptional({ type: String, nullable: true }) carrier!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) trackingNumber!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) trackingUrl!: string | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) shippedAt!: Date | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) estimatedDeliveryAt!: Date | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) deliveredAt!: Date | null;
}

/**
 * What a guest sees when they look their order up by number.
 *
 * Reduced on purpose. An order number travels on parcels, receipts and
 * forwarded emails, so it identifies an order without proving anything about
 * who is asking. Enough is returned to answer "where is my order?" — status,
 * what was bought, what it cost, where the parcel is — and nothing that would
 * hand a stranger the customer's contact details: no email, no phone, no street
 * address, no customer note. The recipient's name is shortened and only the city
 * and country of the destination are shown, so the customer can confirm the
 * order is theirs without the page exposing where they live.
 */
export class OrderTrackingDto {
  @ApiProperty() orderNumber!: string;
  @ApiProperty({ enum: OrderStatus }) status!: OrderStatus;
  @ApiProperty({ example: 'Ayesha K.', description: 'Shortened; never the full name' })
  recipient!: string;
  @ApiProperty({ example: 'Lahore, PK', description: 'City and country only' })
  destination!: string;

  @ApiProperty({ type: [OrderTrackingItemDto] }) items!: OrderTrackingItemDto[];
  @ApiProperty({ type: MoneyDto }) subtotal!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) shippingTotal!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) grandTotal!: MoneyDto;

  @ApiPropertyOptional({ type: OrderTrackingPaymentDto, nullable: true })
  payment!: OrderTrackingPaymentDto | null;
  @ApiPropertyOptional({ type: OrderTrackingShipmentDto, nullable: true })
  shipment!: OrderTrackingShipmentDto | null;

  @ApiProperty({ type: [OrderTrackingStepDto] }) statusHistory!: OrderTrackingStepDto[];
  @ApiProperty() placedAt!: Date;
  @ApiPropertyOptional({ type: Date, nullable: true }) cancelledAt!: Date | null;
  // The two endings are co-equal, so a guest sees a timestamp for either.
  @ApiPropertyOptional({ type: Date, nullable: true }) returnedAt!: Date | null;
}
