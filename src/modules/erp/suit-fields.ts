/**
 * Field names in the ERP's suit documents that the suit picker groups and
 * labels by, beyond `_id` and `quantity` (declared on the Suit schema).
 *
 * Confirmed against a real ERP document:
 *
 *     { d_no: 600, category: "Lawn", color: "Red", quantity: 0, ... }
 *
 * Kept in one place because they belong to another system: if the ERP ever
 * renames one, this is the only line to change.
 */
export const SUIT_FIELDS = {
  /** The design number — "D # No" on the ERP screen. Stored as a number. */
  design: 'd_no',
  /** The ERP's own category (Lawn, Chiffon, Velvet …). Display only; unrelated to store categories. */
  category: 'category',
  /** One colour of a design. Each suit document is one design × category × colour. */
  color: 'color',
} as const;
