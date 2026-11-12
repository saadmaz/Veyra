import { describe, expect, it } from 'vitest';
import { accountEmail } from '../src/templates/account';

const at = new Date('2026-11-12T10:00:00Z');

describe('account emails', () => {
  it('carry the link, the expiry and what to do if it was not you', () => {
    const e = accountEmail({
      kind: 'reset-password',
      displayName: 'Ada <Admin>',
      url: 'https://console.veyra.example/reset-password?token=abc',
      expiresAt: at,
    });
    expect(e.subject).toBe('Reset your VEYRA password');
    expect(e.text).toContain('https://console.veyra.example/reset-password?token=abc');
    expect(e.text).toContain('2026-11-12 10:00 UTC');
    expect(e.html).toContain('Ada &lt;Admin&gt;');
    expect(e.html).not.toContain('<Admin>');
  });

  it('refuse links that are not HTTPS, except localhost in development', () => {
    const input = { kind: 'verify-email' as const, displayName: 'Ada', expiresAt: at };
    expect(() => accountEmail({ ...input, url: 'http://evil.example/x' })).toThrow(/HTTPS/);
    expect(
      accountEmail({ ...input, url: 'http://localhost:3000/verify-email?token=x' }).subject,
    ).toBe('Confirm your email address for VEYRA');
  });
});
