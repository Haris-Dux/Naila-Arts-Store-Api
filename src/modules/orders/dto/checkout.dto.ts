import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEmail,
  IsEnum,
  IsISO31661Alpha2,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { OrderStatus } from '../enums/order-status.enum';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : (value as string);

export class AddressDto {
  @ApiProperty({ example: 'Jane Doe' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(trim)
  fullName!: string;

  @ApiProperty({ example: '12 Market Street' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Transform(trim)
  line1!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  line2?: string;

  @ApiProperty({ example: 'Manchester' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @Transform(trim)
  city!: string;

  @ApiPropertyOptional({ example: 'Greater Manchester' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  state?: string;

  @ApiProperty({ example: 'M1 1AA' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Transform(trim)
  postalCode!: string;

  @ApiProperty({ example: 'GB', description: 'ISO 3166-1 alpha-2' })
  @IsISO31661Alpha2({ message: 'country must be a two-letter ISO country code' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : (value as string),
  )
  country!: string;

  @ApiPropertyOptional({ example: '+44 7700 900000' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Transform(trim)
  phone?: string;
}

/** Guards against a typo or a script turning into a 10,000-unit order. */
export const MAX_LINE_QUANTITY = 999;

/**
 * One line of the basket: what, and how many. Nothing else.
 *
 * The basket lives in the browser, so the client does send the lines — but it
 * sends only these two fields. The old `CreateOrderDto` took `unitPrice`,
 * `totalPrice` and `userId` from the request body and never checked any of it
 * against the catalogue, which is how a client could buy anything for a penny on
 * anybody's account. A price or a total appearing here would be rejected as an
 * unknown key, and both are read from the catalogue inside the transaction
 * instead.
 */
export class CheckoutItemDto {
  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  @IsMongoId()
  productId!: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: MAX_LINE_QUANTITY })
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;

  /**
   * Required for a sized product, refused for an unstitched one.
   *
   * Without it a sized order cannot be picked and packed, so it is validated
   * against the product rather than accepted and ignored. Two lines of the same
   * product in different sizes are two lines, not a duplicate.
   */
  @ApiPropertyOptional({ description: 'Required when the product is sold by size' })
  @IsOptional()
  @IsMongoId()
  sizeId?: string;
}

/**
 * Everything checkout accepts.
 *
 * Note what is still *not* here: no prices, no totals, no userId. Lines, prices
 * and the customer are the three things the old stack let a client dictate; only
 * the first has moved, and only as far as product ids and quantities.
 */
export class CheckoutDto {
  /**
   * The basket, assembled by the browser.
   *
   * Capped so a single request cannot ask the transaction to touch an unbounded
   * number of products — every line is a separate conditional stock update, and
   * they all hold locks until the commit.
   */
  @ApiProperty({ type: [CheckoutItemDto], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayNotEmpty({ message: 'An order needs at least one item' })
  @ArrayMaxSize(100, { message: 'An order takes at most 100 distinct products' })
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items!: CheckoutItemDto[];

  /**
   * Required when checking out as a guest, ignored when signed in.
   *
   * Conditionally required rather than always: a signed-in customer's details
   * come from their account, and letting them override the address here would
   * reintroduce the client-supplied-identity problem in a new place.
   */
  @ApiPropertyOptional({
    example: 'jane@example.com',
    description: 'Required for guest checkout; taken from the account when signed in',
  })
  @IsOptional()
  @IsEmail({}, { message: 'A valid email address is required to check out as a guest' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : (value as string),
  )
  email?: string;

  @ApiPropertyOptional({ example: 'Jane Doe', description: 'Required for guest checkout' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trim)
  name?: string;

  @ApiProperty({ type: AddressDto })
  @ValidateNested()
  @Type(() => AddressDto)
  shippingAddress!: AddressDto;

  @ApiPropertyOptional({ type: AddressDto, description: 'Defaults to the shipping address' })
  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  billingAddress?: AddressDto;

  @ApiPropertyOptional({ example: 'Please leave with a neighbour' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  customerNote?: string;
}

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: OrderStatus })
  @IsEnum(OrderStatus)
  status!: OrderStatus;

  @ApiPropertyOptional({ description: 'Recorded in the order’s status history' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;
}

export class CancelOrderDto {
  @ApiPropertyOptional({ example: 'Ordered the wrong size' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  reason?: string;
}
