import { describe, expect, it } from 'vitest';
import { fetchExport, fileNameFrom } from '../src/lib/reporting';

describe('reporting helpers', () => {
  it('read the file name of an export', () => {
    expect(fileNameFrom('attachment; filename="HVR-visits-2026-11-12.csv"', 'x.csv')).toBe(
      'HVR-visits-2026-11-12.csv',
    );
    expect(fileNameFrom(null, 'x.csv')).toBe('x.csv');
  });

  it('turn a refused export into an API error', async () => {
    const refused = async () =>
      new Response(JSON.stringify({ error: { code: 'RANGE_TOO_LONG', message: 'Too long' } }), {
        status: 422,
      });
    await expect(fetchExport('/x', refused as typeof fetch)).rejects.toMatchObject({
      status: 422,
      code: 'RANGE_TOO_LONG',
    });
  });
});
