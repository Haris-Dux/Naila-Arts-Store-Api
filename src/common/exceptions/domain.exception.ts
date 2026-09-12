import { HttpStatus } from '@nestjs/common';

/**
 * Base class for errors the domain raises deliberately.
 *
 * Domain code throws these instead of HTTP exceptions so services stay transport
 * agnostic; `AllExceptionsFilter` maps them to status codes at the edge. The old
 * stack threw bare objects through `throwError()`, which the gateway's
 * `@Catch(HttpException)` filter never matched — so every 404 and 403 reached the
 * client as a 500.
 */
export abstract class DomainException extends Error {
  abstract readonly status: HttpStatus;
  /** Stable machine-readable code for clients. */
  abstract readonly code: string;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ResourceNotFoundException extends DomainException {
  readonly status = HttpStatus.NOT_FOUND;
  readonly code = 'RESOURCE_NOT_FOUND';

  constructor(resource: string, id?: string | number) {
    super(id === undefined ? `${resource} not found` : `${resource} ${id} not found`, {
      resource,
      id,
    });
  }
}

export class ValidationFailedException extends DomainException {
  readonly status = HttpStatus.BAD_REQUEST;
  readonly code = 'VALIDATION_FAILED';
}

/** The request is well-formed but conflicts with current state. */
export class ConflictException extends DomainException {
  readonly status = HttpStatus.CONFLICT;
  readonly code = 'CONFLICT';
}

/** A state machine transition that is not allowed from the current state. */
export class InvalidStateTransitionException extends DomainException {
  readonly status = HttpStatus.CONFLICT;
  readonly code = 'INVALID_STATE_TRANSITION';

  constructor(entity: string, from: string, to: string) {
    super(`${entity} cannot move from ${from} to ${to}`, { entity, from, to });
  }
}

export class InsufficientStockException extends DomainException {
  readonly status = HttpStatus.CONFLICT;
  readonly code = 'INSUFFICIENT_STOCK';

  constructor(productId: string, requested: number, available: number) {
    super(`Insufficient stock: requested ${requested}, ${available} available`, {
      productId,
      requested,
      available,
    });
  }
}

export class AuthenticationException extends DomainException {
  readonly status = HttpStatus.UNAUTHORIZED;
  readonly code = 'UNAUTHENTICATED';
}

export class AuthorizationException extends DomainException {
  readonly status = HttpStatus.FORBIDDEN;
  readonly code = 'FORBIDDEN';
}
