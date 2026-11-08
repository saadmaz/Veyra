import { baselineSecurityHeaders } from '@veyra/web-config';
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('console-web next.config', () => {
  it('hides the framework banner', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it('applies the shared baseline security headers', async () => {
    expect(await nextConfig.headers?.()).toEqual(baselineSecurityHeaders);
  });
});
