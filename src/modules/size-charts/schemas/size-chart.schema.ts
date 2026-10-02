import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, HydratedDocument, Types } from 'mongoose';
import { BaseSchemaClass } from '../../../common/schemas/base.schema';
import { MEASUREMENT_KEYS, MeasurementKey } from '../measurements';

export type SizeChartDocument = HydratedDocument<SizeChart>;

/** One size's measurements. */
@Schema({ _id: false })
export class SizeChartRow {
  /**
   * A size from the `sizes` collection, so a chart uses the same names as the
   * size picker — and a size cannot be deleted while a chart still lists it.
   */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Size', required: true })
  sizeId!: Types.ObjectId;

  /** One value per measurement, in the chart's `measurements` order. */
  @Prop({ type: [Number], required: true })
  values!: number[];
}

export const SizeChartRowSchema = SchemaFactory.createForClass(SizeChartRow);

/**
 * A size chart: the measurements of each size, shown with a product sold
 * stitched.
 *
 * Kept apart from the products and chosen by them, because one brand's chart
 * fits every product cut to it — so a correction is made once, not per product.
 */
@Schema({ timestamps: true, collection: 'size_charts' })
export class SizeChart extends BaseSchemaClass {
  /** What the admin picks it by, and the heading shoppers see: "Polawn". */
  @Prop({ required: true, trim: true })
  name!: string;

  /** The columns, always in the order of `MEASUREMENTS`. Never empty. */
  @Prop({ type: [String], enum: MEASUREMENT_KEYS, required: true })
  measurements!: MeasurementKey[];

  /** One row per size, in the sizes' display order. Never empty. */
  @Prop({ type: [SizeChartRowSchema], required: true })
  rows!: SizeChartRow[];

  /** Printed under the chart: "All mentioned sizes in inches". */
  @Prop({ type: String, default: null })
  note!: string | null;
}

export const SizeChartSchema = SchemaFactory.createForClass(SizeChart);

// Live-scoped, so a deleted chart releases its name.
SizeChartSchema.index({ name: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
// "Is this size still on a chart?" — asked before a size may be deleted.
SizeChartSchema.index({ 'rows.sizeId': 1 });
