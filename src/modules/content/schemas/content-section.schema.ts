import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, HydratedDocument, Types } from 'mongoose';
import { BaseSchemaClass } from '../../../common/schemas/base.schema';

export type ContentSectionDocument = HydratedDocument<ContentSection>;

/**
 * One editable storefront region, stored as an opaque blob under its key.
 *
 * There is deliberately no collection per section. A section's shape is owned by
 * its `SectionDefinition` and validated before anything is written, so the
 * database's job here is storage, not schema — and keeping it that way is what
 * makes a new section a new file rather than a new migration.
 *
 * `Mixed` is the one place in this codebase where it is the right answer, and it
 * is safe for the same reason: the whole document is replaced on every write, so
 * none of the `markModified` traps that make `Mixed` dangerous apply. Every
 * *reference* field elsewhere must still use `MongooseSchema.Types.ObjectId` —
 * see the note in the README.
 */
@Schema({ timestamps: true, collection: 'content_sections' })
export class ContentSection extends BaseSchemaClass {
  /** Matches a `SectionDefinition.key`. A row with no definition is ignored. */
  @Prop({ required: true, trim: true })
  key!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  data!: Record<string, unknown>;

  /** Switches the whole region off without discarding what is in it. */
  @Prop({ type: Boolean, default: true })
  isPublished!: boolean;

  /** Who last saved it — the question support asks when copy changes. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', default: null })
  updatedBy!: Types.ObjectId | null;
}

export const ContentSectionSchema = SchemaFactory.createForClass(ContentSection);

// One row per section, enforced by the database rather than by the upsert being
// careful: two concurrent first-time saves would otherwise both insert.
ContentSectionSchema.index({ key: 1 }, { unique: true });
