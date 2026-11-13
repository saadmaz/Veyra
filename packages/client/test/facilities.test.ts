import type { FacilityDto } from '@veyra/api-contracts';
import { describe, expect, it } from 'vitest';
import { describeHours, describeRules, everyDay, formatDuration, todayIn } from '../src/facilities';

const facility: FacilityDto = {
  id: 'f',
  commonAreaId: 'a',
  name: 'Pool',
  type: 'POOL',
  description: null,
  status: 'ACTIVE',
  slotMinutes: 60,
  capacity: 1,
  approvalRequired: false,
  minNoticeMinutes: 0,
  maxAdvanceDays: 30,
  maxSlotsPerBooking: 2,
  maxUpcomingPerUnit: null,
  cancellationMinutes: 120,
  openingHours: everyDay('06:00', '22:00'),
  timeZone: 'Asia/Karachi',
  fee: null,
  deposit: null,
};

describe('facility helpers', () => {
  it('give the local date of a time zone', () => {
    // 21:00 UTC is already the next day in Karachi (UTC+5).
    expect(todayIn('Asia/Karachi', new Date('2026-11-12T21:00:00Z'))).toBe('2026-11-13');
  });

  it('describe durations and merge days with the same hours', () => {
    expect(formatDuration(90)).toBe('1 hour 30 minutes');
    expect(formatDuration(30)).toBe('30 minutes');
    expect(describeHours(everyDay('06:00', '22:00'))).toEqual(['Monday to Sunday: 06:00–22:00']);
    expect(
      describeHours([
        { weekday: 1, opensAt: '08:00', closesAt: '12:00' },
        { weekday: 2, opensAt: '08:00', closesAt: '12:00' },
        { weekday: 6, opensAt: '10:00', closesAt: '14:00' },
      ]),
    ).toEqual([
      'Monday to Tuesday: 08:00–12:00',
      'Wednesday to Friday: closed',
      'Saturday: 10:00–14:00',
      'Sunday: closed',
    ]);
  });

  it('put the booking rules in plain words', () => {
    expect(describeRules(facility)).toEqual([
      'Slots of 1 hour, up to 2 in a row.',
      'One booking at a time.',
      'Bookings are confirmed at once.',
      'Book up to 30 days ahead.',
      'Cancel here up to 2 hours before the start.',
    ]);
  });
});
