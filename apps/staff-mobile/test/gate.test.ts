import type { OfflineListResponse } from '@veyra/api-contracts';
import { checkOffline, type QueuedEntry, queuedAdmissionsByPass } from '@veyra/client/offline-gate';
import { describe, expect, it } from 'vitest';
import { listMinutesLeft, OFFLINE_MESSAGES, readSyncResults, stampEntry } from '../src/lib/gate';

const queued = (ref: string, label: string, passId = 'p1'): QueuedEntry => ({
  label,
  entry: { clientRef: ref, kind: 'ADMIT', passId, occurredAt: '2026-11-13T10:00:00.000Z' },
});

describe('readSyncResults', () => {
  it('counts recorded, flagged and refused entries and keeps unanswered ones queued', () => {
    const batch = [
      queued('a', 'Visitor A'),
      queued('b', 'Visitor B'),
      queued('c', 'Visitor C'),
      queued('d', 'Visitor D'),
    ];
    const { summary, answered } = readSyncResults(
      batch,
      [
        { clientRef: 'a', status: 'RECORDED', visitId: 'v1', reviewReason: null },
        { clientRef: 'b', status: 'ALREADY_RECORDED', visitId: 'v2', reviewReason: 'PASS_EXPIRED' },
        { clientRef: 'c', status: 'REJECTED', error: 'PASS_NOT_FOUND' },
      ],
      new Date('2026-11-13T10:05:00Z'),
    );
    expect(summary).toEqual({
      at: '2026-11-13T10:05:00.000Z',
      recorded: 2,
      flagged: ['Visitor B'],
      failed: [{ label: 'Visitor C', error: 'PASS_NOT_FOUND' }],
    });
    expect([...answered].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('offline gate on a device', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const list: OfflineListResponse = {
    propertyId: 'prop',
    generatedAt: '2026-11-13T11:00:00Z',
    trustUntil: '2026-11-13T15:00:00Z',
    entries: [
      {
        invitationId: 'i1',
        passId: 'p1',
        tokenHash: 't1',
        codeHash: 'c1',
        category: 'GUEST',
        visitorName: 'Guest',
        vehiclePlate: null,
        unitNumber: '101',
        validFrom: '2026-11-13T09:00:00Z',
        validUntil: '2026-11-13T18:00:00Z',
        entriesLeft: 1,
      },
    ],
  };

  it('stamps entries with their own reference and the real time', () => {
    expect(stampEntry({ kind: 'DEPART', visitId: 'v1' }, 'ref-1', new Date(now))).toEqual({
      kind: 'DEPART',
      visitId: 'v1',
      clientRef: 'ref-1',
      occurredAt: '2026-11-13T12:00:00.000Z',
    });
  });

  it('counts admissions queued on this device against the entries left', () => {
    const counts = queuedAdmissionsByPass([queued('a', 'Guest')]);
    expect(checkOffline(list, { tokenHash: 't1' }, new Map(), now)).toMatchObject({ valid: true });
    expect(checkOffline(list, { tokenHash: 't1' }, counts, now)).toEqual({
      valid: false,
      reason: 'NO_ENTRIES_LEFT',
    });
  });

  it('never decides on an expired or missing list, and says what to do', () => {
    const later = Date.parse('2026-11-13T15:01:00Z');
    expect(checkOffline(list, { codeHash: 'c1' }, new Map(), later)).toEqual({
      valid: false,
      reason: 'LIST_EXPIRED',
    });
    expect(checkOffline(null, { codeHash: 'c1' }, new Map(), now).valid).toBe(false);
    expect(OFFLINE_MESSAGES.LIST_EXPIRED).toMatch(/paper procedure/);
    expect(OFFLINE_MESSAGES.NO_LIST).toMatch(/paper procedure/);
    expect(OFFLINE_MESSAGES.EXPIRED).toMatch(/expired/);
  });

  it('shows how long the saved list can still be trusted', () => {
    expect(listMinutesLeft(list.trustUntil, now)).toBe(180);
    expect(listMinutesLeft(list.trustUntil, Date.parse('2026-11-13T16:00:00Z'))).toBeNull();
    expect(listMinutesLeft(undefined, now)).toBeNull();
  });
});
