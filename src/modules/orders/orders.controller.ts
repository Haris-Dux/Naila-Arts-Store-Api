import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ValidationFailedException } from '../../common/exceptions/domain.exception';
import { newGuestToken, setGuestCookie } from '../../common/guest-token';
import { RequestOwner, readRequestOwner } from '../../common/request-owner';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { MinRole } from '../auth/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { UserRole } from '../users/enums/user-role.enum';
import { CheckoutService } from './checkout.service';
import { CancelOrderDto, CheckoutDto, UpdateOrderStatusDto } from './dto/checkout.dto';
import { ListOrdersDto } from './dto/list-orders.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { IdempotencyService } from './idempotency.service';
import { OrdersService } from './orders.service';

/**
 * Customer-facing order routes are @Public() but not unauthenticated.
 *
 * JwtAuthGuard still runs and populates `req.user` when a token is present; the
 * owner is then resolved from that in preference to the guest cookie. So a
 * signed-in customer always acts on their own orders, and a guest acts on the
 * ones placed with their cookie. Neither can reach anybody else's.
 *
 * Staff routes keep their `@MinRole(ADMIN)` guard.
 */
@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  private readonly isProduction: boolean;

  constructor(
    private readonly ordersService: OrdersService,
    private readonly checkoutService: CheckoutService,
    private readonly idempotencyService: IdempotencyService,
    config: ConfigService,
  ) {
    this.isProduction = config.getOrThrow<string>('app.env') === 'production';
  }

  /**
   * Scope for the idempotency key.
   *
   * Keys are per-caller so two customers cannot collide on a shared value like
   * "checkout-1". A signed-in customer has a stable id to scope by.
   *
   * A guest does not, and deliberately is not scoped by their cookie: checkout
   * is where that cookie gets minted, so a guest's first attempt has no identity
   * and their retry — carrying the cookie the first response set — would land in
   * a different scope and place a second order. The request body stands in
   * instead. It is stable across a retry by definition, since reusing a key with
   * a different body is refused anyway, and it separates two guests reliably:
   * matching would mean the same email, name, address and basket.
   */
  private static ownerScope(owner: RequestOwner, dto: CheckoutDto): string {
    return owner.userId ?? `guest:${IdempotencyService.fingerprint(dto)}`;
  }

  /**
   * Place an order. Works signed in or as a guest.
   *
   * The basket is assembled in the browser and arrives in the body — product ids
   * and quantities only. Everything that decides what the customer pays, and who
   * they are, is still resolved server-side.
   *
   * Requires an `Idempotency-Key`. A double-click, or a mobile client retrying
   * after a timeout it cannot distinguish from a failure, would otherwise create
   * two orders and decrement stock twice.
   */
  @Post('checkout')
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated unique value; a replay returns the first result',
  })
  @ApiOperation({ summary: 'Place an order (guest or signed in)' })
  @ApiResponse({ status: 201, type: OrderResponseDto })
  @ApiResponse({
    status: 400,
    description: 'No items, unavailable product, or missing guest contact',
  })
  @ApiResponse({ status: 409, description: 'Insufficient stock, or a request already in flight' })
  async checkout(
    @Body() dto: CheckoutDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OrderResponseDto> {
    if (!idempotencyKey || idempotencyKey.trim().length < 8) {
      throw new ValidationFailedException(
        'An Idempotency-Key header of at least 8 characters is required for checkout',
      );
    }

    const caller = readRequestOwner(request);

    // A guest's first contact with the server is this request, so there is
    // usually no cookie yet. Mint the identity here: the order needs an owner,
    // and without one the guest could never read back what they just placed.
    const mintedToken = caller.userId || caller.guestToken ? null : newGuestToken();
    const owner: RequestOwner = mintedToken ? { userId: null, guestToken: mintedToken } : caller;

    const claim = await this.idempotencyService.claim(
      idempotencyKey.trim(),
      OrdersController.ownerScope(caller, dto),
      'POST /orders/checkout',
      dto,
      owner.userId,
    );

    // Already done: return the original result rather than placing a second
    // order. Deliberately without setting a cookie — the response that created
    // the order already sent the token this replay's would contradict.
    if (claim.replay) return claim.replay as unknown as OrderResponseDto;

    const token = claim.token as Types.ObjectId;
    try {
      const order = await this.checkoutService.checkout(owner, dto);
      if (mintedToken) setGuestCookie(response, mintedToken, this.isProduction);
      await this.idempotencyService.complete(
        token,
        order as unknown as Record<string, unknown>,
        new Types.ObjectId(order.id),
      );
      return order;
    } catch (error) {
      // Release the key so the customer can fix the problem and retry, rather
      // than being locked out until the 24h TTL expires.
      await this.idempotencyService.release(token);
      throw error;
    }
  }

  @Get()
  @Public()
  @ApiOperation({ summary: 'List orders — your own, or all for staff' })
  @ApiResponse({ status: 200, description: 'Paginated orders' })
  list(
    @Query() query: ListOrdersDto,
    @Req() request: Request,
    @CurrentUser() actor?: AuthenticatedUser,
  ) {
    return this.ordersService.list(query, readRequestOwner(request), actor);
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Get an order' })
  @ApiResponse({ status: 200, type: OrderResponseDto })
  @ApiResponse({ status: 404, description: 'Not found, or not yours' })
  findOne(
    @Param('id') id: string,
    @Req() request: Request,
    @CurrentUser() actor?: AuthenticatedUser,
  ) {
    return this.ordersService.findById(id, readRequestOwner(request), actor);
  }

  @Patch(':id/status')
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Move an order to a new status (staff)' })
  @ApiResponse({ status: 200, type: OrderResponseDto })
  @ApiResponse({ status: 403, description: 'Requires ADMIN' })
  @ApiResponse({ status: 409, description: 'Not a legal transition from the current status' })
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.ordersService.updateStatus(id, dto.status, actor, dto.note);
  }

  /**
   * Cancel. Replaces the old `DELETE /orders/:id`: an order is a financial
   * record, so it is cancelled, never deleted — and cancelling returns the stock
   * to the shelf, which deletion never did.
   */
  @Post(':id/cancel')
  @Public()
  @ApiOperation({ summary: 'Cancel an order and return its stock' })
  @ApiResponse({ status: 201, type: OrderResponseDto })
  @ApiResponse({ status: 403, description: 'Too late to cancel; contact support' })
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @Req() request: Request,
    @CurrentUser() actor?: AuthenticatedUser,
  ) {
    return this.ordersService.cancel(id, readRequestOwner(request), actor, dto.reason);
  }
}
