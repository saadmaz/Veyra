import { describe, expect, it } from 'vitest';
import {
  meetingAllows,
  resolutionSchema,
  seatCurrent,
  seatSchema,
} from '../../src/modules/governance/domain/governance-rules';

describe('governance rules', () => {
  it('tell whether a seat is held today', () => {
    expect(seatCurrent({ termStart: '2026-01-01', termEnd: null }, '2026-11-12')).toBe(true);
    expect(seatCurrent({ termStart: '2026-01-01', termEnd: '2026-11-12' }, '2026-11-12')).toBe(
      true,
    );
    expect(seatCurrent({ termStart: '2026-01-01', termEnd: '2026-06-30' }, '2026-11-12')).toBe(
      false,
    );
    expect(seatCurrent({ termStart: '2027-01-01', termEnd: null }, '2026-11-12')).toBe(false);
  });

  it('allow what each meeting state allows', () => {
    const scheduled = { status: 'SCHEDULED' as const, minutesApproved: false };
    const held = { status: 'HELD' as const, minutesApproved: false };
    const approved = { status: 'HELD' as const, minutesApproved: true };
    const cancelled = { status: 'CANCELLED' as const, minutesApproved: false };
    expect(meetingAllows(scheduled, 'agenda')).toBe(true);
    expect(meetingAllows(scheduled, 'minutes')).toBe(false);
    expect(meetingAllows(held, 'resolution')).toBe(true);
    expect(meetingAllows(held, 'agenda')).toBe(false);
    expect(meetingAllows(approved, 'minutes')).toBe(false);
    expect(meetingAllows(approved, 'resolution')).toBe(false);
    expect(meetingAllows(cancelled, 'hold')).toBe(false);
  });

  it('check terms and vote counts', () => {
    const id = '0190a0a0-0000-7000-8000-000000000000';
    expect(
      seatSchema.safeParse({
        userId: id,
        position: 'CHAIR',
        termStart: '2026-01-01',
        termEnd: '2025-12-31',
      }).success,
    ).toBe(false);
    expect(
      seatSchema.safeParse({ userId: id, position: 'CHAIR', termStart: '2026-01-01' }).success,
    ).toBe(true);
    const r = { title: 'Repaint', text: 'Approved', outcome: 'PASSED' };
    expect(resolutionSchema.safeParse({ ...r, votesFor: -1 }).success).toBe(false);
    expect(resolutionSchema.safeParse({ ...r, votesFor: 5, abstentions: 1 }).success).toBe(true);
  });
});
