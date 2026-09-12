import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import {
  AuthenticationException,
  AuthorizationException,
} from '../../../common/exceptions/domain.exception';
import { UserRole, roleAtLeast } from '../../users/enums/user-role.enum';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Rank-based authorization, registered globally and inert on routes without
 * @MinRole.
 *
 * This replaces four overlapping guards in the old gateway (RolesGuard,
 * AdminGuard, SuperAdminGuard, OwnerOrRolesGuard), one of which decided
 * privilege by inspecting `request.method` and returned `true` for any verb it
 * did not recognise — which is how PATCH /orders/:id ended up unauthenticated.
 * Here an unrecognised state cannot mean "allow": the principal must exist and
 * out-rank the requirement.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const user = context.switchToHttp().getRequest<Request>().user;
    if (!user) throw new AuthenticationException('Authentication is required');

    if (!roleAtLeast(user.role, required)) {
      throw new AuthorizationException('You do not have permission to perform this action');
    }
    return true;
  }
}
