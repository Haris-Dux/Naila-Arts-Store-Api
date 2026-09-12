import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { minorUnitExponent } from '../../common/money';
import { Public } from '../auth/decorators/public.decorator';
import { StoreConfigDto } from './dto/store-config.dto';

/**
 * Settings a client needs before it can render or submit anything.
 *
 * Public and unauthenticated because a storefront needs it on first paint, and
 * because none of it is a secret — it is the same information already implicit
 * in every money value the API returns.
 */
@ApiTags('store')
@Controller('store')
export class StoreController {
  constructor(private readonly config: ConfigService) {}

  @Get('config')
  @Public()
  @ApiOperation({
    summary: 'Currency, its precision, and the store’s timezone',
    description:
      'Read once at startup. `minorUnitExponent` is the one field that changes behaviour: it is ' +
      'how a client converts a typed price to the integer minor units the API accepts, without ' +
      'assuming every currency divides by 100.',
  })
  @ApiResponse({ status: 200, type: StoreConfigDto })
  getConfig(): StoreConfigDto {
    const currency = this.config.getOrThrow<string>('store.currency');

    return {
      currency,
      // Derived, never separately configured — a second source for the same
      // fact is a second thing to get out of step with Money.
      minorUnitExponent: minorUnitExponent(currency),
      name: this.config.getOrThrow<string>('store.name'),
      timezone: this.config.getOrThrow<string>('store.timezone'),
    };
  }
}
