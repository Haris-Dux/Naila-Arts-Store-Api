import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { BaseSchemaClass } from '../../../common/schemas/base.schema';

export type SizeDocument = HydratedDocument<Size>;

/**
 * One size a product can be sold in.
 *
 * A collection rather than an enum, because the set is the merchant's to decide:
 * a lawn label runs XS–XXL, a kaftan label might run S/M/L only, and neither
 * should need a deploy to change.
 *
 * Note what is *not* here: "Unstitched". An unstitched suit is a garment form,
 * not a size — see `Product.sizing` for why it is modelled there instead.
 */
@Schema({ timestamps: true, collection: 'sizes' })
export class Size extends BaseSchemaClass {
  /** What the storefront shows: "Medium", "38", "Free Size". */
  @Prop({ required: true, trim: true })
  name!: string;

  /** Short label for the size picker and the order record: "M", "38". */
  @Prop({ required: true, trim: true, uppercase: true })
  code!: string;

  /**
   * Display position. Sizes have no natural sort — alphabetically "XL" precedes
   * "S" — so the order is stated rather than derived. Ties break by code.
   */
  @Prop({ type: Number, default: 0, min: 0 })
  order!: number;

  @Prop({ type: Boolean, default: true, index: true })
  isActive!: boolean;
}

export const SizeSchema = SchemaFactory.createForClass(Size);

// Live-scoped, so a soft-deleted size releases its code for reuse.
SizeSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
SizeSchema.index({ order: 1, code: 1 });
