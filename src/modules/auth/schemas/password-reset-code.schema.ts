import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type PasswordResetCodeDocument = HydratedDocument<PasswordResetCode>;

/**
 * The live password-reset code for one customer, and the counters that limit it.
 *
 * One document per user, not one per code: issuing a new code overwrites the
 * previous one, so an older email's code stops working the moment a newer one is
 * sent, and the send limits live beside the code they govern.
 *
 * The code itself is never stored — only a keyed hash of it (see
 * PasswordResetService). A six-digit code has a million values, so a plain hash
 * would fall to an offline search in milliseconds if this collection leaked.
 */
@Schema({ timestamps: true, collection: 'password_reset_codes' })
export class PasswordResetCode {
  _id!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
  userId!: Types.ObjectId;

  /** HMAC-SHA256 of the user id and the code. */
  @Prop({ type: String, required: true })
  codeHash!: string;

  /**
   * Random per issued code. Guards against acting on a code that has since been
   * replaced, and keys the email's dedupe entry.
   */
  @Prop({ type: String, required: true })
  issueId!: string;

  @Prop({ type: Date, required: true })
  expiresAt!: Date;

  /** Guesses spent against this code, counted before each comparison. */
  @Prop({ type: Number, default: 0 })
  attempts!: number;

  /** Set when the code is used; a used code never works again. */
  @Prop({ type: Date, default: null })
  consumedAt!: Date | null;

  @Prop({ type: Date, required: true })
  lastSentAt!: Date;

  /** Start of the current one-hour sending window. */
  @Prop({ type: Date, required: true })
  windowStartedAt!: Date;

  @Prop({ type: Number, default: 0 })
  sendsInWindow!: number;

  /** When MongoDB may delete the document: after the code and the window have both lapsed. */
  @Prop({ type: Date, required: true })
  purgeAt!: Date;
}

export const PasswordResetCodeSchema = SchemaFactory.createForClass(PasswordResetCode);

// Named explicitly, so each index has one stable name in every database.
PasswordResetCodeSchema.index({ userId: 1 }, { unique: true, name: 'password_reset_user_unique' });
PasswordResetCodeSchema.index(
  { purgeAt: 1 },
  { expireAfterSeconds: 0, name: 'password_reset_purge' },
);
