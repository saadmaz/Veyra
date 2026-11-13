import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('links', () => {
  it('opens an email when a contact address is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTACT_EMAIL', 'hello@example.com');
    const { contactAction } = await import('../src/lib/links');
    expect(contactAction()).toEqual({ href: 'mailto:hello@example.com', label: 'Talk to us' });
  });

  it('falls back to starting a trial when no contact address is set', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTACT_EMAIL', '');
    vi.stubEnv('NEXT_PUBLIC_CONSOLE_URL', 'https://console.example.com/');
    const { contactAction, links } = await import('../src/lib/links');
    expect(links.signIn).toBe('https://console.example.com/sign-in');
    expect(contactAction()).toEqual({
      href: 'https://console.example.com/sign-up',
      label: 'Start free trial',
    });
  });
});
