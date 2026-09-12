import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
// The driver's types through mongoose, not a separate `mongodb` install: that
// is the driver actually throwing these errors, so the two can never differ.
import { Error as MongooseError, mongo } from 'mongoose';
import { DomainException } from '../exceptions/domain.exception';

interface ErrorBody {
  success: false;
  timestamp: string;
  path: string;
  requestId?: string;
  code: string;
  message: string;
  details?: unknown;
}

/**
 * The single exception filter for the application. Catches everything — the old
 * gateway only caught `HttpException`, so domain errors fell through to Nest's
 * default handler and became opaque 500s.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly isProduction: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, code, message, details } = this.normalize(exception);

    const body: ErrorBody = {
      success: false,
      timestamp: new Date().toISOString(),
      path: request.url,
      requestId: request.id as string | undefined,
      code,
      message,
      ...(details === undefined ? {} : { details }),
    };

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status} ${code}: ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} → ${status} ${code}: ${message}`);
    }

    response.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  } {
    if (exception instanceof DomainException) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'object' && payload !== null) {
        const record = payload as Record<string, unknown>;
        // class-validator failures arrive as { message: string[], error, statusCode }
        const validationMessages = Array.isArray(record.message) ? record.message : undefined;
        return {
          status,
          code: validationMessages ? 'VALIDATION_FAILED' : this.codeFromStatus(status),
          message: validationMessages
            ? 'Request validation failed'
            : ((record.message as string) ?? exception.message),
          details: validationMessages,
        };
      }

      return { status, code: this.codeFromStatus(status), message: String(payload) };
    }

    if (exception instanceof MongooseError.ValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        details: Object.values(exception.errors).map((e) => e.message),
      };
    }

    if (exception instanceof MongooseError.CastError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'INVALID_IDENTIFIER',
        message: `Malformed value for "${exception.path}"`,
      };
    }

    // Duplicate key on a unique index — e.g. registering an existing email, or a
    // replayed Idempotency-Key. Surfaces as 409, not 500.
    if (this.isMongoServerError(exception) && exception.code === 11000) {
      const keyPattern = (exception.keyPattern ?? {}) as Record<string, unknown>;
      const field = Object.keys(keyPattern)[0] ?? 'value';
      return {
        status: HttpStatus.CONFLICT,
        code: 'DUPLICATE_KEY',
        message: `A record with this ${field} already exists`,
        details: { field },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      // Never leak internals to clients in production.
      message: this.isProduction
        ? 'An unexpected error occurred'
        : exception instanceof Error
          ? exception.message
          : String(exception),
    };
  }

  private isMongoServerError(e: unknown): e is mongo.MongoServerError {
    return e instanceof Error && e.name === 'MongoServerError';
  }

  private codeFromStatus(status: number): string {
    return (
      {
        [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
        [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
        [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
        [HttpStatus.NOT_FOUND]: 'RESOURCE_NOT_FOUND',
        [HttpStatus.CONFLICT]: 'CONFLICT',
        [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
      }[status] ?? 'ERROR'
    );
  }
}
