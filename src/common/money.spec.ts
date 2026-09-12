import { Money, minorUnitExponent, sumMoney } from './money';

describe('Money', () => {
  describe('construction', () => {
    it('rejects a non-integer minor amount', () => {
      expect(() => Money.fromMinor(10.5, 'USD')).toThrow(TypeError);
    });

    it('parses a major-unit decimal without float drift', () => {
      // 19.99 * 100 is 1998.9999999999998 in IEEE 754; naive truncation gives 1998.
      expect(Money.fromMajor(19.99, 'USD').amount).toBe(1999);
      expect(Money.fromMajor('0.07', 'USD').amount).toBe(7);
      // The double nearest 1.005 is 1.00499999999999989, so `Math.round(v * 100)`
      // yields 100 — a silent one-cent loss. Rounding on the decimal form gives 101.
      expect(Money.fromMajor(1.005, 'USD').amount).toBe(101);
      expect(Money.fromMajor(1.015, 'USD').amount).toBe(102);
      expect(Money.fromMajor(8.165, 'USD').amount).toBe(817);
    });

    it('handles negative amounts (refunds) symmetrically', () => {
      expect(Money.fromMajor(-19.99, 'USD').amount).toBe(-1999);
      expect(Money.fromMajor(-1.005, 'USD').amount).toBe(-101);
    });

    it('rejects a value that is not a number', () => {
      expect(() => Money.fromMajor('not-a-price', 'USD')).toThrow(TypeError);
    });

    it('honours currencies with a non-2 minor-unit exponent', () => {
      expect(minorUnitExponent('JPY')).toBe(0);
      expect(minorUnitExponent('KWD')).toBe(3);
      expect(Money.fromMajor(500, 'JPY').amount).toBe(500);
      expect(Money.fromMajor(1.5, 'KWD').amount).toBe(1500);
    });

    it('normalises the currency code', () => {
      expect(Money.fromMinor(100, 'usd').currency).toBe('USD');
    });
  });

  describe('arithmetic', () => {
    it('adds and subtracts exactly', () => {
      const a = Money.fromMajor(0.1, 'USD');
      const b = Money.fromMajor(0.2, 'USD');
      // 0.1 + 0.2 !== 0.3 in floating point; in minor units it is exact.
      expect(a.plus(b).amount).toBe(30);
      expect(a.plus(b).equals(Money.fromMajor(0.3, 'USD'))).toBe(true);
    });

    it('computes a line total from an integer quantity', () => {
      expect(Money.fromMajor(24.99, 'USD').times(3).amount).toBe(7497);
    });

    it('refuses a fractional quantity', () => {
      expect(() => Money.fromMajor(10, 'USD').times(1.5)).toThrow(TypeError);
    });

    it('refuses to mix currencies', () => {
      expect(() => Money.fromMinor(100, 'USD').plus(Money.fromMinor(100, 'EUR'))).toThrow(
        TypeError,
      );
    });

    it('rounds a rate to the minor unit', () => {
      // 18% VAT on 19.99 is 3.5982 → 3.60
      expect(Money.fromMajor(19.99, 'USD').applyRate(0.18).amount).toBe(360);
    });
  });

  describe('sumMoney', () => {
    it('sums line totals', () => {
      const lines = [
        Money.fromMajor(24.99, 'USD').times(2),
        Money.fromMajor(79.9, 'USD').times(1),
        Money.fromMajor(0.01, 'USD').times(3),
      ];
      expect(sumMoney(lines, 'USD').amount).toBe(2499 * 2 + 7990 + 1 * 3);
    });

    it('returns zero for an empty list', () => {
      expect(sumMoney([], 'USD').isZero()).toBe(true);
    });
  });

  describe('presentation', () => {
    it('round-trips through major units', () => {
      expect(Money.fromMajor(1234.56, 'USD').toMajor()).toBe(1234.56);
    });

    it('serialises with amount, currency and a formatted string', () => {
      expect(Money.fromMajor(19.99, 'USD').toJSON()).toEqual({
        amount: 1999,
        currency: 'USD',
        formatted: '$19.99',
      });
    });

    it('formats each currency at its own precision', () => {
      // The exponent table is what makes formatting more than cosmetic: the same
      // integer means a different amount of money in each of these.
      //
      // \u00a0 is deliberate. Intl separates the symbol from the number with a
      // non-breaking space, so that is what every consumer of `formatted`
      // actually receives — writing a plain space here would pin a string the
      // API does not emit.
      expect(Money.fromMinor(1999, 'USD').format()).toBe('$19.99');
      expect(Money.fromMinor(500, 'JPY').format()).toBe('\u00a5500');
      expect(Money.fromMinor(1500, 'KWD').format()).toBe('KWD\u00a01.500');
    });

    it('honours an explicit locale', () => {
      // The parameter is why the formatter memo is keyed on locale as well as
      // currency; a currency-only key would serve this caller the en-US build.
      expect(Money.fromMinor(150000, 'USD').format('de-DE')).toBe('1.500,00\u00a0$');
    });

    it('keeps currencies apart when formatted back to back', () => {
      // Formatters are cached and reused, so a wrong cache key would show up as
      // the second call inheriting the first one's currency.
      const usd = Money.fromMinor(1999, 'USD').format();
      const jpy = Money.fromMinor(1999, 'JPY').format();
      const usdAgain = Money.fromMinor(1999, 'USD').format();

      expect(usd).toBe('$19.99');
      expect(jpy).toBe('\u00a51,999');
      expect(usdAgain).toBe(usd);
    });

    it('is stable across repeated calls', () => {
      // A memo that returned a spent or mutated formatter would diverge here.
      const money = Money.fromMajor(1234.56, 'USD');
      const once = money.format();
      for (let i = 0; i < 100; i += 1) expect(money.format()).toBe(once);
    });
  });

  describe('PKR is priced in whole rupees', () => {
    /**
     * Paisa are out of circulation, and CLDR renders the rupee with no decimal
     * places. Treating PKR as a 2-exponent currency would store 199950 as
     * Rs 1,999.50 and display it as "Rs 2,000" — a price the customer is never
     * charged. Zero exponent keeps storage and display saying the same thing.
     */
    it('has a zero minor-unit exponent', () => {
      expect(minorUnitExponent('PKR')).toBe(0);
    });

    it('reads a stored integer as whole rupees', () => {
      const price = Money.fromMinor(1999, 'PKR');
      expect(price.toMajor()).toBe(1999);
      expect(price.format('en-PK')).toBe('Rs\u00a01,999');
    });

    it('does not round a displayed price away from the stored one', () => {
      // The regression this currency exists in the table to prevent.
      const stored = Money.fromMinor(199950, 'PKR');
      expect(stored.toMajor()).toBe(199950);
      expect(stored.format('en-PK')).toBe('Rs\u00a0199,950');
    });

    it('rounds a typed half-rupee up, rather than truncating it', () => {
      // fromMajor keeps a guard digit and rounds half-up, so an admin who types
      // a legacy paisa amount gets the nearest rupee and not a silent floor.
      expect(Money.fromMajor(1999.5, 'PKR').amount).toBe(2000);
      expect(Money.fromMajor(1999.4, 'PKR').amount).toBe(1999);
    });

    it('keeps line-total arithmetic exact', () => {
      expect(Money.fromMinor(1999, 'PKR').times(3).amount).toBe(5997);
    });
  });
});
