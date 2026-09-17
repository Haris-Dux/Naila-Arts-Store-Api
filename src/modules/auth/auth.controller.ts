import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { RegisterDto } from '../users/dto/register.dto';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RefreshDto,
  ResetPasswordDto,
} from './dto/auth.dto';
import { PasswordResetService } from './password-reset.service';
import { ClientContext } from './token.service';
import { AuthenticatedUser } from './types/authenticated-user';

/** Credential endpoints get a much tighter ceiling than the storefront default. */
const CREDENTIAL_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  private static clientContext(req: Request): ClientContext {
    return {
      userAgent: req.headers['user-agent'] ?? null,
      ip: req.ip ?? null,
    };
  }

  @Post('register')
  @Public()
  @Throttle(CREDENTIAL_THROTTLE)
  @ApiOperation({ summary: 'Create an account and sign in' })
  @ApiResponse({ status: 201, description: 'Account created; returns the user and a token pair' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    // The role is not a parameter anywhere in this path — it is always USER.
    return this.authService.register(dto, AuthController.clientContext(req));
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(CREDENTIAL_THROTTLE)
  @ApiOperation({ summary: 'Sign in' })
  @ApiResponse({ status: 200, description: 'Returns the user and a token pair' })
  @ApiResponse({ status: 401, description: 'Invalid credentials or deactivated account' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, AuthController.clientContext(req));
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(CREDENTIAL_THROTTLE)
  @ApiOperation({ summary: 'Exchange a refresh token for a new pair' })
  @ApiResponse({ status: 200, description: 'Returns a new token pair; the old one is now spent' })
  @ApiResponse({ status: 401, description: 'Token invalid, expired, or already used' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.authService.refresh(dto.refreshToken, AuthController.clientContext(req));
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'End the current session' })
  @ApiResponse({ status: 200, description: 'Signed out' })
  async logout(@Body() dto: RefreshDto): Promise<{ message: string }> {
    await this.authService.logout(dto.refreshToken);
    return { message: 'Signed out.' };
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'End every session on every device' })
  logoutEverywhere(@CurrentUser('id') userId: string) {
    return this.authService.logoutEverywhere(userId);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @Throttle(CREDENTIAL_THROTTLE)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change password; revokes all existing sessions' })
  @ApiResponse({ status: 200, description: 'Password changed' })
  @ApiResponse({ status: 401, description: 'Current password is incorrect' })
  async changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    await this.authService.changePassword(userId, dto);
    return { message: 'Password changed. Please sign in again on your other devices.' };
  }

  @Post('forgot-password')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(CREDENTIAL_THROTTLE)
  @ApiOperation({ summary: 'Email a 6-digit password reset code (customers only)' })
  @ApiResponse({
    status: 202,
    description: 'Always returned, whether or not the email belongs to an account',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.passwordReset.request(dto.email);
    // The same words for everyone: the response must not reveal who has an account.
    return { message: 'If an account exists for that email, a reset code is on its way.' };
  }

  @Post('reset-password')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle(CREDENTIAL_THROTTLE)
  @ApiOperation({ summary: 'Set a new password with the emailed code; signs out every session' })
  @ApiResponse({ status: 200, description: 'Password changed' })
  @ApiResponse({ status: 400, description: 'INVALID_RESET_CODE — invalid or expired code' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    await this.passwordReset.reset(dto.email, dto.code, dto.newPassword);
    return { message: 'Password reset. You can now sign in with your new password.' };
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The authenticated user' })
  @ApiResponse({ status: 200, type: UserResponseDto })
  me(@CurrentUser() user: AuthenticatedUser) {
    // A read, not a token mint. The old `/auth/me` re-signed a fresh 1-day token
    // from a still-valid one, which meant a leaked token could be renewed
    // indefinitely and never had to pass through a revocation check.
    return this.usersService.findById(user.id);
  }
}
