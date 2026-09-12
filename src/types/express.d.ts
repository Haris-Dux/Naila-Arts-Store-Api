import { AuthenticatedUser } from '../modules/auth/types/authenticated-user';

declare global {
  namespace Express {
    /**
     * Passport declares `Request.user?: Express.User` and leaves `User` empty for
     * applications to fill in. Augmenting `User` — rather than redeclaring
     * `Request.user` — is what makes `req.user` properly typed everywhere,
     * including inside guards and the @CurrentUser decorator.
     */
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging
    interface User extends AuthenticatedUser {}

    interface Request {
      /** Correlation id, assigned by pino-http (see LoggerModule config). */
      id?: string;
    }
  }
}

export {};
