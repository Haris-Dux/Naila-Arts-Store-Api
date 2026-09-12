import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  SuitColorDto,
  SuitColorQueryDto,
  SuitDesignDto,
  SuitDesignQueryDto,
} from './dto/suit-query.dto';
import { Suit, SuitDocument } from './schemas/suit.schema';
import { SUIT_FIELDS } from './suit-fields';

/** A design can come in many colours; this is plenty for one dropdown. */
const MAX_COLORS = 100;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Read-only lookups over the ERP's suits, for building a product on one.
 *
 * Every query here reads; nothing writes. Stock is only ever moved by
 * InventoryService, under the rules documented on the Suit schema.
 *
 * Zero-stock suits are filtered out in the database rather than by the client:
 * a suit the store cannot sell is not a choice the admin should be offered.
 */
@Injectable()
export class SuitsService {
  constructor(@InjectModel(Suit.name) private readonly suitModel: Model<SuitDocument>) {}

  /**
   * Designs with something in stock, grouped by design *and* category — the
   * same design number can exist in more than one category, and those are
   * different suits.
   *
   * The prefix match compares the design as text, so it behaves the same
   * whether the ERP stores design numbers as strings or as numbers. The store
   * adds no index to the ERP's collection; with a short limit and a debounced
   * caller this is a bounded scan.
   */
  async designs(query: SuitDesignQueryDto): Promise<SuitDesignDto[]> {
    const { design, category } = SUIT_FIELDS;

    const match: Record<string, unknown> = { quantity: { $gt: 0 } };
    if (query.search) {
      match.$expr = {
        $regexMatch: {
          input: { $toString: `$${design}` },
          regex: `^${escapeRegex(query.search)}`,
          options: 'i',
        },
      };
    }

    const rows = await this.suitModel
      .aggregate<{
        _id: { design: unknown; category: unknown };
        colorCount: number;
        stock: number;
      }>([
        { $match: match },
        {
          $group: {
            _id: { design: `$${design}`, category: `$${category}` },
            colorCount: { $sum: 1 },
            stock: { $sum: '$quantity' },
          },
        },
        { $sort: { '_id.design': 1, '_id.category': 1 } },
        { $limit: query.limit },
      ])
      .exec();

    return rows
      .filter((row) => row._id.design !== null && row._id.design !== undefined)
      .map((row) => ({
        designNo: String(row._id.design),
        category: asText(row._id.category),
        colorCount: row.colorCount,
        stock: row.stock,
      }));
  }

  /** The in-stock colours of one design, each being one suit. */
  async colors(query: SuitColorQueryDto): Promise<SuitColorDto[]> {
    const { design, category, color } = SUIT_FIELDS;

    // The design number arrives as text from the query string; the ERP may
    // have stored it as a number.
    const designValues: unknown[] = [query.designNo];
    if (/^\d+$/.test(query.designNo)) designValues.push(Number(query.designNo));

    const suits = await this.suitModel
      .find({
        [design]: { $in: designValues },
        // An empty category means the same as none: a design filed under no category.
        [category]: query.category || null,
        quantity: { $gt: 0 },
      })
      .select({ _id: 1, quantity: 1, [color]: 1 })
      .sort({ [color]: 1 })
      .limit(MAX_COLORS)
      .lean<Array<Record<string, unknown> & { _id: Types.ObjectId; quantity: number }>>()
      .exec();

    return suits.map((suit) => ({
      suitId: suit._id.toString(),
      color: asText(suit[color]),
      stock: suit.quantity,
    }));
  }
}

function asText(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}
