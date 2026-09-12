import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../types/authenticated-user';

/**
 * Injects the authenticated principal.
 *
 * Every handler that acts on behalf of a user takes it from here, never from the
 * request body. That is the fix for orders being created with a body-supplied
 * `userId`, which let one account place orders on another's behalf.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const user = request.user;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);
