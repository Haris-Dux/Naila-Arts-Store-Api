import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import {
  AuthenticationException,
  AuthorizationException,
} from '../../../common/exceptions/domain.exception';
import { roleAtLeast } from '../../users/enums/user-role.enum';
import { OWNERSHIP_KEY, OwnershipOptions } from '../decorators/owner-or-role.decorator';

/**
 * Allows the resource owner, or anyone at or above a fallback role.
 *
 * Ownership is decided by comparing the authenticated id with a route parameter,
 * with `me` as an explicit alias for "my own record" so clients never need to
 * interpolate their own id into a URL.
 */
@Injectable()
export class OwnershipGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<OwnershipOptions | undefined>(OWNERSHIP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;
    if (!user) throw new AuthenticationException('Authentication is required');

    const target = request.params[options.param];

    // `me` resolves to the caller. Rewriting the param here means downstream
    // handlers only ever see a concrete id.
    if (target === 'me') {
      request.params[options.param] = user.id;
      return true;
    }

    if (target === user.id) return true;
    if (options.fallbackRole && roleAtLeast(user.role, options.fallbackRole)) return true;

    // Deliberately the same message and status whether the resource is someone
    // else's or does not exist, so this cannot be used to enumerate ids.
    throw new AuthorizationException('You do not have permission to access this resource');
  }
}
