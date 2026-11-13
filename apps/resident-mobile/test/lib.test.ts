import { describe, expect, it } from 'vitest';
import { dayOptions, instantAt, parseClock, plusHours, todayAt } from '../src/lib/dates';
import { qrMatrix } from '../src/lib/qr';

describe('days and times at the property', () => {
  // 21:30 UTC on 12 Nov is already 13 Nov in Karachi (UTC+5).
  const now = Date.parse('2026-11-12T21:30:00Z');

  it("uses the property's date, not the phone's", () => {
    expect(todayAt('Asia/Karachi', now)).toBe('2026-11-13');
    expect(todayAt('America/New_York', now)).toBe('2026-11-12');
  });

  it('labels the next days', () => {
    const days = dayOptions('Asia/Karachi', 4, now);
    expect(days.map((d) => d.date)).toEqual([
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
    ]);
    expect(days[0]?.label).toBe('Today');
    expect(days[1]?.label).toBe('Tomorrow');
    expect(days[2]?.label).toBe('Sun 15 Nov');
  });

  it('reads typed times and refuses impossible ones', () => {
    expect(parseClock('9:05')).toBe('09:05');
    expect(parseClock(' 1830 ')).toBe('18:30');
    expect(parseClock('18.30')).toBe('18:30');
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('7pm')).toBeNull();
  });

  it('turns a day and time at the property into an instant', () => {
    expect(instantAt('2026-11-13', '18:00', 'Asia/Karachi')).toBe('2026-11-13T13:00:00.000Z');
    expect(instantAt('2026-11-13', 'soon', 'Asia/Karachi')).toBeNull();
    expect(plusHours('2026-11-13T13:00:00.000Z', 4)).toBe('2026-11-13T17:00:00.000Z');
  });
});

describe('qrMatrix', () => {
  it('describes a square code as dark runs', () => {
    const { size, rows } = qrMatrix('pass-token-123');
    expect(size).toBeGreaterThanOrEqual(21);
    expect(rows).toHaveLength(size);
    // The finder pattern: the first row starts with a run of 7 dark modules.
    expect(rows[0]?.[0]).toEqual([0, 7]);
    for (const row of rows)
      for (const [start, length] of row) expect(start + length).toBeLessThanOrEqual(size);
  });
});
