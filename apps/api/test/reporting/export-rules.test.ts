import { describe, expect, it } from 'vitest';
import {
  csvCell,
  MAX_RANGE_DAYS,
  resolveRange,
  suppressed,
  toCsv,
} from '../../src/modules/reporting/domain/export-rules';

describe('export rules', () => {
  it('escape CSV cells and defuse spreadsheet formulas', () => {
    expect(csvCell('Tower A')).toBe('Tower A');
    expect(csvCell('A, "B"')).toBe('"A, ""B"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(toCsv(['a', 'b'], [[1, null]])).toBe('a,b\r\n1,\r\n');
  });

  it('suppress figures about fewer than three things', () => {
    expect(suppressed(2, 1)).toBeNull();
    expect(suppressed(3, 1)).toBe(1);
  });

  it('default to the last 30 days and refuse ranges that are too long', () => {
    expect(resolveRange({}, '2026-11-12')).toEqual({ from: '2026-10-14', to: '2026-11-12' });
    expect(resolveRange({ from: '2026-01-01', to: '2026-01-31' }, '2026-11-12')).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(resolveRange({ from: '2024-12-31', to: '2026-01-01' }, '2026-11-12')).toBeNull();
    expect(MAX_RANGE_DAYS).toBe(366);
  });
});
