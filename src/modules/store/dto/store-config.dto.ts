import { ApiProperty } from '@nestjs/swagger';

/**
 * The handful of server-side settings a client cannot work without.
 *
 * Deliberately not a general settings dump: everything here is something a
 * caller needs in order to interpret or produce data correctly, not something
 * merely nice to display.
 */
export class StoreConfigDto {
  @ApiProperty({ example: 'PKR', description: 'ISO 4217 code every price is denominated in' })
  currency!: string;

  @ApiProperty({
    example: 0,
    description:
      'Decimal places in the currency’s minor unit. Prices cross the API as integers of that ' +
      'unit, so a client converts a typed amount with 10^exponent. PKR is 0 — prices are whole ' +
      'rupees — where USD is 2. Hardcoding 100 is the bug this field exists to prevent.',
  })
  minorUnitExponent!: number;

  @ApiProperty({ example: 'Store' })
  name!: string;

  @ApiProperty({
    example: 'Asia/Karachi',
    description: 'IANA zone the merchant’s day is measured in',
  })
  timezone!: string;
}
