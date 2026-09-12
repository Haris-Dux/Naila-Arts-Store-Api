import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { DomainException } from '../../common/exceptions/domain.exception';
import { NotificationsService } from '../notifications/notifications.service';
import { UserRole } from '../users/enums/user-role.enum';
import { UserDocument } from '../users/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { PasswordResetCode, PasswordResetCodeDocument } from './schemas/password-reset-code.schema';

/** How long an emailed code stays usable. */
export const RESET_CODE_TTL_MINUTES = 10;

/** Wrong guesses one code survives. */
export const MAX_RESET_ATTEMPTS = 5;

/** Minimum gap between two codes for the same account. */
export const RESET_RESEND_COOLDOWN_MS = 60_000;

/** Codes one account can be sent in an hour. */
export const MAX_RESET_CODES_PER_HOUR = 5;

const HOUR_MS = 60 * 60_000;

/**
 * The single answer to every failed reset: wrong, expired, used or locked code,
 * or an email with no customer behind it.
 *
 * Telling those apart would let anyone probe which emails have accounts and how
 * many guesses a code has left.
 */
export class InvalidResetCodeException extends DomainException {
  readonly status = HttpStatus.BAD_REQUEST;
  readonly code = 'INVALID_RESET_CODE';

  constructor() {
    super('The code is invalid or has expired');
  }
}

