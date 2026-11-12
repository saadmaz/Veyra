import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, cspHeaders, originOf } from '../src/csp';

describe('Content-Security-Policy', () => {
  it('allows only the named origins and forbids framing, plugins and foreign forms', () => {
    const csp = contentSecurityPolicy({
      connect: [
        'https://api.veyra.example',
        'https://storage.veyra.example',
        'https://api.veyra.example',
      ],
      images: ['https://storage.veyra.example'],
    });
    expect(csp).toContain(
      "connect-src 'self' https://api.veyra.example https://storage.veyra.example;",
    );
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain('unsafe-eval');
    expect(contentSecurityPolicy({ connect: [], development: true })).toContain("'unsafe-eval'");
    expect(cspHeaders({ connect: [] })[0]?.headers[0]?.key).toBe('Content-Security-Policy');
  });

  it('takes origins from URLs', () => {
    expect(originOf('http://localhost:4000/api/v1')).toBe('http://localhost:4000');
    expect(originOf('not a url')).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});
