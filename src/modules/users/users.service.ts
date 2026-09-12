import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { FilterQuery, Model, Types } from 'mongoose';
import { Page } from '../../common/dto/pagination.dto';
import {
  AuthorizationException,
  ConflictException,
  ResourceNotFoundException,
  ValidationFailedException,
} from '../../common/exceptions/domain.exception';
import { notDeleted } from '../../common/schemas/base.schema';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { ListUsersDto } from './dto/list-users.dto';
import { RegisterDto } from './dto/register.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UserRole, roleAtLeast } from './enums/user-role.enum';
import { User, UserDocument } from './schemas/user.schema';
import { UserProfileCacheService } from './user-profile-cache.service';

@Injectable()
export class UsersService {
  private readonly saltRounds: number;

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly profiles: UserProfileCacheService,
    config: ConfigService,
  ) {
    this.saltRounds = config.getOrThrow<number>('auth.passwordSaltRounds');
  }

  // ---------------------------------------------------------------- creation

  /**
   * Register a new account. The role is always USER — it is not a parameter, so
   * there is no code path by which a caller can influence it.
   */
  async register(dto: RegisterDto): Promise<UserResponseDto> {
    const existing = await this.userModel.exists({ email: dto.email, ...notDeleted });
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const user = await this.userModel.create({
      name: dto.name,
      email: dto.email,
      password: await this.hashPassword(dto.password),
      birthdate: dto.birthdate ? new Date(dto.birthdate) : null,
      role: UserRole.USER,
      isActive: true,
      tokenVersion: 0,
    });

    return UserResponseDto.fromDocument(user);
  }

  // ------------------------------------------------------------------- reads

  /**
   * One account's profile — served from the cache, which every write that
   * changes the profile retires (`update`, `adminUpdate`, `remove`).
   */
  async findById(id: string): Promise<UserResponseDto> {
    // Checked before the cache, so a malformed id never becomes a key; and
    // canonicalised, so the same account cannot be cached twice under two
    // spellings of its id with only one of them retired on the next edit.
    if (!Types.ObjectId.isValid(id)) throw new ResourceNotFoundException('User', id);
    const userId = new Types.ObjectId(id).toHexString();

    const cached = await this.profiles.lookup<UserResponseDto>(userId);
    if (cached.value) return cached.value;

    const profile = UserResponseDto.fromDocument(await this.getDocumentOrThrow(userId));
    await cached.save(profile);
    return profile;
  }

  /**
   * Returns the document *including* the password hash. The `+password` opt-in is
   * required because the field is `select: false`.
   *
   * Only the auth service may call this, and it must never let the result reach
   * a response — it maps through UserResponseDto first.
   */
  async findByEmailWithPassword(email: string): Promise<UserDocument | null> {
    return this.userModel
      .findOne({ email: email.trim().toLowerCase(), ...notDeleted })
      .select('+password')
      .exec();
  }

  /** Minimal lookup used when rotating a refresh token. */
  async findActiveById(id: string): Promise<UserDocument | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.userModel.findOne({ _id: id, isActive: true, ...notDeleted }).exec();
  }

  async list(query: ListUsersDto): Promise<Page<UserResponseDto>> {
    const filter: FilterQuery<UserDocument> = { ...notDeleted };

    if (query.role) filter.role = query.role;
    if (query.isActive !== undefined) filter.isActive = query.isActive;
    if (query.search) {
      // Escape regex metacharacters so a search term cannot alter the pattern
      // or trigger catastrophic backtracking.
      const safe = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { email: { $regex: safe, $options: 'i' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.userModel
        .find(filter)
        .sort({ [query.sort]: query.order === 'asc' ? 1 : -1 })
        .skip(query.skip)
        .limit(query.limit)
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);

    return Page.of(items.map(UserResponseDto.fromDocument), total, query.page, query.limit);
  }

  // ----------------------------------------------------------------- updates

  /**
   * Profile update. `UpdateUserDto` cannot carry role, isActive or password.
   *
   * The ownership check is not redundant with the route guard: the service must
   * hold on its own, without depending on a controller decorator being present.
   */
  async update(
    id: string,
    dto: UpdateUserDto,
    actor: { id: string; role: UserRole },
  ): Promise<UserResponseDto> {
    const user = await this.getDocumentOrThrow(id);
    this.assertMayModify(actor, user);

    await this.applyProfileFields(user, dto);
    await user.save();
    await this.profiles.invalidate(user._id.toString());
    return UserResponseDto.fromDocument(user);
  }

  /**
   * Privileged update: role and active status. Guarded so the dashboard cannot
   * be locked out by demoting or deactivating the last administrator.
   */
  async adminUpdate(
    id: string,
    dto: AdminUpdateUserDto,
    actor: { id: string; role: UserRole },
  ): Promise<{ user: UserResponseDto; sessionsRevoked: boolean }> {
    const user = await this.getDocumentOrThrow(id);

    let sessionsRevoked = false;

    if (dto.role !== undefined && dto.role !== user.role) {
      this.assertMayAssignRole(actor.role, dto.role);
      // Changing someone's own rank must not leave them holding a token that
      // still asserts the old one.
      this.assertMayModify(actor, user);
      await this.assertNotLastAdmin(user, dto.role);
      user.role = dto.role;
      user.tokenVersion += 1;
      sessionsRevoked = true;
    }

    if (dto.isActive !== undefined && dto.isActive !== user.isActive) {
      this.assertMayModify(actor, user);
      if (!dto.isActive) await this.assertNotLastAdmin(user, UserRole.USER);
      user.isActive = dto.isActive;
      // A deactivated account must lose its live sessions immediately.
      if (!dto.isActive) {
        user.tokenVersion += 1;
        sessionsRevoked = true;
      }
    }

    await this.applyProfileFields(user, dto);
    await user.save();
    // Role and active status are both on the profile.
    await this.profiles.invalidate(user._id.toString());

    return { user: UserResponseDto.fromDocument(user), sessionsRevoked };
  }

  /**
   * Replace a password, hashing it.
   *
   * The old update path spread the submitted body onto the entity, so a password
   * supplied through it was written in clear text — and login then failed for
   * that account, because the stored value was no longer a hash.
   */
  async setPassword(id: string, plaintext: string): Promise<void> {
    const user = await this.getDocumentOrThrow(id);
    user.password = await this.hashPassword(plaintext);
    // Every existing session dies with the old password.
    user.tokenVersion += 1;
    await user.save();
  }

  /** Invalidate every access token issued for this user so far. */
  async bumpTokenVersion(id: string): Promise<number> {
    const user = await this.userModel
      .findOneAndUpdate({ _id: id, ...notDeleted }, { $inc: { tokenVersion: 1 } }, { new: true })
      .exec();
    if (!user) throw new ResourceNotFoundException('User', id);
    return user.tokenVersion;
  }

  async recordLogin(id: string): Promise<void> {
    await this.userModel.updateOne({ _id: id }, { $set: { lastLoginAt: new Date() } }).exec();
  }

  // ----------------------------------------------------------------- removal

  /**
   * Soft delete. The record is retained because orders reference it and, once the
   * ERP integration lands, it will hold an external identity mapping that must
   * not silently disappear.
   */
  async remove(id: string, actor: { id: string; role: UserRole }): Promise<void> {
    const user = await this.getDocumentOrThrow(id);
    this.assertMayModify(actor, user);
    await this.assertNotLastAdmin(user, UserRole.USER);

    user.deletedAt = new Date();
    user.isActive = false;
    user.tokenVersion += 1;
    // Free the address for re-registration; the partial unique index is scoped
    // to live documents, but keeping the original would still be confusing.
    user.email = `${user.email}.deleted.${Date.now()}`;
    await user.save();
    // A deleted account must stop resolving at once, not a day later.
    await this.profiles.invalidate(user._id.toString());
  }

  // ------------------------------------------------------------------ shared

  async verifyPassword(plaintext: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plaintext, hash);
  }

  private async hashPassword(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, this.saltRounds);
  }

  private async getDocumentOrThrow(id: string): Promise<UserDocument> {
    // Guard before querying: an arbitrary string would otherwise raise a
    // Mongoose CastError, which reads as a server fault rather than a bad id.
    if (!Types.ObjectId.isValid(id)) throw new ResourceNotFoundException('User', id);

    const user = await this.userModel.findOne({ _id: id, ...notDeleted }).exec();
    if (!user) throw new ResourceNotFoundException('User', id);
    return user;
  }

  private async applyProfileFields(user: UserDocument, dto: UpdateUserDto): Promise<void> {
    if (dto.name !== undefined) user.name = dto.name;
    if (dto.birthdate !== undefined) user.birthdate = new Date(dto.birthdate);

    if (dto.email !== undefined && dto.email !== user.email) {
      const taken = await this.userModel.exists({
        email: dto.email,
        _id: { $ne: user._id },
        ...notDeleted,
      });
      if (taken) throw new ConflictException('An account with this email already exists');
      user.email = dto.email;
    }
  }

  /**
   * Only an administrator may set a role, and both roles are theirs to grant.
   *
   * With a tiered ladder this refused to grant a role at or above the actor's
   * own. That rule cannot survive the collapse to two roles: it would leave the
   * store permanently stuck with whichever single administrator the startup
   * seed created, because no admin could ever appoint another.
   *
   * Redundant with the route guard by design — the service does not depend on a
   * controller decorator being present to stay safe.
   */
  private assertMayAssignRole(actorRole: UserRole, target: UserRole): void {
    if (!roleAtLeast(actorRole, UserRole.ADMIN)) {
      throw new AuthorizationException(`You may not assign the ${target} role`);
    }
  }

  /**
   * A customer may act only on their own account; an administrator may act on any.
   *
   * Administrators are peers now, so one editing another is not an escalation —
   * there is no higher rank to reach. Blocking it would instead mean a departed
   * or compromised admin could not be deactivated without database access, which
   * is the worse failure. `assertNotLastAdmin` is what stops that becoming a
   * lockout.
   */
  private assertMayModify(actor: { id: string; role: UserRole }, target: UserDocument): void {
    if (actor.id === target._id.toString()) return;
    if (roleAtLeast(actor.role, UserRole.ADMIN)) return;

    throw new AuthorizationException('You may only modify your own account');
  }

  /** Refuse the change that would lock everyone out of the dashboard. */
  private async assertNotLastAdmin(user: UserDocument, newRole: UserRole): Promise<void> {
    if (user.role !== UserRole.ADMIN || newRole === UserRole.ADMIN) return;

    const remaining = await this.userModel.countDocuments({
      role: UserRole.ADMIN,
      isActive: true,
      _id: { $ne: user._id },
      ...notDeleted,
    });

    if (remaining === 0) {
      throw new ValidationFailedException('Cannot remove the last active administrator');
    }
  }
}
