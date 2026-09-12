import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { BaseSchemaClass } from '../../../common/schemas/base.schema';
import { UserRole } from '../enums/user-role.enum';

export type UserDocument = HydratedDocument<User>;

@Schema({ timestamps: true, collection: 'users' })
export class User extends BaseSchemaClass {
  @Prop({ required: true, trim: true })
  name!: string;

  // Uniqueness is enforced by the partial index declared below, not here — two
  // declarations would build two competing indexes on the same field.
  @Prop({ required: true, lowercase: true, trim: true })
  email!: string;

  /**
   * `select: false` is load-bearing, not decorative: the hash is excluded from
   * every query unless a caller explicitly asks for it with `.select('+password')`.
   *
   * The old `findByEmail` returned the whole row — hash included — while its
   * return type claimed to be a `UserResponseDto`. Anything that forwarded that
   * value leaked the hash. Here it is impossible to leak by accident; you have
   * to opt in.
   */
  @Prop({ required: true, select: false })
  password!: string;

  @Prop({
    type: String,
    enum: Object.values(UserRole),
    default: UserRole.USER,
    index: true,
  })
  role!: UserRole;

  @Prop({ type: Boolean, default: true, index: true })
  isActive!: boolean;

  @Prop({ type: Date, default: null })
  birthdate!: Date | null;

  /**
   * Bumped on logout-everywhere, password change, and forced revocation.
   *
   * An access token embeds the version it was minted with. Raising this number
   * invalidates every token issued before it — which is what makes otherwise
   * stateless JWTs revocable, without a database read on each request.
   */
  @Prop({ type: Number, default: 0 })
  tokenVersion!: number;

  @Prop({ type: Date, default: null })
  lastLoginAt!: Date | null;
}

export const UserSchema = SchemaFactory.createForClass(User);

// Partial unique index on email: scoped to live documents so a soft-deleted
// account does not permanently reserve its address.
UserSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });

// Supports the admin listing, which filters on role and sorts by createdAt.
UserSchema.index({ role: 1, createdAt: -1 });
