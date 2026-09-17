import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Types } from 'mongoose';
import { ValidationFailedException } from '../../common/exceptions/domain.exception';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { MinRole } from '../auth/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { UserRole } from '../users/enums/user-role.enum';
import { CheckoutService } from './checkout.service';
import { CancelOrderDto, CheckoutDto, UpdateOrderStatusDto } from './dto/checkout.dto';
import { ListOrdersDto } from './dto/list-orders.dto';
import { LookupOrderDto, OrderTrackingDto } from './dto/order-tracking.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { IdempotencyService } from './idempotency.service';
import { OrderTrackingService } from './order-tracking.service';
import { OrdersService } from './orders.service';

/**
 * Checkout and the tracking lookup are `@Public()`; everything else needs a
 * token.
 *
 * A guest owns no identity on the server — there is no cookie and nothing is
 * minted for them — so the only way back to a guest order is `GET
 * /orders/lookup`, which matches on the order number and returns a reduced view.
 * Every other customer route resolves the caller from their token and reaches
 * only their own orders; staff routes keep `@MinRole(ADMIN)`.
 */
@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly checkoutService: CheckoutService,
    private readonly idempotencyService: IdempotencyService,
    private readonly trackingService: OrderTrackingService,
  ) {}

  /**
   * Scope for the idempotency key.
   *
   * Keys are per-caller so two customers cannot collide on a shared value like
   * "checkout-1". A signed-in customer has a stable id to scope by; a guest has
   * nothing at all, so the request body stands in. It is stable across a retry
   * by definition, since reusing a key with a different body is refused anyway,
   * and it separates two guests reliably: matching would mean the same email,
   * name, address and basket.
   */
  private static ownerScope(actor: AuthenticatedUser | undefined, dto: CheckoutDto): string {
    return actor?.id ?? `guest:${IdempotencyService.fingerprint(dto)}`;
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
    @CurrentUser() actor?: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OrderResponseDto> {
    if (!idempotencyKey || idempotencyKey.trim().length < 8) {
      throw new ValidationFailedException(
        'An Idempotency-Key header of at least 8 characters is required for checkout',
      );
    }

    const claim = await this.idempotencyService.claim(
      idempotencyKey.trim(),
      OrdersController.ownerScope(actor, dto),
      'POST /orders/checkout',
      dto,
      actor?.id ?? null,
    );

    // Already done: return the original result rather than placing a second order.
    if (claim.replay) return claim.replay as unknown as OrderResponseDto;

    const token = claim.token as Types.ObjectId;
    try {
      const order = await this.checkoutService.checkout(actor, dto);
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

  /**
   * Track an order by its number, with no account and no cookie.
   *
   * Declared before `:id`, or the router would read "lookup" as an order id.
   *
   * The response is deliberately reduced — no email, phone, street address or
   * customer note — because an order number travels on parcels, receipts and
   * forwarded emails, and is therefore not a secret. Throttled like the
   * credential routes so the number space cannot be swept.
   */
  @Get('lookup')
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Track an order by its order number (no account needed)' })
  @ApiResponse({ status: 200, type: OrderTrackingDto })
  @ApiResponse({ status: 404, description: 'No order with that number' })
  lookup(@Query() query: LookupOrderDto): Promise<OrderTrackingDto> {
    return this.trackingService.lookup(query.orderNumber);
  }

  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List orders — your own, or all for staff' })
  @ApiResponse({ status: 200, description: 'Paginated orders' })
  @ApiResponse({ status: 401, description: 'Requires a token; guests use /orders/lookup' })
  list(@Query() query: ListOrdersDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.ordersService.list(query, actor);
  }

  @Get(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get an order' })
  @ApiResponse({ status: 200, type: OrderResponseDto })
  @ApiResponse({ status: 404, description: 'Not found, or not yours' })
  findOne(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.ordersService.findById(id, actor);
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
   *
   * Signed-in customers cancel their own before it ships; staff cancel any.
   * A guest has no identity to prove, so cancelling a guest order is staff work,
   * reached through support.
   */
  @Post(':id/cancel')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel an order and return its stock' })
  @ApiResponse({ status: 201, type: OrderResponseDto })
  @ApiResponse({ status: 403, description: 'Too late to cancel; contact support' })
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.ordersService.cancel(id, actor, dto.reason);
  }
}
