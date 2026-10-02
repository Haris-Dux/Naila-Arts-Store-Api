/** Which table of a size chart a measurement is printed in. */
export type MeasurementGroup = 'SHIRT' | 'TROUSER';

/**
 * Every measurement a size chart can carry, in the order a chart prints them.
 *
 * A fixed list rather than free text, so every chart reads the same way and any
 * storefront can lay one out: the shirt measurements form one table and the
 * trouser measurements another. Adding a measurement is a line here.
 */
export const MEASUREMENTS = [
  { key: 'SHOULDER', label: 'Shoulder', group: 'SHIRT' },
  { key: 'BUST', label: 'Bust', group: 'SHIRT' },
  { key: 'WAIST', label: 'Waist', group: 'SHIRT' },
  { key: 'HIP', label: 'Hip', group: 'SHIRT' },
  { key: 'ARMHOLE', label: 'Armhole', group: 'SHIRT' },
  { key: 'WRIST', label: 'Wrist', group: 'SHIRT' },
  { key: 'SLEEVE_LENGTH', label: 'Sleeve length', group: 'SHIRT' },
  { key: 'TROUSER_LENGTH', label: 'Trouser length', group: 'TROUSER' },
  { key: 'TROUSER_WAIST', label: 'Trouser waist', group: 'TROUSER' },
] as const satisfies readonly { key: string; label: string; group: MeasurementGroup }[];

export type MeasurementKey = (typeof MEASUREMENTS)[number]['key'];

export const MEASUREMENT_KEYS: MeasurementKey[] = MEASUREMENTS.map(
  (measurement) => measurement.key,
);
