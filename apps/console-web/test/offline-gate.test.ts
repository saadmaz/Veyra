import { createHash } from 'node:crypto';
import type { OfflineListResponse } from '@veyra/api-contracts';
import { describe, expect, it } from 'vitest';
import {
  checkOffline,
  hashCode,
  hashToken,
  type QueuedEntry,
  queuedAdmissionsByPass,
} from '../src/lib/offline-gate';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('hashing matches the API', () => {
  it('hashes tokens and per-property codes the same way the server stores them', async () => {
    expect(await hashToken('abc')).toBe(sha('token:abc'));
    // Any case and spacing of a code hashes the same.
    expect(await hashCode('p1', 'k7q2 m9-xa')).toBe(sha('code:p1:K7Q2M9XA'));
    expect(await hashCode('p2', 'K7Q2M9XA')).not.toBe(await hashCode('p1', 'K7Q2M9XA'));
  });
});

describe('checkOffline', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const entry = {
    invitationId: 'i1',
    passId: 'p1',
    tokenHash: 't1',
    codeHash: 'c1',
    category: 'GUEST' as const,
    visitorName: 'Vera Visitor',
    vehiclePlate: null,
    unitNumber: '101',
    validFrom: '2026-11-11T10:00:00Z',
    validUntil: '2026-11-11T14:00:00Z',
    entriesLeft: 1,
  };
  const list: OfflineListResponse = {
    propertyId: 'prop',
    generatedAt: '2026-11-11T09:00:00Z',
    trustUntil: '2026-11-11T13:00:00Z',
    entries: [entry],
  };
  const none = new Map<string, number>();

  it('finds a pass by token or by code', () => {
    expect(checkOffline(list, { tokenHash: 't1' }, none, now)).toEqual({ valid: true, entry });
    expect(checkOffline(list, { codeHash: 'c1' }, none, now)).toEqual({ valid: true, entry });
    expect(checkOffline(list, { codeHash: 'zz' }, none, now)).toEqual({
      valid: false,
      reason: 'NOT_FOUND',
    });
  });

  it('refuses everything once the list is past its 4-hour trust, or without a list', () => {
    expect(
      checkOffline(list, { tokenHash: 't1' }, none, Date.parse('2026-11-11T13:00:01Z')),
    ).toEqual({ valid: false, reason: 'LIST_EXPIRED' });
    expect(checkOffline(null, { tokenHash: 't1' }, none, now)).toEqual({
      valid: false,
      reason: 'NO_LIST',
    });
  });

  it('respects the window and counts admissions already queued on this device', () => {
    expect(
      checkOffline(list, { tokenHash: 't1' }, none, Date.parse('2026-11-11T09:59:00Z')),
    ).toEqual({ valid: false, reason: 'NOT_YET_VALID' });
    const queue: QueuedEntry[] = [
      {
        label: 'Vera Visitor admitted',
        entry: { clientRef: 'r1', kind: 'ADMIT', occurredAt: '2026-11-11T11:00:00Z', passId: 'p1' },
      },
      {
        label: 'Someone refused',
        entry: {
          clientRef: 'r2',
          kind: 'DENY',
          occurredAt: '2026-11-11T11:00:00Z',
          passId: 'p1',
          reason: 'x',
        },
      },
    ];
    const queued = queuedAdmissionsByPass(queue);
    expect(queued.get('p1')).toBe(1);
    expect(checkOffline(list, { tokenHash: 't1' }, queued, now)).toEqual({
      valid: false,
      reason: 'NO_ENTRIES_LEFT',
    });
  });
});
