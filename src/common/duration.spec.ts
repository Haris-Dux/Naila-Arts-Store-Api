import { parseDuration } from './duration';

/**
 * Token lifetimes and TTLs are configured as strings ("15m", "30d") because
 * @nestjs/jwt takes that form, but several places need the value numerically.
 * A silent mis-parse would mean a session that never expires or one that expires
 * immediately, so the parser is strict.
 */
describe('parseDuration', () => {
  it('parses each supported unit', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('30d')).toBe(2_592_000_000);
    expect(parseDuration('2w')).toBe(1_209_600_000);
  });

  it('accepts whitespace and mixed case', () => {
    expect(parseDuration(' 15M ')).toBe(900_000);
  });

  it('accepts a fractional value', () => {
    expect(parseDuration('1.5h')).toBe(5_400_000);
  });

  it('rejects anything it cannot parse rather than guessing', () => {
    // Returning 0 or NaN here would silently produce a token that expires
    // instantly, or a cache entry that never does.
    for (const bad of ['15', 'm', '', 'forever', '15 minutes', '-5m', '15y']) {
      expect(() => parseDuration(bad)).toThrow(TypeError);
    }
  });
});
