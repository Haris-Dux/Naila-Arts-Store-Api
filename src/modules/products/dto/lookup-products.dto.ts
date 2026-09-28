import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

/** A lookup resolves at most this many ids in one request. */
export const MAX_LOOKUP_IDS = 100;

export class LookupProductsDto {
  /**
   * Plain strings rather than `@IsMongoId`: these come back from a shopper's
   * localStorage, where one corrupted entry must not fail the whole list. A
   * malformed id is dropped by the service, exactly like an unknown one.
   */
  @ApiProperty({
    type: [String],
    maxItems: MAX_LOOKUP_IDS,
    description: 'Product ids, e.g. the favourites a storefront keeps in localStorage',
  })
  @IsArray()
  @ArrayMaxSize(MAX_LOOKUP_IDS, {
    message: `A lookup may ask for at most ${MAX_LOOKUP_IDS} products`,
  })
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  ids!: string[];
}
