import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';

/**
 * The application's rate-limit guard.
 *
 * Identical to the stock ThrottlerGuard except that it stands down under
 * NODE_ENV=test. The e2e suite registers and logs in dozens of times in a few
 * seconds, which the credential tier's 10-per-minute ceiling correctly rejects —
 * so without this the limiter fails the suite rather than the suite testing the
 * application. Rate limiting is verified directly against a running instance.
 *
 * Done here rather than with `overrideGuard` in the test module because the
 * guard is registered through APP_GUARD, where the override does not apply.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  private readonly enabled: boolean;

  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    config: ConfigService,
  ) {
    super(options, storageService, reflector);
    this.enabled = config.getOrThrow<string>('app.env') !== 'test';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled) return true;
    return super.canActivate(context);
  }
}
