import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { isStrongPassword } from 'class-validator';
import { Model } from 'mongoose';

import { notDeleted } from '../../common/schemas/base.schema';
import { SeedConfig } from '../../config/configuration';
import { UserRole } from './enums/user-role.enum';
import { User, UserDocument } from './schemas/user.schema';

export type AdminSeedOutcome = 'created' | 'exists' | 'skipped';

/**
 * Creates the store's first administrator when the application starts on a
 * database that has none.
 *
 * Registration only ever creates customers, so this is the one way an ADMIN
 * comes into being — from SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD and
 * SEED_ADMIN_NAME. Once any administrator exists it does nothing at all: it
 * never resets a password, never recreates an admin who was replaced, and never
 * promotes a customer who happens to have registered with the same address.
 */
@Injectable()
export class AdminSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminSeedService.name);

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // The test suite creates the users it needs; an administrator appearing
    // behind its back would break assertions about who exists.
    if (this.config.getOrThrow<string>('app.env') === 'test') return;
    await this.ensureAdmin();
  }

  async ensureAdmin(): Promise<AdminSeedOutcome> {
    // Wait for the schema's indexes — the unique email among them — so two
    // instances starting together cannot both create the account.
    await this.userModel.init();

    if (await this.userModel.exists({ role: UserRole.ADMIN, ...notDeleted })) return 'exists';

    const { adminEmail, adminPassword, adminName } = this.config.getOrThrow<SeedConfig>('seed');

    if (!adminEmail || !adminPassword) {
      const message =
        'No administrator exists and SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD are not set, ' +
        'so nobody can sign in to the dashboard';
      // A production store nobody can administer is worse than one that does
      // not start.
      if (this.config.getOrThrow<string>('app.env') === 'production') throw new Error(message);
      this.logger.warn(message);
      return 'skipped';
    }

    // The same rule customers' passwords are held to.
    const strong = isStrongPassword(adminPassword, {
      minLength: 10,
      minLowercase: 1,
      minUppercase: 1,
      minNumbers: 1,
      minSymbols: 1,
    });
    if (!strong) {
      throw new Error(
        'SEED_ADMIN_PASSWORD must be at least 10 characters with upper and lower case letters, ' +
          'a number and a symbol',
      );
    }

    if (await this.userModel.exists({ email: adminEmail, ...notDeleted })) {
      this.logger.error(
        `SEED_ADMIN_EMAIL ${adminEmail} already belongs to a customer account, so it was not ` +
          'made an administrator. Set a different address.',
      );
      return 'skipped';
    }

    const saltRounds = this.config.getOrThrow<number>('auth.passwordSaltRounds');
    try {
      await this.userModel.create({
        name: adminName,
        email: adminEmail,
        password: await bcrypt.hash(adminPassword, saltRounds),
        role: UserRole.ADMIN,
        isActive: true,
      });
    } catch (error) {
      // Another instance created it first.
      if (isDuplicateKey(error)) return 'exists';
      throw error;
    }

    this.logger.log(`Created administrator ${adminEmail}. Change this password after signing in.`);
    return 'created';
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
