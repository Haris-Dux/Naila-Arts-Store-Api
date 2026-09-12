import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { MinRole } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import {
  SuitColorDto,
  SuitColorQueryDto,
  SuitDesignDto,
  SuitDesignQueryDto,
} from './dto/suit-query.dto';
import { SuitsService } from './suits.service';

/**
 * The ERP's suits, as the dashboard needs them to build a product on one:
 * pick a design, then one of its colours — whose id becomes `erpId`.
 */
@ApiTags('erp')
@ApiBearerAuth()
@Controller('erp/suits')
@MinRole(UserRole.ADMIN)
export class SuitsController {
  constructor(private readonly suits: SuitsService) {}

  @Get('designs')
  @ApiOperation({ summary: 'Search designs that have stock, by design number' })
  @ApiResponse({ status: 200, type: [SuitDesignDto] })
  designs(@Query() query: SuitDesignQueryDto) {
    return this.suits.designs(query);
  }

  @Get('colors')
  @ApiOperation({ summary: 'The in-stock colours of one design' })
  @ApiResponse({ status: 200, type: [SuitColorDto] })
  colors(@Query() query: SuitColorQueryDto) {
    return this.suits.colors(query);
  }
}
