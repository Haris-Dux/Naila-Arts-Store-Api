import { ValidationFailedException } from '../../common/exceptions/domain.exception';
import {
  addBucket,
  bucketStarts,
  chooseGranularity,
  resolveWindow,
  truncate,
  zonedStartOfDay,
} from './analytics-window';

const KARACHI = 'Asia/Karachi'; // UTC+5, no DST
const NEW_YORK = 'America/New_York'; // UTC-5/-4, DST

describe('zonedStartOfDay', () => {
  it('resolves local midnight to the right UTC instant for a fixed-offset zone', () => {
    // Midnight on 8 Sep in Karachi is 19:00 UTC on 7 Sep.
    expect(zonedStartOfDay(2026, 9, 8, KARACHI).toISOString()).toBe('2026-09-07T19:00:00.000Z');
  });

  it('is the identity for UTC', () => {
    expect(zonedStartOfDay(2026, 9, 8, 'UTC').toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });

  it('handles both sides of a DST transition', () => {
    // US DST began 8 March 2026. The 7th is EST (-5), the 9th EDT (-4).
    expect(zonedStartOfDay(2026, 3, 7, NEW_YORK).toISOString()).toBe('2026-03-07T05:00:00.000Z');
    expect(zonedStartOfDay(2026, 3, 9, NEW_YORK).toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });
});

describe('truncate', () => {
  it('puts an after-midnight order on the local day, not the UTC one', () => {
    // 02:00 local on 8 Sep in Karachi is 21:00 UTC on the 7th. This is the exact
    // case STORE_TIMEZONE exists for: UTC would file it under the 7th.
    const at = new Date('2026-09-07T21:00:00.000Z');

    expect(truncate(at, 'day', KARACHI).toISOString()).toBe('2026-09-07T19:00:00.000Z');
    expect(truncate(at, 'day', 'UTC').toISOString()).toBe('2026-09-07T00:00:00.000Z');

    // Same instant, and only the zone-aware one agrees with the merchant's calendar.
    expect(truncate(at, 'day', KARACHI).getTime()).toBeGreaterThan(
      truncate(at, 'day', 'UTC').getTime(),
    );
  });

  it('cuts weeks on Monday', () => {
    // 9 Sep 2026 is a Wednesday; its week starts Monday the 7th.
    const wednesday = new Date('2026-09-09T12:00:00.000Z');
    expect(truncate(wednesday, 'week', 'UTC').toISOString()).toBe('2026-09-07T00:00:00.000Z');
  });

  it('cuts months at the first', () => {
    const midMonth = new Date('2026-09-17T12:00:00.000Z');
    expect(truncate(midMonth, 'month', 'UTC').toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('addBucket', () => {
  it('steps a day', () => {
    const start = new Date('2026-09-07T00:00:00.000Z');
    expect(addBucket(start, 'day', 'UTC').toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });

  it('steps a month across a year boundary', () => {
    const december = new Date('2026-12-01T00:00:00.000Z');
    expect(addBucket(december, 'month', 'UTC').toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('stays on local midnight across a DST transition', () => {
    // 7 March is EST, 8 March is EDT. A naive +86400000 would land at 23:00 on
    // the 7th; the calendar step lands on midnight of the 8th.
    const seventh = zonedStartOfDay(2026, 3, 7, NEW_YORK);
    const eighth = addBucket(seventh, 'day', NEW_YORK);

    expect(eighth.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(eighth.getTime() - seventh.getTime()).toBe(24 * 3_600_000);

    const ninth = addBucket(eighth, 'day', NEW_YORK);
    // The DST day is 23 hours long, and the step still lands on local midnight.
    expect(ninth.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(ninth.getTime() - eighth.getTime()).toBe(23 * 3_600_000);
  });
});

describe('chooseGranularity', () => {
  const days = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);

  it.each([
    [7, 'day'],
    [30, 'day'],
    [92, 'day'],
    [93, 'week'],
    [366, 'week'],
    [367, 'month'],
  ])('slices a %i-day window by %s', (span, expected) => {
    expect(chooseGranularity(days(0), days(span))).toBe(expected);
  });
});

describe('bucketStarts', () => {
  it('emits every day in the window, including ones with no orders', () => {
    const window = resolveWindow(
      { from: '2026-09-01', to: '2026-09-07', interval: 'day' },
      'UTC',
    );
    const starts = bucketStarts(window);

    // 1st through 7th inclusive: a date-only `to` includes the day it names.
    expect(starts).toHaveLength(7);
    expect(starts[0].toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(starts[6].toISOString()).toBe('2026-09-07T00:00:00.000Z');
  });

  it('includes the bucket a mid-bucket start falls into', () => {
    const window = resolveWindow(
      { from: '2026-09-17', to: '2026-11-03', interval: 'month' },
      'UTC',
    );

    // September's bucket is kept even though the window opens on the 17th —
    // those orders belong to September.
    expect(bucketStarts(window).map((d) => d.toISOString())).toEqual([
      '2026-09-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z',
    ]);
  });
});

describe('resolveWindow', () => {
  const now = new Date('2026-09-07T12:00:00.000Z');

  it('defaults to the last 30 days ending now', () => {
    const window = resolveWindow({}, 'UTC', now);

    expect(window.to).toEqual(now);
    expect(window.from.toISOString()).toBe('2026-08-08T12:00:00.000Z');
  });

  it('makes the comparison period exactly as long as the window', () => {
    const window = resolveWindow({ from: '2026-09-01', to: '2026-09-07' }, 'UTC', now);

    expect(window.to.getTime() - window.from.getTime()).toBe(
      window.from.getTime() - window.previousFrom.getTime(),
    );
    // 1 Sep to 8 Sep exclusive is seven days, so the comparison opens on 25 Aug.
    expect(window.previousFrom.toISOString()).toBe('2026-08-25T00:00:00.000Z');
  });

  it('includes the whole of a date-only end day', () => {
    const window = resolveWindow({ from: '2026-08-01', to: '2026-08-31' }, 'UTC', now);

    // Exclusive bound is the following midnight, so the 31st is in.
    expect(window.to.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('resolves date-only bounds in the store zone, not UTC', () => {
    const window = resolveWindow({ from: '2026-09-08', to: '2026-09-08' }, KARACHI, now);

    expect(window.from.toISOString()).toBe('2026-09-07T19:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-09-08T19:00:00.000Z');
  });

  it('takes a full timestamp as the exact instant', () => {
    const window = resolveWindow(
      { from: '2026-09-01T06:30:00.000Z', to: '2026-09-02T06:30:00.000Z' },
      KARACHI,
      now,
    );

    expect(window.from.toISOString()).toBe('2026-09-01T06:30:00.000Z');
    expect(window.to.toISOString()).toBe('2026-09-02T06:30:00.000Z');
  });

  it('honours an explicit interval over the automatic choice', () => {
    const window = resolveWindow(
      { from: '2026-09-01', to: '2026-09-07', interval: 'month' },
      'UTC',
      now,
    );

    expect(window.granularity).toBe('month');
  });

  it('refuses a backwards range', () => {
    expect(() => resolveWindow({ from: '2026-09-07', to: '2026-09-01' }, 'UTC', now)).toThrow(
      ValidationFailedException,
    );
  });

  it('refuses a window longer than a year', () => {
    expect(() => resolveWindow({ from: '2024-01-01', to: '2026-01-01' }, 'UTC', now)).toThrow(
      ValidationFailedException,
    );
  });

  it('refuses an unparseable date', () => {
    expect(() => resolveWindow({ from: 'last tuesday' }, 'UTC', now)).toThrow(
      ValidationFailedException,
    );
  });
});
