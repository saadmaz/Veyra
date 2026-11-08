import { baselineSecurityHeaders } from '@veyra/web-config';
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('marketing-web next.config', () => {
  it('applies the shared baseline security headers and stays indexable', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules).toEqual(baselineSecurityHeaders);
    expect(rules.flatMap((r) => r.headers).some((h) => h.key === 'X-Robots-Tag')).toBe(false);
  });
});
