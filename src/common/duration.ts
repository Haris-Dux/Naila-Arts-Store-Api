const UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a `ms`-style duration ("15m", "30d", "1h") into milliseconds.
 *
 * Token lifetimes are configured in this notation because that is what
 * @nestjs/jwt accepts; several places also need the value numerically (cache
 * TTLs, cookie maxAge, expiry timestamps), and deriving it from the same string
 * keeps them from drifting apart.
 */
export function parseDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i.exec(value.trim());
  if (!match) {
    throw new TypeError(`Invalid duration "${value}" — expected a form like "15m" or "30d"`);
  }
  return Number(match[1]) * UNITS[match[2].toLowerCase()];
}
