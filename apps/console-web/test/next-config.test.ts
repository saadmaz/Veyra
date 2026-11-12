import { baselineSecurityHeaders } from '@veyra/web-config';
import { describe, expect, it } from 'vitest';
import nextConfig, { consoleCspHeaders, gateCameraHeaders } from '../next.config';

describe('console-web next.config', () => {
  it('hides the framework banner', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it('applies the baseline headers and the CSP, then allows the camera on the gate only', async () => {
    const rules = await nextConfig.headers?.();
    expect(rules).toEqual([...baselineSecurityHeaders, ...consoleCspHeaders, ...gateCameraHeaders]);
    expect(gateCameraHeaders).toHaveLength(1);
    expect(gateCameraHeaders[0]?.source).toMatch(/\/gate$/);
    expect(gateCameraHeaders[0]?.headers).toEqual([
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
    ]);
  });

  it('lets the console call only the API and object storage', () => {
    const csp = consoleCspHeaders[0]?.headers[0]?.value ?? '';
    expect(csp).toContain("connect-src 'self' http://localhost:4000 http://localhost:8333");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
