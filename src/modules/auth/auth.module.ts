import { Module, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import type { SignOptions } from 'jsonwebtoken';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordResetService } from './password-reset.service';
import { PasswordResetCode, PasswordResetCodeSchema } from './schemas/password-reset-code.schema';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { OwnershipGuard } from './guards/ownership.guard';
import { RolesGuard } from './guards/roles.guard';
import { RefreshToken, RefreshTokenSchema } from './schemas/refresh-token.schema';
import { JwtStrategy } from './strategies/jwt.strategy';
import { TokenRevocationService } from './token-revocation.service';
import { TokenService } from './token.service';

@Module({
  imports: [
    forwardRef(() => UsersModule),
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    MongooseModule.forFeature([
      { name: RefreshToken.name, schema: RefreshTokenSchema },
      { name: PasswordResetCode.name, schema: PasswordResetCodeSchema },
    ]),
    // Reset codes and the password-changed confirmation go out as notifications.
    NotificationsModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('auth.jwtSecret'),
        signOptions: {
          // jsonwebtoken types this as the `ms` template-literal union; the value
          // is validated as a duration string by parseDuration wherever it is
          // also needed numerically.
          expiresIn: config.getOrThrow<string>('auth.accessTokenTtl') as SignOptions['expiresIn'],
          // Pinned so a token minted for another system with the same secret
          // cannot be replayed here.
          issuer: 'store',
          audience: 'store-api',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordResetService,
    TokenService,
    TokenRevocationService,
    JwtStrategy,

    /**
     * Guards are global and ordered: authenticate, then check rank, then check
     * ownership.
     *
     * Registering them globally is the structural fix for the old gateway's
     * worst bug — authorization was opt-in per controller, and `PATCH
     * /orders/:id` simply forgot to list JwtAuthGuard, shipping an anonymous
     * write endpoint. Here a route is closed unless it says @Public().
     */
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: OwnershipGuard },
  ],
  exports: [AuthService, TokenService, TokenRevocationService],
})
export class AuthModule {}
