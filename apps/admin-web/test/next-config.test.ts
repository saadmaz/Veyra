import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('admin-web next.config', () => {
  it('is never indexed by search engines', async () => {
    const headers = ((await nextConfig.headers?.()) ?? []).flatMap((r) => r.headers);
    expect(headers).toContainEqual({ key: 'X-Robots-Tag', value: 'noindex, nofollow' });
    expect(headers).toContainEqual({ key: 'X-Frame-Options', value: 'DENY' });
  });
});
