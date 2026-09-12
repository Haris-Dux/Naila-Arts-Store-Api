/**
 * How a product is sold with respect to size.
 *
 * The obvious alternative was to add "Unstitched" to the size collection and let
 * a product carry it like any other size. That was rejected: unstitched is a
 * *garment form*, not a measurement. As a size it would sit in the picker beside
 * S/M/L, appear in a size filter that otherwise means "will this fit me", and be
 * deletable by an administrator tidying the size list — at which point every
 * unstitched suit in the catalogue would lose what it is.
 *
 * Keeping it here makes the two states explicit and mutually exclusive, and
 * leaves the size collection meaning exactly one thing.
 *
 * The value is inferred from `sizes` when the client does not state it, so the
 * pair can never disagree. A third form — ONE_SIZE, say — is an addition here
 * plus a line in the validation, and nothing else.
 */
export enum ProductSizing {
  /** The customer picks from `Product.sizes`, which is non-empty. */
  SIZED = 'SIZED',
  /** Sold as an unstitched piece. No size is chosen, and `sizes` is empty. */
  UNSTITCHED = 'UNSTITCHED',
}
