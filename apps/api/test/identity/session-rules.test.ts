import { describe, expect, it } from 'vitest';
import {
  initialExpiry,
  isSessionActive,
  refreshedIdleExpiry,
  SESSION_LIFETIMES,
  type SessionState,
} from '../../src/modules/identity/domain/session-policy';
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
} from '../../src/modules/identity/domain/session-token';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const t0 = new Date('2026-11-08T10:00:00.000Z');
const at = (ms: number) => new Date(t0.getTime() + ms);

describe('session tokens', () => {
  it('are 256-bit, URL-safe and unique', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateSessionToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
  });

  it('are stored only as a SHA-256 hash that differs from the token', () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashSessionToken(token));
    expect(hash).not.toContain(token);
  });

  it('rejects malformed tokens before any lookup', () => {
    expect(isWellFormedSessionToken(generateSessionToken())).toBe(true);
    for (const bad of ['', 'short', `${'a'.repeat(43)}=`, `${'a'.repeat(42)}!`, 'a'.repeat(44)]) {
      expect(isWellFormedSessionToken(bad)).toBe(false);
    }
  });
});

describe('session lifetimes', () => {
  it('web: 30 minutes idle, 7 days absolute', () => {
    expect(initialExpiry('WEB', t0)).toEqual({
      idleExpiresAt: at(30 * MINUTE),
      absoluteExpiresAt: at(7 * DAY),
    });
  });

  it('mobile: 30 days idle, 90 days absolute', () => {
    expect(initialExpiry('MOBILE', t0)).toEqual({
      idleExpiresAt: at(30 * DAY),
      absoluteExpiresAt: at(90 * DAY),
    });
  });

  it('never lets the idle expiry exceed the absolute expiry', () => {
    for (const lifetime of Object.values(SESSION_LIFETIMES)) {
      expect(lifetime.idleMs).toBeLessThanOrEqual(lifetime.absoluteMs);
    }
  });
});

describe('session activity', () => {
  const session = (overrides: Partial<SessionState> = {}): SessionState => ({
    client: 'WEB',
    lastSeenAt: t0,
    ...initialExpiry('WEB', t0),
    revokedAt: null,
    ...overrides,
  });

  it('is active until the idle expiry, then not', () => {
    expect(isSessionActive(session(), at(29 * MINUTE))).toBe(true);
    expect(isSessionActive(session(), at(30 * MINUTE))).toBe(false);
  });

  it('is never active after the absolute expiry, even with recent activity', () => {
    const s = session({ idleExpiresAt: at(8 * DAY) });
    expect(isSessionActive(s, at(7 * DAY))).toBe(false);
  });

  it('is never active once revoked', () => {
    expect(isSessionActive(session({ revokedAt: at(1) }), at(2))).toBe(false);
  });

  it('extends the idle expiry at most once per minute', () => {
    expect(refreshedIdleExpiry(session(), at(30_000))).toBeNull();
    expect(refreshedIdleExpiry(session(), at(MINUTE))).toEqual(at(31 * MINUTE));
  });

  it('caps the extension at the absolute expiry', () => {
    const s = session({ lastSeenAt: at(7 * DAY - 10 * MINUTE) });
    expect(refreshedIdleExpiry(s, at(7 * DAY - 5 * MINUTE))).toEqual(at(7 * DAY));
  });
});
