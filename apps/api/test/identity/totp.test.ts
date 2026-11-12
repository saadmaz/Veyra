import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  matchTotp,
  newRecoveryCodes,
  normaliseRecoveryCode,
  open,
  otpauthUri,
  seal,
  stepAt,
  totpCode,
} from '../../src/modules/identity/domain/totp';

// RFC 6238 appendix B: SHA-1 secret "12345678901234567890", 8-digit codes; we use the last 6.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
    ];
    for (const [time, eight] of vectors) {
      expect(totpCode(RFC_SECRET, Math.floor(time / 30))).toBe(eight.slice(2));
    }
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from('a secret of twenty b');
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('accepts one step of drift and never the same step twice', () => {
    const now = new Date('2026-11-12T10:00:10Z');
    const step = stepAt(now);
    const code = totpCode(RFC_SECRET, step);
    expect(matchTotp(RFC_SECRET, code, now, null)).toBe(step);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now, null)).toBeNull();
    expect(matchTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(matchTotp(RFC_SECRET, '12345', now, null)).toBeNull();
  });

  it('seals secrets so only the key opens them', () => {
    const key = Buffer.alloc(32, 1);
    const sealed = seal(key, 'JBSWY3DPEHPK3PXP');
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(open(key, sealed)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => open(Buffer.alloc(32, 2), sealed)).toThrow();
  });

  it('makes readable recovery codes and an authenticator link', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(normaliseRecoveryCode('7kq2 m9xd')).toBe('7KQ2M9XD');
    expect(otpauthUri('ABC', 'ada@example.test')).toBe(
      'otpauth://totp/VEYRA%3Aada%40example.test?secret=ABC&issuer=VEYRA&algorithm=SHA1&digits=6&period=30',
    );
  });
});
