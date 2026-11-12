import type { MaintenanceEventDto } from '@veyra/api-contracts';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/lib/api-client';
import {
  eventText,
  fileProblem,
  formatBytes,
  placeText,
  relativeTime,
} from '../src/lib/maintenance';
import { errorMessage } from '../src/lib/messages';

const event = (over: Partial<MaintenanceEventDto>): MaintenanceEventDto => ({
  id: 'e',
  type: 'STATUS_CHANGED',
  visibility: 'RESIDENT',
  from: 'SUBMITTED',
  to: 'ACCEPTED',
  body: null,
  actor: { userId: 'u', name: 'Mia Manager' },
  workOrderNumber: null,
  createdAt: '2026-11-12T10:00:00.000Z',
  ...over,
});

describe('maintenance helpers', () => {
  it('names the place', () => {
    expect(placeText({ unitNumber: '101', commonAreaName: null, locationDetail: 'Kitchen' })).toBe(
      'Unit 101 · Kitchen',
    );
    expect(placeText({ unitNumber: null, commonAreaName: 'Gym' })).toBe('Gym');
  });

  it('says what happened in plain words', () => {
    const names = (id: string) => (id === 't' ? 'Theo Technician' : 'someone');
    expect(eventText(event({ from: null, to: 'SUBMITTED' }), names)).toBe(
      'Request created by Mia Manager',
    );
    expect(eventText(event({}), names)).toBe('Request in hand (Mia Manager)');
    expect(
      eventText(event({ type: 'ASSIGNEE_CHANGED', to: 't', workOrderNumber: 'WO-000001' }), names),
    ).toBe('Work WO-000001 assigned to Theo Technician');
    expect(eventText(event({ type: 'SLA_BREACHED', to: 'RESPONSE', actor: null }), names)).toBe(
      'Response target missed',
    );
    expect(eventText(event({ type: 'PRIORITY_CHANGED', from: 'LOW', to: 'URGENT' }), names)).toBe(
      'Priority changed to Urgent by Mia Manager',
    );
  });

  it('checks a file before uploading it', () => {
    expect(fileProblem({ type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(fileProblem({ type: 'application/pdf', size: 10 * 1024 * 1024 })).toBeNull();
    expect(fileProblem({ type: 'image/svg+xml', size: 1000 })).toMatch(/photo/);
    expect(fileProblem({ type: 'image/png', size: 0 })).toMatch(/empty/);
    expect(fileProblem({ type: 'image/png', size: 10 * 1024 * 1024 + 1 })).toMatch(/10 MB/);
  });

  it('shows sizes and due times briefly', () => {
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
    const now = Date.parse('2026-11-12T10:00:00Z');
    expect(relativeTime('2026-11-12T10:30:00Z', now)).toBe('in 30 min');
    expect(relativeTime('2026-11-12T07:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-11-15T10:00:00Z', now)).toBe('in 3 d');
  });

  it('explains upload and storage errors', () => {
    for (const code of [
      'FILE_REJECTED',
      'UPLOAD_MISSING',
      'STORAGE_NOT_CONFIGURED',
      'ASSIGNEE_NOT_ALLOWED',
    ]) {
      expect(errorMessage(new ApiRequestError(409, code, 'raw'))).not.toBe('raw');
    }
  });
});
