import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MinRole } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/enums/user-role.enum';
import { InventoryService } from './inventory.service';

/**
 * Read-only. Stock is not something an administrator types.
 *
 * There used to be a "receive delivery" and a "set absolute level" endpoint
 * here. Both are gone: every colour is an ERP suit, replenishment happens in the
 * ERP when a branch books a bill, and a second place to type a number is a
 * second answer to "how many are there".
 */
@ApiTags('inventory')
@ApiBearerAuth()
@Controller('inventory')
@MinRole(UserRole.ADMIN)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('products/:id')
  @ApiOperation({ summary: 'Current on-hand quantity, across every colour' })
  @ApiResponse({ status: 200, description: 'The product’s stock level' })
  @ApiResponse({ status: 403, description: 'Requires ADMIN' })
  async level(@Param('id') id: string) {
    const levels = await this.inventoryService.levelsFor([id]);
    return { productId: id, stock: levels.get(id) ?? 0 };
  }
}
