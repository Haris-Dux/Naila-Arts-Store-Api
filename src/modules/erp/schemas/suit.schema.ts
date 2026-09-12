import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SuitDocument = HydratedDocument<Suit>;

/**
 * A window onto the ERP's own `suits` collection — not a definition of it.
 *
 * The store shares one database with the ERP, and a store product is built on
 * top of a suit: `Product.erpId` holds this document's `_id`. The ERP owns these
 * records; branch workers move `quantity` by booking sale and return bills that
 * the store never sees.
 *
 * A real suit document, as the ERP writes it (one per design × category ×
 * colour):
 *
 *     { _id, d_no: 600, category: "Lawn", color: "Red", quantity: 0,
 *       cost_price, sale_price, all_records: [], createdAt, updatedAt, __v }
 *
 * Two things make this schema safe to point at a table we do not own:
 *
 *  - `strict: false`, so the many ERP fields this class does not name survive a
 *    round trip instead of being stripped.
 *  - Nothing here ever calls `save()` or replaces a document. Every write is a
 *    targeted `$inc` on `quantity` and nothing else — not `__v`, not
 *    `updatedAt`, not `all_records`. A full-document write through a partial
 *    schema is precisely how an integration silently destroys columns belonging
 *    to the other system.
 *
 * There are no `timestamps` and no soft-delete base class either: adding either
 * would mean writing fields into the ERP's documents that the ERP did not ask
 * for.
 */
@Schema({ collection: 'suits', strict: false, versionKey: false })
export class Suit {
  _id!: Types.ObjectId;

  /**
   * On-hand units, company-wide — the ERP's name for stock. The source of truth
   * for any product linked to this suit; `Product.stock` is only a mirror of it.
   */
  @Prop({ type: Number, default: 0 })
  quantity!: number;
}

export const SuitSchema = SchemaFactory.createForClass(Suit);
