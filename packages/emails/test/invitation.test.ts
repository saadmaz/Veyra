import { describe, expect, it } from 'vitest';
import { escapeHtml, invitationEmail } from '../src';

const base = {
  inviteeName: 'Amina',
  inviterName: 'Tower Management',
  organisationName: 'Skyline Estates',
  propertyName: 'Skyline Residences',
  roleLabel: 'Owner',
  acceptUrl: 'https://app.veyra.test/invitations/accept?token=abc123',
  expiresAt: new Date('2026-11-15T09:30:00Z'),
};

describe('invitationEmail', () => {
  it('renders subject, html and plain text with the accept link and expiry', () => {
    const email = invitationEmail(base);
    expect(email.subject).toBe(
      'Tower Management invited you to Skyline Residences (Skyline Estates) on VEYRA',
    );
    expect(email.html).toContain('href="https://app.veyra.test/invitations/accept?token=abc123"');
    expect(email.text).toContain('Accept the invitation: https://app.veyra.test/invitations/');
    expect(email.text).toContain('2026-11-15 09:30 UTC');
  });

  it('escapes user-controlled values in HTML', () => {
    const email = invitationEmail({ ...base, inviterName: '<script>alert(1)</script>' });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });

  it('falls back to a generic greeting and organisation-only scope', () => {
    const email = invitationEmail({ ...base, inviteeName: null, propertyName: null });
    expect(email.text.startsWith('Hello,')).toBe(true);
    expect(email.subject).toContain('to Skyline Estates on VEYRA');
  });

  it('rejects non-HTTPS links', () => {
    expect(() => invitationEmail({ ...base, acceptUrl: 'http://app.veyra.test/x' })).toThrow();
    expect(() => invitationEmail({ ...base, acceptUrl: 'javascript:alert(1)' })).toThrow();
  });
});

describe('escapeHtml', () => {
  it('escapes all HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});
