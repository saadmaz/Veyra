import { describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET,
  createInvitationSchema,
  denySchema,
  formatCode,
  hashCode,
  hashToken,
  newPassSecret,
  normaliseCode,
  type PassState,
  passRejection,
  validatePassSchema,
} from '../../src/modules/visitors/domain/visitor-rules';

const now = new Date('2026-11-11T12:00:00Z');
const state = (overrides: Partial<PassState> = {}): PassState => ({
  passRevoked: false,
  invitationStatus: 'ACTIVE',
  validFrom: new Date('2026-11-11T10:00:00Z'),
  validUntil: new Date('2026-11-11T14:00:00Z'),
  maxEntries: 1,
  entriesUsed: 0,
  hostStillResident: true,
  ...overrides,
});

describe('passRejection', () => {
  it('accepts a live pass inside its window with entries left', () => {
    expect(passRejection(state(), now)).toBeNull();
  });

  it('gives the first reason that applies, revocation first', () => {
    expect(passRejection(state({ passRevoked: true, entriesUsed: 1 }), now)).toBe('REVOKED');
    expect(passRejection(state({ invitationStatus: 'REVOKED' }), now)).toBe('REVOKED');
    expect(passRejection(state({ validFrom: new Date('2026-11-11T13:00:00Z') }), now)).toBe(
      'NOT_YET_VALID',
    );
    expect(passRejection(state({ validUntil: new Date('2026-11-11T11:59:59Z') }), now)).toBe(
      'EXPIRED',
    );
    expect(passRejection(state({ entriesUsed: 1 }), now)).toBe('NO_ENTRIES_LEFT');
    expect(passRejection(state({ hostStillResident: false }), now)).toBe('HOST_NO_LONGER_RESIDENT');
  });

  it('treats the window ends as inclusive', () => {
    expect(passRejection(state(), new Date('2026-11-11T10:00:00Z'))).toBeNull();
    expect(passRejection(state(), new Date('2026-11-11T14:00:00Z'))).toBeNull();
  });
});

describe('pass secrets', () => {
  it('draws a 43-character token and an 8-character code without look-alikes', () => {
    const { token, code } = newPassSecret();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{8}$`));
    for (const ambiguous of ['0', 'O', '1', 'I', 'L'])
      expect(CODE_ALPHABET).not.toContain(ambiguous);
    expect(formatCode('K7Q2M9XA')).toBe('K7Q2-M9XA');
  });

  it('hashes codes per property and ignores case, spaces and hyphens', () => {
    expect(normaliseCode(' k7q2-m9xa ')).toBe('K7Q2M9XA');
    expect(hashCode('p1', 'k7q2-m9xa')).toBe(hashCode('p1', 'K7Q2M9XA'));
    expect(hashCode('p1', 'K7Q2M9XA')).not.toBe(hashCode('p2', 'K7Q2M9XA'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).not.toBe(hashCode('p1', 'abc'));
  });
});

describe('input rules', () => {
  const valid = {
    category: 'GUEST',
    visitorName: ' Vera Visitor ',
    visitorPhone: '+92 300 123-4567',
    vehiclePlate: 'abc 123',
    validFrom: '2026-11-12T18:00:00+05:00',
    validUntil: '2026-11-12T22:00:00+05:00',
  };

  it('normalises an invitation and defaults to one entry', () => {
    const parsed = createInvitationSchema.parse(valid);
    expect(parsed).toMatchObject({
      visitorName: 'Vera Visitor',
      visitorPhone: '+923001234567',
      vehiclePlate: 'ABC123',
      maxEntries: 1,
    });
    expect(parsed.validFrom.toISOString()).toBe('2026-11-12T13:00:00.000Z');
  });

  it('rejects local times without a zone, reversed or over-long windows and bad entry counts', () => {
    for (const change of [
      { validFrom: '2026-11-12T18:00:00' },
      { validUntil: '2026-11-12T17:00:00+05:00' },
      { validUntil: '2026-12-14T18:00:00+05:00' },
      { maxEntries: 0 },
      { maxEntries: 51 },
      { category: 'VIP' },
    ]) {
      expect(
        createInvitationSchema.safeParse({ ...valid, ...change }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
  });

  it('needs exactly one of token or code at the gate', () => {
    expect(validatePassSchema.safeParse({}).success).toBe(false);
    expect(validatePassSchema.safeParse({ token: 'x'.repeat(43), code: 'K7Q2-M9XA' }).success).toBe(
      false,
    );
    expect(validatePassSchema.parse({ code: 'k7q2 m9xa' }).code).toBe('K7Q2M9XA');
    expect(validatePassSchema.safeParse({ code: 'K7Q2-M9X0' }).success).toBe(false);
  });

  it('needs a name and category to deny someone without a pass', () => {
    expect(denySchema.safeParse({ reason: 'No ID' }).success).toBe(false);
    expect(
      denySchema.safeParse({ reason: 'No ID', category: 'GUEST', visitorName: 'Ola' }).success,
    ).toBe(true);
  });
});
