import { describe, expect, it } from 'vitest';
import { activeTab, RESIDENT_TABS, visibleTabs } from '../src/lib/tabs';

const route = '/home/o1/p1/u1';

describe('resident tabs', () => {
  it('marks the tab of the current screen', () => {
    expect(activeTab(route, route, RESIDENT_TABS)).toBe('home');
    expect(activeTab(`${route}/visitors`, route, RESIDENT_TABS)).toBe('visitors');
    expect(activeTab(`${route}/new-pass`, route, RESIDENT_TABS)).toBe('visitors');
    expect(activeTab(`${route}/maintenance/r1`, route, RESIDENT_TABS)).toBe('requests');
    expect(activeTab(`${route}/bills/i1`, route, RESIDENT_TABS)).toBe('bills');
  });

  it('marks no tab for screens outside the tabs, or outside this home', () => {
    expect(activeTab(`${route}/documents`, route, RESIDENT_TABS)).toBeUndefined();
    expect(activeTab('/home/o1/p1/u10', route, RESIDENT_TABS)).toBeUndefined();
  });

  it('hides tabs the person has no permission for', () => {
    const keys = visibleTabs(RESIDENT_TABS, (p) => p === 'unit.visitor.invite').map((t) => t.key);
    expect(keys).toEqual(['home', 'visitors', 'inbox']);
  });
});
