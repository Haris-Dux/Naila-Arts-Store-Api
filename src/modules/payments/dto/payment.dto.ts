import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsMongoId, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Money } from '../../../common/money';
import { MoneyDto } from '../../products/dto/product-response.dto';
import { PaymentMethod, PaymentStatus } from '../enums/payment-status.enum';
import { PaymentDocument } from '../schemas/payment.schema';

export class CreatePaymentDto {
  @ApiProperty({ description: 'The order to pay for' })
  @IsMongoId()
  orderId!: string;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  /**
   * Note the absence of an `amount`. The sum charged is copied from the order,
   * so a client cannot choose what it pays — the same reasoning that keeps
   * prices off CheckoutDto.
   */
}

export class RefundPaymentDto {
  @ApiPropertyOptional({
    description: 'Minor units to refund; omit to refund the full remaining amount',
    example: 1999,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : (value as string),
  )
  reason?: string;
}

export class CapturePaymentDto {
  @ApiPropertyOptional({ description: 'Recorded against the payment' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : (value as string),
  )
  note?: string;
}

export class PaymentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty() provider!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ enum: PaymentMethod }) method!: PaymentMethod;
  @ApiProperty({ enum: PaymentStatus }) status!: PaymentStatus;
  @ApiProperty({ type: MoneyDto }) amount!: MoneyDto;
  @ApiProperty({ type: MoneyDto }) amountRefunded!: MoneyDto;
  @ApiPropertyOptional({ nullable: true }) instructions!: Record<string, unknown> | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) capturedAt!: Date | null;
  @ApiPropertyOptional({ type: String, nullable: true }) failureReason!: string | null;
  @ApiProperty() createdAt!: Date;

  static from(this: void, payment: PaymentDocument): PaymentResponseDto {
    return {
      id: payment._id.toString(),
      orderId: payment.orderId.toString(),
      provider: payment.provider,
      reference: payment.reference,
      method: payment.method,
      status: payment.status,
      amount: Money.fromMinor(payment.amount, payment.currency).toJSON(),
      amountRefunded: Money.fromMinor(payment.amountRefunded, payment.currency).toJSON(),
      instructions: payment.instructions,
      capturedAt: payment.capturedAt,
      failureReason: payment.failureReason,
      createdAt: payment.createdAt,
    };
  }
}