/**
 * "Forgot password" for customers, by a six-digit code sent to their email.
 *
 * Every rule that makes this safe is enforced by the database write itself, not
 * by a read followed by a write, so concurrent requests cannot slip past it:
 *
 *  - a guess is counted *before* the comparison, atomically, so ten parallel
 *    guesses spend exactly the five a code allows;
 *  - a matching code is consumed with a conditional update, so two parallel
 *    resets with the same code produce exactly one new password;
 *  - a new code is issued conditionally on the code it replaces, so two parallel
 *    requests send one email, not two.
 *
 * Staff accounts cannot reset this way. They are not customers, and a code
 * emailed to an admin mailbox is a takeover route into the dashboard.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private readonly key: Buffer;
  private readonly locale: string;

  constructor(
    @InjectModel(PasswordResetCode.name)
    private readonly codeModel: Model<PasswordResetCodeDocument>,
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly notifications: NotificationsService,
    config: ConfigService,
  ) {
    // A key of its own, derived from JWT_SECRET rather than being it: the token
    // signing key is never used directly for anything else.
    this.key = createHmac('sha256', config.getOrThrow<string>('auth.jwtSecret'))
      .update('password-reset-code')
      .digest();
    this.locale = config.getOrThrow<string>('store.locale');
  }

  /**
   * Email a reset code, if this is a customer who may have one.
   *
   * Resolves the same way whatever happened — no account, a staff account, a
   * deactivated one, a cool-down or the hourly limit — so the endpoint cannot be
   * used to discover who is registered.
   */
  async request(email: string): Promise<void> {
    const user = await this.findCustomer(email);
    if (!user) return;

    const userId = user._id;
    const now = Date.now();
    const current = await this.codeModel.findOne({ userId }).lean().exec();

    // Inside the cool-down nothing is sent, and the code already in the
    // customer's inbox keeps working.
    if (current && now - current.lastSentAt.getTime() < RESET_RESEND_COOLDOWN_MS) return;

    const windowOpen = !!current && now - current.windowStartedAt.getTime() < HOUR_MS;
    const sentInWindow = current && windowOpen ? current.sendsInWindow : 0;
    if (sentInWindow >= MAX_RESET_CODES_PER_HOUR) return;

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const issueId = randomBytes(8).toString('hex');
    const next = {
      codeHash: this.hash(userId, code),
      issueId,
      expiresAt: new Date(now + RESET_CODE_TTL_MINUTES * 60_000),
      attempts: 0,
      consumedAt: null,
      lastSentAt: new Date(now),
      windowStartedAt: current && windowOpen ? current.windowStartedAt : new Date(now),
      sendsInWindow: sentInWindow + 1,
      purgeAt: new Date(now + HOUR_MS),
    };

    // Conditional on the code being replaced (or on there being none), so of two
    // simultaneous requests only one issues a code.
    const issued = current
      ? (
          await this.codeModel
            .updateOne({ _id: current._id, issueId: current.issueId }, { $set: next })
            .exec()
        ).modifiedCount === 1
      : await this.codeModel.create({ userId, ...next }).then(
          () => true,
          (error: unknown) => {
            if (isDuplicateKey(error)) return false;
            throw error;
          },
        );
    if (!issued) return;

    try {
      await this.notifications.enqueue(
        {
          kind: 'passwordResetCode',
          dedupeKey: `passwordResetCode:${userId.toString()}:${issueId}`,
          recipient: user.email,
          recipientName: user.name,
          userId: userId.toString(),
          locale: this.locale,
          data: { code, expiresInMinutes: RESET_CODE_TTL_MINUTES },
        },
        { sensitive: true },
      );
    } catch (error) {
      // The email could not be queued. Withdraw the code so the customer can ask
      // again straight away, instead of being held by a cool-down for an email
      // that is never coming.
      await this.codeModel
        .updateOne(
          { userId, issueId },
          { $set: { expiresAt: new Date(0), lastSentAt: new Date(0) } },
        )
        .exec();
      this.logger.error(
        `Could not send a password reset code to user ${userId.toString()}: ${asMessage(error)}`,
      );
    }
  }

  /**
   * Set a new password with an emailed code.
   *
   * Every failure is the same InvalidResetCodeException. On success every
   * session is ended and a confirmation email is sent, so the real owner hears
   * about a reset they did not ask for.
   */
  async reset(email: string, code: string, newPassword: string): Promise<void> {
    const user = await this.findCustomer(email);
    if (!user) throw new InvalidResetCodeException();

    const userId = user._id;

    // Spend a guess first; compare second. Counting after the comparison would
    // let a burst of parallel guesses all read "attempts: 0" and all be tried.
    const record = await this.codeModel
      .findOneAndUpdate(
        {
          userId,
          consumedAt: null,
          expiresAt: { $gt: new Date() },
          attempts: { $lt: MAX_RESET_ATTEMPTS },
        },
        { $inc: { attempts: 1 } },
        { new: true },
      )
      .lean()
      .exec();

    if (!record || !this.matches(record.codeHash, userId, code)) {
      throw new InvalidResetCodeException();
    }

    // Consume before changing the password: if anything below fails, the code
    // is already spent rather than left reusable. `issueId` in the filter stops
    // this consuming a newer code issued since the guess was counted.
    const consumed = await this.codeModel
      .updateOne(
        { _id: record._id, issueId: record.issueId, consumedAt: null },
        { $set: { consumedAt: new Date() } },
      )
      .exec();
    if (consumed.modifiedCount !== 1) throw new InvalidResetCodeException();

    await this.usersService.setPassword(userId.toString(), newPassword);
    await this.authService.endSessionsAfterPasswordChange(userId.toString(), 'password-reset');

    try {
      await this.notifications.enqueue({
        kind: 'passwordChanged',
        dedupeKey: `passwordChanged:${userId.toString()}:${record.issueId}`,
        recipient: user.email,
        recipientName: user.name,
        userId: userId.toString(),
        locale: this.locale,
        data: {},
      });
    } catch (error) {
      // The password has changed; failing the request now would tell the
      // customer it had not.
      this.logger.error(
        `Could not send the password-changed email to user ${userId.toString()}: ${asMessage(error)}`,
      );
    }
  }

  /** An active customer account for this email, or null for anyone else. */
  private async findCustomer(email: string): Promise<UserDocument | null> {
    const user = await this.usersService.findByEmailWithPassword(email);
    return user && user.isActive && user.role === UserRole.USER ? user : null;
  }

  private hash(userId: Types.ObjectId, code: string): string {
    return createHmac('sha256', this.key).update(`${userId.toString()}:${code}`).digest('hex');
  }

  private matches(stored: string, userId: Types.ObjectId, code: string): boolean {
    const expected = Buffer.from(this.hash(userId, code), 'hex');
    const actual = Buffer.from(stored, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
