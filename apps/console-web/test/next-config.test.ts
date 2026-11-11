import { baselineSecurityHeaders } from '@veyra/web-config';
import { describe, expect, it } from 'vitest';
import nextConfig, { gateCameraHeaders } from '../next.config';

describe('console-web next.config', () => {
  it('hides the framework banner', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it('applies the shared baseline security headers, then allows the camera on the gate only', async () => {
    const rules = await nextConfig.headers?.();
    expect(rules).toEqual([...baselineSecurityHeaders, ...gateCameraHeaders]);
    expect(gateCameraHeaders).toHaveLength(1);
    expect(gateCameraHeaders[0]?.source).toMatch(/\/gate$/);
    expect(gateCameraHeaders[0]?.headers).toEqual([
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
    ]);
  });
});
