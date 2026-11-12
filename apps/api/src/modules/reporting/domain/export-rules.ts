import { z } from 'zod';

/*
 * Exports (PRD 3.12): CSV files per area. Cells are escaped for CSV and against spreadsheet
 * formula injection; aggregate rows about fewer than MIN_GROUP_SIZE things are suppressed so a
 * small group cannot be singled out; date ranges are bounded and so is the number of rows.
 */

export const EXPORTS = [
  'occupancy-by-building',
  'arrears',
  'maintenance-requests',
  'visits',
  'incidents',
] as const;
export type ExportName = (typeof EXPORTS)[number];

/** Smallest group an aggregate figure is shown for. */
export const MIN_GROUP_SIZE = 3;
export const MAX_EXPORT_ROWS = 10_000;
export const MAX_RANGE_DAYS = 366;
export const DEFAULT_RANGE_DAYS = 30;

const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: quoted when needed, and never read as a formula by a spreadsheet. */
export function csvCell(value: string | number | bigint | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const line = (cells: readonly unknown[]) =>
    cells.map((c) => csvCell(c as string | number | bigint | null)).join(',');
  return `${[line(header), ...rows.map(line)].join('\r\n')}\r\n`;
}

/** A count shown only for groups of at least MIN_GROUP_SIZE; otherwise empty. */
export const suppressed = (groupSize: number, value: number): number | null =>
  groupSize >= MIN_GROUP_SIZE ? value : null;

export const rangeSchema = z
  .object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: 'The start must not be after the end',
    path: ['from'],
  });
export type RangeInput = z.infer<typeof rangeSchema>;

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The dates to export (inclusive), defaulting to the last 30 days; null if too long. */
export function resolveRange(
  input: RangeInput,
  today: string,
): { from: string; to: string } | null {
  const to = input.to ?? today;
  const from = input.from ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  return days > MAX_RANGE_DAYS ? null : { from, to };
}
