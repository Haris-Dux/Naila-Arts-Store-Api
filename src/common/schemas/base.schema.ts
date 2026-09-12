import { Prop, Schema } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

/**
 * Shared base for every persisted document: timestamps plus soft delete.
 *
 * Soft delete matters for an ERP-integrated store — an order or product that has
 * been pushed to the ERP must never vanish from under it, and referential history
 * has to survive. Use `withoutDeleted()` on every read query.
 */
@Schema({ timestamps: true })
export abstract class BaseSchemaClass {
  _id!: Types.ObjectId;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  createdAt!: Date;
  updatedAt!: Date;
}

/** Filter fragment excluding soft-deleted documents. */
export const notDeleted = { deletedAt: null } as const;

/**
 * Standard transform applied to every schema: expose `id`, hide `_id`/`__v`.
 * Keeps API responses free of Mongo implementation detail.
 */
export function applyBaseTransforms(schema: MongooseSchema): void {
  const transform = (_doc: unknown, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  };

  schema.set('toJSON', { virtuals: true, versionKey: false, transform });
  schema.set('toObject', { virtuals: true, versionKey: false, transform });
}
