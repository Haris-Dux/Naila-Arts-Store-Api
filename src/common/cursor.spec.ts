import { ValidationFailedException } from './exceptions/domain.exception';
import { Cursor, cursorFor, cursorValue, decodeCursor, encodeCursor } from './cursor';

const ID = '6a9df3402dd2851f3f94bc49';

describe('cursor', () => {
  describe('round trip', () => {
    it.each<[string, unknown]>([
      ['a date', new Date('2026-09-08T10:11:12.000Z')],
      ['a number', 4999],
      ['zero', 0],
      ['a string', 'Embroidered Lawn Suit'],
      ['null', null],
    ])('survives %s', (_label, value) => {
      const cursor = cursorFor(ID, value);
      const back = decodeCursor(encodeCursor(cursor));

      expect(back).toEqual(cursor);
      if (value instanceof Date) {
        expect(cursorValue(back)).toEqual(value);
      } else {
        expect(cursorValue(back)).toBe(value);
      }
    });

    it('rebuilds a date as a Date, not the string it serialised to', () => {
      // It is compared against a stored BSON date; a string would compare as a
      // string and quietly return the wrong slice of the feed.
      const value = cursorValue(decodeCursor(encodeCursor(cursorFor(ID, new Date()))));
      expect(value).toBeInstanceOf(Date);
    });

    it('keeps zero distinct from null', () => {
      // Both are falsy, and conflating them would put every zero-valued product
      // at the wrong end of the ordering.
      expect(cursorFor(ID, 0).type).toBe('number');
      expect(cursorFor(ID, null).type).toBe('null');
    });

    it('is opaque rather than a readable pair of parameters', () => {
      const encoded = encodeCursor(cursorFor(ID, 4999));
      expect(encoded).not.toContain(ID);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('rejects anything that is not a cursor', () => {
    const refuse = (raw: string) =>
      expect(() => decodeCursor(raw)).toThrow(ValidationFailedException);

    it('refuses junk', () => {
      refuse('not-base64!!');
      refuse(Buffer.from('{"nope"', 'utf8').toString('base64url'));
      refuse(Buffer.from('"a string"', 'utf8').toString('base64url'));
      refuse(Buffer.from('null', 'utf8').toString('base64url'));
    });

    it('refuses an id that is not an ObjectId', () => {
      refuse(encodeCursor({ value: 1, id: 'nope', type: 'number' } as Cursor));
      refuse(encodeCursor({ value: 1, id: '', type: 'number' } as Cursor));
    });

    it('refuses a value that disagrees with its declared type', () => {
      refuse(encodeCursor({ value: 'five', id: ID, type: 'number' } as unknown as Cursor));
      refuse(encodeCursor({ value: 5, id: ID, type: 'string' } as unknown as Cursor));
      refuse(encodeCursor({ value: 'x', id: ID, type: 'null' } as unknown as Cursor));
    });

    it('refuses an unknown type tag', () => {
      refuse(encodeCursor({ value: 1, id: ID, type: 'bigint' } as unknown as Cursor));
    });

    it('refuses a non-finite number, which JSON turns into null', () => {
      refuse(Buffer.from(JSON.stringify({ value: null, id: ID, type: 'number' })).toString('base64url'));
    });
  });
});
