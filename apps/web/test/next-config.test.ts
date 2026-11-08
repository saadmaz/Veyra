import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('next.config security baseline', () => {
  it('hides the framework banner', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it('sends baseline security headers on every route', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = rules.find((r) => r.source === '/:path*');
    const headers = Object.fromEntries((all?.headers ?? []).map((h) => [h.key, h.value]));
    expect(headers).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
  });
});
