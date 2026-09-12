import { ValidationFailedException } from './exceptions/domain.exception';

/**
 * Keyset pagination cursors.
 *
 * Offset pagination is the wrong primitive for an endless feed. `skip` counts
 * from the start of a result set that is still changing underneath the reader:
 * publish one product while a shopper is scrolling and every subsequent page
 * shifts by one, so they see an item twice; delete one and they never see the
 * item that slid past the boundary. Neither is hypothetical — it reproduces on
 * this catalogue with a single product create between two requests.
 *
 * A cursor names a *position in the ordering* instead of a distance from the
 * start: "everything after this value". Insertions before it are irrelevant, so
 * the reader gets each item exactly once regardless of what else is happening.
 *
 * The value is opaque on purpose. It is base64url of JSON, not a signed or
 * encrypted token, because it carries nothing secret — a sort value and an id
 * the caller already received in the previous page. What it must not be is
 * *guessable structure a client starts constructing by hand*, which is why it is
 * encoded rather than passed as two plain query parameters.
 */

/** The last item of a page, expressed as its position in the sort order. */
export interface Cursor {
  /** The sort field's value on that item. */
  value: string | number | null;
  /** Its `_id`, breaking ties so the ordering is total. */
  id: string;
  /**
   * How to rebuild `value`. A cursor is compared against stored documents, so a
   * date has to come back as a Date and not as the string it serialised to.
   */
  type: 'date' | 'number' | 'string' | 'null';
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decode a cursor, refusing anything that is not one.
 *
 * A malformed cursor is a client error, not a server one: it means a hand-edited
 * URL or a cursor from a different sort order. Failing loudly beats silently
 * restarting the feed from the top, which would look like the list randomly
 * jumping back to the beginning.
 */
export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationFailedException('Malformed cursor');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ValidationFailedException('Malformed cursor');
  }

  const { value, id, type } = parsed as Record<string, unknown>;

  if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) {
    throw new ValidationFailedException('Malformed cursor');
  }

  if (type !== 'date' && type !== 'number' && type !== 'string' && type !== 'null') {
    throw new ValidationFailedException('Malformed cursor');
  }

  if (type === 'null') {
    if (value !== null) throw new ValidationFailedException('Malformed cursor');
  } else if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ValidationFailedException('Malformed cursor');
    }
  } else if (typeof value !== 'string') {
    throw new ValidationFailedException('Malformed cursor');
  }

  return { value: value as Cursor['value'], id, type };
}

/** Capture a document's position in the current ordering. */
export function cursorFor(id: string, value: unknown): Cursor {
  if (value instanceof Date) {
    return { value: value.toISOString(), id, type: 'date' };
  }
  if (typeof value === 'number') {
    return { value, id, type: 'number' };
  }
  if (typeof value === 'string') {
    return { value, id, type: 'string' };
  }
  // `null` is a real sort position — a product with no promotional price sorts
  // among the others, it does not fall out of the ordering.
  return { value: null, id, type: 'null' };
}

/** Rebuild the comparable the cursor was made from. */
export function cursorValue(cursor: Cursor): Date | number | string | null {
  return cursor.type === 'date' ? new Date(cursor.value as string) : cursor.value;
}
