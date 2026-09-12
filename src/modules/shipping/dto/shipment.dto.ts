import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { Address } from '../../orders/schemas/order.schema';
import { ShipmentStatus } from '../enums/shipment-status.enum';
import { ShipmentDocument } from '../schemas/shipment.schema';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : (value as string);

/** Dispatch: attach carrier details and move the shipment into transit. */
export class DispatchShipmentDto {
  @ApiProperty({ example: 'Royal Mail' })
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  carrier!: string;

  @ApiProperty({ example: 'RM123456789GB' })
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  trackingNumber!: string;

  @ApiPropertyOptional({ example: 'https://track.example.com/RM123456789GB' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  trackingUrl?: string;

  @ApiPropertyOptional({ example: '2026-09-10', description: 'ISO 8601 date' })
  @IsOptional()
  @IsDateString({ strict: true })
  estimatedDeliveryAt?: string;
}

export class UpdateShipmentStatusDto {
  @ApiProperty({ enum: ShipmentStatus })
  @IsEnum(ShipmentStatus)
  status!: ShipmentStatus;

  @ApiPropertyOptional({ example: 'Manchester depot' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;
}

export const SHIPMENT_SORT_FIELDS = ['createdAt', 'status', 'shippedAt'] as const;
export type ShipmentSortField = (typeof SHIPMENT_SORT_FIELDS)[number];

export class ListShipmentsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: SHIPMENT_SORT_FIELDS, default: 'createdAt' })
  @IsIn(SHIPMENT_SORT_FIELDS)
  @IsOptional()
  sort: ShipmentSortField = 'createdAt';

  @ApiPropertyOptional({ enum: ShipmentStatus })
  @IsOptional()
  @IsEnum(ShipmentStatus)
  status?: ShipmentStatus;

  /** Ignored for customers, who only ever see their own shipments. */
  @ApiPropertyOptional({ description: 'Filter by customer (staff only)' })
  @IsOptional()
  @IsMongoId()
  userId?: string;
}

export class ShipmentEventDto {
  @ApiProperty({ enum: ShipmentStatus }) status!: ShipmentStatus;
  @ApiProperty() at!: Date;
  @ApiPropertyOptional({ type: String, nullable: true }) location!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) note!: string | null;
}

export class ShipmentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty() orderNumber!: string;
  @ApiProperty({ enum: ShipmentStatus }) status!: ShipmentStatus;
  @ApiProperty() shippingAddress!: Address;
  @ApiProperty() items!: { productId: string; name: string; quantity: number }[];
  @ApiPropertyOptional({ type: String, nullable: true }) carrier!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) trackingNumber!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) trackingUrl!: string | null;
  @ApiProperty({ type: [ShipmentEventDto] }) events!: ShipmentEventDto[];
  @ApiPropertyOptional({ type: Date, nullable: true }) estimatedDeliveryAt!: Date | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) shippedAt!: Date | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) deliveredAt!: Date | null;
  @ApiProperty() createdAt!: Date;

  static from(this: void, shipment: ShipmentDocument): ShipmentResponseDto {
    return {
      id: shipment._id.toString(),
      orderId: shipment.orderId.toString(),
      orderNumber: shipment.orderNumber,
      status: shipment.status,
      shippingAddress: shipment.shippingAddress,
      items: shipment.items.map((item) => ({
        productId: item.productId.toString(),
        name: item.name,
        quantity: item.quantity,
      })),
      carrier: shipment.carrier,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: shipment.trackingUrl,
      events: shipment.events.map((event) => ({
        status: event.status,
        at: event.at,
        location: event.location,
        note: event.note,
      })),
      estimatedDeliveryAt: shipment.estimatedDeliveryAt,
      shippedAt: shipment.shippedAt,
      deliveredAt: shipment.deliveredAt,
      createdAt: shipment.createdAt,
    };
  }
}
