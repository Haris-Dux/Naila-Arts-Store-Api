import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, HydratedDocument, Types } from 'mongoose';
import { BaseSchemaClass } from '../../../common/schemas/base.schema';

export type MediaDocument = HydratedDocument<Media>;

/**
 * An uploaded file, recorded so the catalogue can reference it and an operator
 * can see what is on disk.
 *
 * Content-addressed: `hash` is the SHA-256 of the bytes, and it is also the
 * filename. Two consequences, both of them the point:
 *
 *  - Re-uploading the same photograph is deduplicated. A merchant who drags the
 *    same file into two products stores it once.
 *  - The URL for a given set of bytes never changes, so every response can be
 *    served `immutable` and neither the browser nor a CDN in front ever needs to
 *    revalidate it. That is where the read speed actually comes from — far more
 *    than the disk underneath.
 */
@Schema({ timestamps: true, collection: 'media' })
export class Media extends BaseSchemaClass {
  /** SHA-256 of the file, lower-case hex. Also the filename and the cache key. */
  @Prop({ required: true, lowercase: true, trim: true })
  hash!: string;

  /** Path relative to the media root, e.g. `a1/a1b2….webp`. */
  @Prop({ required: true })
  storageKey!: string;

  @Prop({ required: true })
  contentType!: string;

  @Prop({ type: Number, required: true, min: 1 })
  bytes!: number;

  /** Read from the header at upload, so a grid can reserve the box before load. */
  @Prop({ type: Number, required: true, min: 1 })
  width!: number;

  @Prop({ type: Number, required: true, min: 1 })
  height!: number;

  /** Which administrator uploaded it — the question asked when something is wrong. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  uploadedBy!: Types.ObjectId | null;
}

export const MediaSchema = SchemaFactory.createForClass(Media);

// Live-scoped, so deleting a file and re-uploading the same bytes is allowed
// rather than colliding with the tombstone.
MediaSchema.index({ hash: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
MediaSchema.index({ createdAt: -1 });
