import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Observable, map } from 'rxjs';
import { SKIP_RESPONSE_WRAP } from '../decorators/skip-response-wrap.decorator';

export interface ApiResponse<T> {
  success: true;
  timestamp: string;
  requestId?: string;
  data: T;
}

/**
 * Wraps successful responses in a stable envelope matching the error shape
 * produced by AllExceptionsFilter, so clients can branch on `success` alone.
 *
 * Routes that must return a raw body (payment-provider webhooks, health checks
 * consumed by orchestrators, file downloads) opt out with @SkipResponseWrap().
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T> | T> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RESPONSE_WRAP, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return next.handle();

    const requestId = context.switchToHttp().getRequest<Request>().id as string | undefined;

    return next.handle().pipe(
      map((data) => ({
        success: true as const,
        timestamp: new Date().toISOString(),
        requestId,
        data,
      })),
    );
  }
}
