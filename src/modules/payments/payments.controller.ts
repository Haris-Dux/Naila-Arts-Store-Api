import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { ValidationFailedException } from '../../common/exceptions/domain.exception';
import { SkipResponseWrap } from '../../common/decorators/skip-response-wrap.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { MinRole } from '../auth/decorators/roles.decorator';
import { AuthenticatedUser } from '../auth/types/authenticated-user';
import { UserRole } from '../users/enums/user-role.enum';
import {
  CapturePaymentDto,
  CreatePaymentDto,
  PaymentResponseDto,
  RefundPaymentDto,
} from './dto/payment.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * Provider callback.
   *
   * Public because the caller is a payment gateway, not a user — it holds no
   * token. Authenticity comes from the HMAC signature over the raw body, which
   * is why this route needs `req.rawBody`: re-serialising parsed JSON does not
   * reproduce the exact bytes the signature covers.
   */
  @Post('webhooks/:provider')
  @Public()
  @HttpCode(HttpStatus.OK)
  @SkipResponseWrap()
  // Higher than the storefront default: a gateway catching up after an outage
  // can burst, and rate-limiting it into failure would strand real payments.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiHeader({ name: 'X-Signature', required: true, description: 't=<unix>,v1=<hmac-sha256>' })
  @ApiOperation({ summary: 'Payment provider webhook' })
  @ApiResponse({ status: 200, description: 'Accepted (also returned for a duplicate delivery)' })
  @ApiResponse({ status: 401, description: 'Signature missing, invalid, or outside tolerance' })
  handleWebhook(
    @Param('provider') provider: string,
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-signature') signature?: string,
  ) {
    if (!request.rawBody) {
      throw new ValidationFailedException('A request body is required');
    }
    // Providers read the raw response, so the success envelope is skipped.
    return this.paymentsService.handleWebhook(provider, request.rawBody, signature);
  }

  /**
   * Public, because a guest confirming how they will pay has no token — only the
   * order id checkout just handed them. An order belonging to an account still
   * requires that account's token.
   */
  @Post()
  @Public()
  @ApiOperation({ summary: 'Start a payment for an order (guest or signed in)' })
  @ApiResponse({ status: 201, type: PaymentResponseDto })
  @ApiResponse({ status: 409, description: 'The order is not awaiting payment' })
  create(@Body() dto: CreatePaymentDto, @CurrentUser() actor?: AuthenticatedUser) {
    // No amount on the DTO — it is copied from the order.
    return this.paymentsService.create(dto, actor);
  }

  @Get(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a payment' })
  @ApiResponse({ status: 200, type: PaymentResponseDto })
  @ApiResponse({ status: 404, description: 'Not found, or not yours' })
  findOne(@Param('id') id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.paymentsService.findById(id, actor);
  }

  /** Guests read their payment status from `GET /orders/lookup` instead. */
  @Get('orders/:orderId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Payments against an order' })
  @ApiResponse({ status: 200, type: [PaymentResponseDto] })
  findForOrder(@Param('orderId') orderId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.paymentsService.findForOrder(orderId, actor);
  }

  /**
   * Confirm funds were received — for the manual provider, that a bank transfer
   * cleared. This is what moves the order to PAID.
   */
  @Post(':id/capture')
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Capture a payment (staff)' })
  @ApiResponse({ status: 201, type: PaymentResponseDto })
  @ApiResponse({ status: 409, description: 'Not capturable from its current status' })
  capture(
    @Param('id') id: string,
    @Body() dto: CapturePaymentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paymentsService.capture(id, actor, dto.note);
  }

  @Post(':id/refund')
  @MinRole(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Refund a captured payment, in full or in part (staff)' })
  @ApiResponse({ status: 201, type: PaymentResponseDto })
  @ApiResponse({ status: 400, description: 'More than the remaining balance' })
  refund(
    @Param('id') id: string,
    @Body() dto: RefundPaymentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paymentsService.refund(id, actor, dto.amount, dto.reason);
  }
}
