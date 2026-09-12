import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, HydratedDocument, Types } from 'mongoose';

export type IdempotencyKeyDocument = HydratedDocument<IdempotencyKey>;

export enum IdempotencyState {
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

/**
 * A record of a request that must not be executed twice.
 *
 * Checkout is the case that matters: a customer double-clicks, or a mobile
 * client retries after a timeout it could not distinguish from a failure, and
 * without this they are charged twice and stock is decremented twice.
 *
 * The unique index on `key` is the mechanism, not a safety net — the second
 * concurrent request loses the insert race and is handled as a replay.
 */
@Schema({ timestamps: true, collection: 'idempotency_keys' })
export class IdempotencyKey {
  _id!: Types.ObjectId;

  /** Scoped by user and route, so two customers cannot collide on a shared key. */
  @Prop({ required: true })
  key!: string;

  /** Null for a guest checkout; the scope in `key` still isolates the caller. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  userId!: Types.ObjectId | null;

  @Prop({ required: true })
  endpoint!: string;

  @Prop({
    type: String,
    enum: Object.values(IdempotencyState),
    default: IdempotencyState.IN_PROGRESS,
  })
  state!: IdempotencyState;

  /**
   * Fingerprint of the original request body. A replay carrying the *same* key
   * but a *different* payload is a client bug, and returning the first result
   * would silently hide it.
   */
  @Prop({ type: String, default: null })
  requestFingerprint!: string | null;

  /** The first response, replayed verbatim to any subsequent attempt. */
  @Prop({ type: Object, default: null })
  response!: Record<string, unknown> | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  resourceId!: Types.ObjectId | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const IdempotencyKeySchema = SchemaFactory.createForClass(IdempotencyKey);

IdempotencyKeySchema.index({ key: 1 }, { unique: true });
// Keys expire after 24h; retry windows are far shorter, and the collection must
// not grow without bound.
IdempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 86_400 });
