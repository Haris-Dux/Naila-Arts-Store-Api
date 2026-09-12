import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { AuthenticatedUser } from '../types/authenticated-user';
import { IS_PUBLIC } from '../decorators/public.decorator';

/**
 * Registered globally, so every route requires a valid access token unless it
 * carries @Public().
 *
 * On a @Public() route the strategy still runs, but a failure is not fatal:
 * `req.user` is populated when a valid token is present and left undefined
 * otherwise. That "optional authentication" is what lets one endpoint serve both
 * audiences — an anonymous shopper browsing the catalogue and an administrator
 * who should also see unpublished drafts — without a second route or a second
 * guard.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false
    );
  }

  /**
   * Passport calls this with the strategy's outcome. Returning a value assigns
   * it to `req.user`; throwing rejects the request.
   */
  handleRequest<TUser = AuthenticatedUser>(
    err: Error | null,
    user: TUser | false,
    info: unknown,
    context: ExecutionContext,
    status?: unknown,
  ): TUser {
    if (this.isPublic(context)) {
      // Anonymous, expired, or malformed — all fine here. The route decides what
      // an unauthenticated viewer may see.
      return (user || undefined) as TUser;
    }
    return super.handleRequest(err, user, info, context, status);
  }
}
