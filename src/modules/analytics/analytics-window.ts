import { ValidationFailedException } from '../../common/exceptions/domain.exception';
import { DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS } from './analytics.constants';

export type Granularity = 'day' | 'week' | 'month';
export type IntervalOption = 'auto' | Granularity;

const MS_PER_DAY = 86_400_000;

/**
 * A resolved reporting period, plus the equal-length one before it.
 *
 * Both are half-open, `[from, to)`. Half-open is what makes "last 7 days" and
 * "the 7 days before that" tile without double-counting the instant they meet.
 */
export interface AnalyticsWindow {
  /** Inclusive start. */
  from: Date;
  /** Exclusive end. */
  to: Date;
  /** Inclusive start of the comparison period; its end is `from`. */
  previousFrom: Date;
  granularity: Granularity;
  timezone: string;
}

/** Milliseconds `timezone` is ahead of UTC at the instant `at`. */
function zoneOffsetMs(timezone: string, at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // Some ICU versions emit "24" for midnight under hour12: false.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );

  return asUtc - at.getTime();
}

/** The wall-clock calendar fields `at` shows in `timezone`. */
function zonedParts(
  timezone: string,
  at: Date,
): { year: number; month: number; day: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(at).map((part) => [part.type, part.value]),
  );

  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdays.indexOf(parts.weekday as string),
  };
}

/**
 * The instant at which the given local calendar day begins in `timezone`.
 *
 * Resolved in two passes: the offset is read at a first guess, then again at the
 * corrected instant. One pass is wrong whenever the guess lands on the far side
 * of a DST boundary from the answer.
 */
export function zonedStartOfDay(
  year: number,
  month: number,
  day: number,
  timezone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day);
  const firstGuess = new Date(naive - zoneOffsetMs(timezone, new Date(naive)));
  return new Date(naive - zoneOffsetMs(timezone, firstGuess));
}

/** Start of the bucket that `at` falls in, in the store's zone. */
export function truncate(at: Date, granularity: Granularity, timezone: string): Date {
  const { year, month, day, weekday } = zonedParts(timezone, at);

  if (granularity === 'month') {
    return zonedStartOfDay(year, month, 1, timezone);
  }

  if (granularity === 'week') {
    // Monday-based, matching $dateTrunc's startOfWeek below.
    const sinceMonday = (weekday + 6) % 7;
    return new Date(
      zonedStartOfDay(year, month, day, timezone).getTime() - sinceMonday * MS_PER_DAY,
    );
  }

  return zonedStartOfDay(year, month, day, timezone);
}

/**
 * Step forward one bucket from a bucket start.
 *
 * Days and weeks are re-derived through the calendar rather than added as fixed
 * milliseconds, so a DST transition inside the step still lands on local
 * midnight instead of drifting an hour.
 */
export function addBucket(start: Date, granularity: Granularity, timezone: string): Date {
  const { year, month, day } = zonedParts(timezone, start);

  if (granularity === 'month') {
    return zonedStartOfDay(year, month + 1, 1, timezone);
  }

  return zonedStartOfDay(year, month, day + (granularity === 'week' ? 7 : 1), timezone);
}

/**
 * How finely to slice a window so the chart stays readable.
 *
 * Bounded on purpose: a year of daily bars is unreadable, and a week of monthly
 * bars is a single column.
 */
export function chooseGranularity(from: Date, to: Date): Granularity {
  const days = (to.getTime() - from.getTime()) / MS_PER_DAY;
  if (days <= 92) return 'day';
  if (days <= 366) return 'week';
  return 'month';
}

/** Every bucket start in `[from, to)`, including the ones with no orders. */
export function bucketStarts(window: AnalyticsWindow): Date[] {
  const starts: Date[] = [];
  let cursor = truncate(window.from, window.granularity, window.timezone);

  while (cursor < window.to) {
    // The first bucket can begin before `from` when the window starts mid-bucket
    // — a month view of "last 30 days" opens partway through a month. It is
    // still the bucket those orders belong to.
    starts.push(cursor);
    const next = addBucket(cursor, window.granularity, window.timezone);
    /* istanbul ignore next -- a zone that fails to advance would loop forever */
    if (next <= cursor) break;
    cursor = next;
  }

  return starts;
}

export interface RangeInput {
  from?: string;
  to?: string;
  interval?: IntervalOption;
}

/** True for `2026-08-01`, false for a full timestamp. */
function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseBound(value: string, timezone: string, endOfDay: boolean): Date {
  if (isDateOnly(value)) {
    const [year, month, day] = value.split('-').map(Number);
    // A date-only `to` names a day the caller means to include, so the exclusive
    // bound is the following local midnight. Without this, "1 Aug to 31 Aug"
    // would silently drop the 31st.
    return zonedStartOfDay(year, month, day + (endOfDay ? 1 : 0), timezone);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationFailedException(`Not a valid date: ${value}`, { value });
  }
  return parsed;
}

/**
 * Turn the query into a window, applying defaults and the store's timezone.
 *
 * The cross-field rules live here rather than in a class-validator constraint
 * because the resolution has to happen anyway — defaults, date-only to instant,
 * zone — and putting the checks inside it means one place knows what a window
 * is, testable without a DI container.
 */
export function resolveWindow(
  input: RangeInput,
  timezone: string,
  now: Date = new Date(),
): AnalyticsWindow {
  const to = input.to ? parseBound(input.to, timezone, true) : now;

  const from = input.from
    ? parseBound(input.from, timezone, false)
    : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * MS_PER_DAY);

  if (from >= to) {
    throw new ValidationFailedException('`from` must be earlier than `to`', {
      from: from.toISOString(),
      to: to.toISOString(),
    });
  }

  const lengthMs = to.getTime() - from.getTime();

  if (lengthMs > MAX_WINDOW_DAYS * MS_PER_DAY) {
    throw new ValidationFailedException(
      `A window may span at most ${MAX_WINDOW_DAYS} days`,
      { requestedDays: Math.ceil(lengthMs / MS_PER_DAY), maxDays: MAX_WINDOW_DAYS },
    );
  }

  const interval = input.interval ?? 'auto';

  return {
    from,
    to,
    // Equal length by construction, so the comparison is like for like.
    previousFrom: new Date(from.getTime() - lengthMs),
    granularity: interval === 'auto' ? chooseGranularity(from, to) : interval,
    timezone,
  };
}
