import { describe, expect, it } from 'vitest';
import { isCountryCode } from '../src';

describe('isCountryCode', () => {
  it('accepts officially assigned ISO 3166-1 alpha-2 codes', () => {
    for (const code of ['PK', 'LK', 'AE', 'GB', 'US', 'SG', 'AX', 'SS']) {
      expect(isCountryCode(code)).toBe(true);
    }
  });

  it('rejects groupings, pseudo-regions, retired, user-assigned and malformed codes', () => {
    for (const code of ['EU', 'UN', 'ZZ', 'XA', 'AN', 'CS', 'YU', 'XK', 'pk', 'PAK', '']) {
      expect(isCountryCode(code)).toBe(false);
    }
  });
});
