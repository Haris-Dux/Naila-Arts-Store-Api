import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthenticationException } from '../../common/exceptions/domain.exception';
import { EVENTS, UserAuthenticatedEvent } from '../../events/domain-events';
import { RegisterDto } from '../users/dto/register.dto';
import { UserRole } from '../users/enums/user-role.enum';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { UserDocument } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { ChangePasswordDto, LoginDto } from './dto/auth.dto';
import { ClientContext, TokenService } from './token.service';
import { TokenRevocationService } from './token-revocation.service';
import { TokenPair } from './types/token-payload';

export interface AuthResult {
  user: UserResponseDto;
  tokens: TokenPair;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly tokenService: TokenService,
    private readonly revocation: TokenRevocationService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async register(dto: RegisterDto, client: ClientContext): Promise<AuthResult> {
    const created = await this.usersService.register(dto);
    const user = await this.usersService.findActiveById(created.id);
    if (!user) throw new AuthenticationException('Registration failed');

    const tokens = await this.tokenService.issuePair(user, client);
    await this.announceAuthentication(created.id, created.email, created.role);
    return { user: created, tokens };
  }

  /**
   * Authenticate and issue a token pair.
   *
   * One credential lookup and one bcrypt comparison. The old flow called
   * `validateUser` from the controller and then `login`, each of which fetched
   * the user and ran bcrypt — so every login did the work twice.
   */
  async login(dto: LoginDto, client: ClientContext): Promise<AuthResult> {
    const user = await this.usersService.findByEmailWithPassword(dto.email);

    // Compare against a dummy hash when the account is missing, so a request for
    // an unknown address takes the same time as one for a known address. Without
    // this, response timing distinguishes registered emails.
    const hash = user?.password ?? DUMMY_HASH;
    const passwordMatches = await this.usersService.verifyPassword(dto.password, hash);

    if (!user || !passwordMatches) {
      // One message for both cases: revealing which half failed is an account
      // enumeration oracle.
      throw new AuthenticationException('Invalid email or password');
    }

    if (!user.isActive) {
      throw new AuthenticationException('This account has been deactivated');
    }

    await this.usersService.recordLogin(user._id.toString());

    const tokens = await this.tokenService.issuePair(user, client);
    await this.announceAuthentication(user._id.toString(), user.email, user.role);

    return { user: UserResponseDto.fromDocument(user), tokens };
  }

  /**
   * Publish `user.authenticated`, awaited so any listener finishes before the
   * response is written rather than racing the client's next request.
   *
   * A listener failure is logged, never propagated: nothing that reacts to a
   * successful login may retroactively fail it. Nothing subscribes today — the
   * guest-cart merge was the last subscriber — but the emit is the seam login
   * side effects are meant to hang off, so it stays.
   */
  private async announceAuthentication(
    userId: string,
    email: string,
    role: UserRole,
  ): Promise<void> {
    const event: UserAuthenticatedEvent = {
      userId,
      email,
      role,
    };

    try {
      await this.eventEmitter.emitAsync(EVENTS.USER_AUTHENTICATED, event);
    } catch (error) {
      this.logger.error(
        `user.authenticated listener failed for ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Rotate a refresh token. Reuse of a spent token revokes the whole family. */
  async refresh(refreshToken: string, client: ClientContext): Promise<TokenPair> {
    return this.tokenService.consumeAndRotate(
      refreshToken,
      async (userId): Promise<UserDocument | null> => {
        const user = await this.usersService.findActiveById(userId);
        if (!user) return null;
        // Catches a revocation whose Redis entry has already expired: the token
        // was minted before the version was bumped.
        return user;
      },
      client,
    );
  }

  /** End one session. */
  async logout(refreshToken: string): Promise<void> {
    await this.tokenService.revokeToken(refreshToken);
  }

  /** End every session for this user, on every device. */
  async logoutEverywhere(userId: string): Promise<{ sessionsRevoked: number }> {
    const version = await this.usersService.bumpTokenVersion(userId);
    await this.revocation.revokeBelow(userId, version);
    const sessionsRevoked = await this.tokenService.revokeAllForUser(userId, 'logout-everywhere');

    this.logger.log(`Revoked ${sessionsRevoked} session(s) for user ${userId}`);
    return { sessionsRevoked };
  }

  /**
   * Change a password after verifying the current one, then drop every existing
   * session — a password change that leaves old sessions alive is not a
   * password change.
   */
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.usersService.findActiveById(userId);
    if (!user) throw new AuthenticationException('Account is no longer active');

    const withPassword = await this.usersService.findByEmailWithPassword(user.email);
    if (!withPassword) throw new AuthenticationException('Account is no longer active');

    const matches = await this.usersService.verifyPassword(
      dto.currentPassword,
      withPassword.password,
    );
    if (!matches) throw new AuthenticationException('Current password is incorrect');

    // setPassword hashes and bumps tokenVersion.
    await this.usersService.setPassword(userId, dto.newPassword);
    await this.endSessionsAfterPasswordChange(userId, 'password-changed');
  }

  /**
   * End every session once a password has been replaced — by a customer who
   * knew the old one, or through a reset code.
   *
   * `setPassword` has already bumped `tokenVersion`; this publishes that floor so
   * outstanding access tokens stop working now rather than at expiry, and
   * revokes the refresh tokens that would otherwise mint new ones. One method
   * for both paths, so a reset can never end fewer sessions than a change.
   */
  async endSessionsAfterPasswordChange(userId: string, reason: string): Promise<void> {
    const refreshed = await this.usersService.findActiveById(userId);
    if (refreshed) await this.revocation.revokeBelow(userId, refreshed.tokenVersion);
    await this.tokenService.revokeAllForUser(userId, reason);
  }

  /** Publish a revocation floor after an admin changed a role or deactivated an account. */
  async propagateRevocation(userId: string): Promise<void> {
    const user = await this.usersService.findActiveById(userId);
    const version = user?.tokenVersion;
    if (typeof version === 'number') {
      await this.revocation.revokeBelow(userId, version);
    }
    await this.tokenService.revokeAllForUser(userId, 'account-modified');
  }
}

/**
 * A real bcrypt hash of a value nothing will ever submit. Used only to keep the
 * failure path's timing indistinguishable from the success path's.
 */
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.9pQ5Yy0mLR7ZY1QSJ5xVQ7YyQ1QSJ5x';
