import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { readRequestOwner } from '../../common/request-owner';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { MinRole } from '../auth/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { UserRole } from '../users/enums/user-role.enum';
import {
  DispatchShipmentDto,
  ListShipmentsDto,
  ShipmentResponseDto,
  UpdateShipmentStatusDto,
} from './dto/shipment.dto';
import { ShippingService } from './shipping.service';

/**
 * There is no create endpoint. A shipment exists because an order was confirmed
 * — paid up front, or accepted for cash on delivery — so it is created by the
 * outbox handlers and nothing else.
 *
 * The customer-facing routes are @Public() so a guest can track an order they
 * placed without an account; ownership is proved by the same signed cookie that
 * placed the order.
 */
@ApiTags('shipping')
@Controller('shipments')
export class ShippingController {
  constructor(private readonly shippingService: ShippingService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'List shipments — your own, or all for staff' })
  @ApiResponse({ status: 200, description: 'Paginated shipments' })
  list(
    @Query() query: ListShipmentsDto,
    @Req() request: Request,
    @CurrentUser() actor?: AuthenticatedUser,
  ) {
    return this.shippingService.list(query, readRequestOwner(request), actor);
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Get a shipment' })
  @ApiResponse({ status: 200, type: ShipmentResponseDto })
  @ApiResponse({ status: 404, description: 'Not found, or not yours' })
  findOne(
    @Param('id') id: string,
    @Req() request: Request,
    @CurrentUser() actor?: AuthenticatedUser,
  ) {
    return this.shippingService.findById(id, readRequestOwner(request), actor);
  }

  @Get('orders/:orderId')
  @Public()
  @ApiOperation({ summary: 'Track the shipment for an order (guest or signed in)' })
  @ApiResponse({ status: 200, type: ShipmentResponseDto })
  @ApiResponse({ status: 404, description: 'No shipment yet — the order is not confirmed' })
  findByOrder(
    @Param('orderId') orderId: string,
    @Req() request: Request,
    @CurrentUser() actor?: AuthenticatedUser,
  ) {
    return this.shippingService.findByOrder(orderId, readRequestOwner(request), actor);
  }

  @Post(':id/dispatch')
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Hand to the carrier; moves the order to SHIPPED' })
  @ApiResponse({ status: 201, type: ShipmentResponseDto })
  @ApiResponse({ status: 409, description: 'Not dispatchable from its current status' })
  dispatch(
    @Param('id') id: string,
    @Body() dto: DispatchShipmentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.shippingService.dispatch(id, dto, actor);
  }

  @Patch(':id/status')
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Record a shipment status change (staff)' })
  @ApiResponse({ status: 200, type: ShipmentResponseDto })
  @ApiResponse({ status: 409, description: 'Not a legal transition' })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateShipmentStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.shippingService.updateStatus(id, dto.status, actor, dto.location, dto.note);
  }
}
