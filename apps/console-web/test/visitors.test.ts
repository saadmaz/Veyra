import { describe, expect, it } from 'vitest';
import {
  formatInstant,
  formatTime,
  instantToZonedLocal,
  secondsUntil,
  zonedLocalToInstant,
} from '../src/lib/visitors';

describe('property-local times', () => {
  it("converts a wall-clock time at the property to an instant, whatever the device's zone", () => {
    expect(zonedLocalToInstant('2026-11-12T18:00', 'Asia/Karachi')).toBe(
      '2026-11-12T13:00:00.000Z',
    );
    expect(zonedLocalToInstant('2026-11-12T18:00', 'UTC')).toBe('2026-11-12T18:00:00.000Z');
    // Half-hour offset.
    expect(zonedLocalToInstant('2026-11-12T18:00', 'Asia/Kolkata')).toBe(
      '2026-11-12T12:30:00.000Z',
    );
  });

  it('handles daylight saving on both sides of the change', () => {
    // London: GMT until 29 March 2026, then BST (UTC+1).
    expect(zonedLocalToInstant('2026-03-28T12:00', 'Europe/London')).toBe(
      '2026-03-28T12:00:00.000Z',
    );
    expect(zonedLocalToInstant('2026-03-30T12:00', 'Europe/London')).toBe(
      '2026-03-30T11:00:00.000Z',
    );
  });

  it('rejects malformed input', () => {
    expect(zonedLocalToInstant('2026-11-12 18:00', 'UTC')).toBeNull();
    expect(zonedLocalToInstant('', 'UTC')).toBeNull();
  });

  it('round-trips instants to the inputs people see', () => {
    expect(instantToZonedLocal('2026-11-12T13:00:00.000Z', 'Asia/Karachi')).toBe(
      '2026-11-12T18:00',
    );
    expect(instantToZonedLocal(new Date('2026-03-30T11:00:00Z'), 'Europe/London')).toBe(
      '2026-03-30T12:00',
    );
  });

  it('formats instants in the property zone', () => {
    expect(formatInstant('2026-11-12T13:00:00.000Z', 'Asia/Karachi')).toBe('12 Nov 2026, 18:00');
    expect(formatTime('2026-11-12T13:05:00.000Z', 'Asia/Karachi')).toBe('18:05');
  });

  it('counts down to a deadline without going negative', () => {
    const now = Date.parse('2026-11-12T13:00:00Z');
    expect(secondsUntil('2026-11-12T13:01:30Z', now)).toBe(90);
    expect(secondsUntil('2026-11-12T12:59:00Z', now)).toBe(0);
  });
});
