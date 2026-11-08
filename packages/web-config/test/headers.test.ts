import { describe, expect, it } from 'vitest';
import { baselineSecurityHeaders, noIndexHeaders } from '../src';

const asMap = (rules: typeof baselineSecurityHeaders) =>
  Object.fromEntries(rules.flatMap((r) => r.headers).map((h) => [h.key, h.value]));

describe('baselineSecurityHeaders', () => {
  it('applies to every route', () => {
    expect(baselineSecurityHeaders.map((r) => r.source)).toEqual(['/:path*']);
  });

  it('includes the required security headers', () => {
    expect(asMap(baselineSecurityHeaders)).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    expect(asMap(baselineSecurityHeaders)['Strict-Transport-Security']).toMatch(/max-age=\d+/);
  });

  it('marks internal tools as non-indexable', () => {
    expect(asMap(noIndexHeaders)['X-Robots-Tag']).toBe('noindex, nofollow');
  });
});
