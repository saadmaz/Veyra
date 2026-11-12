import { describe, expect, it } from 'vitest';
import { JsonLogger, redact } from '../../src/platform/logging/json-logger';

describe('log redaction', () => {
  it('removes tokens, passwords, cookies, emails and query strings', () => {
    const token = 'x'.repeat(43);
    expect(redact(`Authorization: Bearer ${token}`)).toBe('Authorization: Bearer [redacted]');
    expect(redact('cookie=veyra_session=abc123; Path=/')).not.toContain('abc123');
    expect(redact('{"password":"hunter2-is-long"}')).toBe('{"password":"[redacted]"}');
    expect(redact('token=abcdef&next=/x')).toContain('token=[redacted]');
    expect(redact('mail to ada.admin@example.test failed')).toBe('mail to [email] failed');
    expect(redact('GET /verify-email?token=abc HTTP')).toBe('GET /verify-email?[redacted] HTTP');
    expect(redact(`session ${token} expired`)).toBe('session [redacted] expired');
    expect(redact('Delivery 0190e2a5-6b0c-7e3f-8a5d-1c2b3d4e5f61 accepted')).toBe(
      'Delivery 0190e2a5-6b0c-7e3f-8a5d-1c2b3d4e5f61 accepted',
    );
  });
});

describe('JSON logger', () => {
  it('writes one redacted JSON line per entry, at or above the minimum level', () => {
    const lines: string[] = [];
    const logger = new JsonLogger(
      'log',
      (l) => lines.push(l),
      () => new Date('2026-11-12T10:00:00Z'),
    );
    logger.debug('hidden', 'Ctx');
    logger.log('signed in ada@example.test', 'Auth');
    logger.error('boom', 'Error: boom\n    at x (/app?token=abc)', 'Http');
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      {
        time: '2026-11-12T10:00:00.000Z',
        level: 'info',
        context: 'Auth',
        message: 'signed in [email]',
      },
      {
        time: '2026-11-12T10:00:00.000Z',
        level: 'error',
        context: 'Http',
        message: 'boom',
        stack: 'Error: boom\n    at x (/app?[redacted])',
      },
    ]);
  });
});
