import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, HydratedDocument, Types } from 'mongoose';
import { BaseSchemaClass } from '../../../common/schemas/base.schema';

export type CategoryDocument = HydratedDocument<Category>;

/**
 * A real collection, not the bare `category_id: number` the old DTO carried
 * against a column that did not exist on the entity.
 */
@Schema({ timestamps: true, collection: 'categories' })
export class Category extends BaseSchemaClass {
  @Prop({ required: true, trim: true })
  name!: string;

  /** URL-safe identifier used by the storefront. */
  @Prop({ required: true, lowercase: true, trim: true })
  slug!: string;

  @Prop({ type: String, default: null })
  description!: string | null;

  /**
   * The owning parent, or null for a top-level category.
   *
   * The tree is exactly two levels deep and the service enforces it: a parent
   * must itself be top-level. Storefront navigation is built on that shape, and
   * a product carries both halves of its placement (`categoryId` +
   * `subcategoryId`) rather than a single leaf pointer — so an arbitrary-depth
   * tree would have nowhere to put the middle.
   */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: Category.name, default: null })
  parentId!: Types.ObjectId | null;

  /**
   * Display position among siblings, ascending. Ties break by name.
   *
   * Assigned by the server, not typed by a merchant: `create` appends one past
   * the last sibling, and `reorder` rewrites a whole branch to dense 0..n-1
   * positions from a dragged list. Defaulting everything to 0 — as this once
   * did — left every category tied and silently alphabetical, which is an order
   * nobody chose and no drag could change.
   *
   * Still not unique. The reorder path keeps a branch dense, but forcing
   * uniqueness in the schema would make any intermediate state illegal.
   */
  @Prop({ type: Number, default: 0, min: 0 })
  order!: number;

  @Prop({ type: Boolean, default: true, index: true })
  isActive!: boolean;
}

export const CategorySchema = SchemaFactory.createForClass(Category);

// Scoped to live documents so a soft-deleted category releases its slug.
CategorySchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
// The only ordering the storefront ever asks for: siblings of one parent, in
// display order. Covers the root listing too, where parentId is null.
CategorySchema.index({ parentId: 1, order: 1, name: 1 });
