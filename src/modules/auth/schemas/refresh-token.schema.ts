import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, HydratedDocument, Types } from 'mongoose';

export type RefreshTokenDocument = HydratedDocument<RefreshToken>;

/**
 * A single issued refresh token.
 *
 * Only a SHA-256 digest is stored, never the token itself — a database leak must
 * not hand out live sessions. Tokens rotate on every use: presenting one
 * revokes it and issues a replacement, and presenting an *already-rotated* token
 * is treated as theft, killing the whole family.
 *
 * The old stack had none of this: `/auth/me` simply re-signed a new 1-day token
 * from a still-valid one, so there was no rotation, no revocation, and no way to
 * log anyone out.
 */
@Schema({ timestamps: true, collection: 'refresh_tokens' })
export class RefreshToken {
  _id!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  /** SHA-256 of the opaque token. Unique, so a digest cannot be replayed twice. */
  @Prop({ required: true, unique: true })
  tokenHash!: string;

  /**
   * Chain identifier shared by a token and its replacements. Reuse of a rotated
   * token revokes every member of the family, not just the one presented.
   */
  @Prop({ type: String, required: true, index: true })
  family!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;

  @Prop({ type: String, default: null })
  revokedReason!: string | null;

  /** Coarse client fingerprint, for showing a user their active sessions. */
  @Prop({ type: String, default: null })
  userAgent!: string | null;

  @Prop({ type: String, default: null })
  ip!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);

// Expired tokens remove themselves; the collection cannot grow without bound.
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Supports "revoke every live session for this user".
RefreshTokenSchema.index({ userId: 1, revokedAt: 1 });
