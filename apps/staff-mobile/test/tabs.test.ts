import { describe, expect, it } from 'vitest';
import { activeTab, STAFF_TABS, visibleTabs } from '../src/lib/tabs';

const route = '/site/o1/p1';

describe('staff tabs', () => {
  it('marks the tab of the current screen', () => {
    expect(activeTab(route, route, STAFF_TABS)).toBe('home');
    expect(activeTab(`${route}/walk-in`, route, STAFF_TABS)).toBe('gate');
    expect(activeTab(`${route}/inside`, route, STAFF_TABS)).toBe('gate');
    expect(activeTab(`${route}/work/w1`, route, STAFF_TABS)).toBe('work');
    expect(activeTab(`${route}/incident`, route, STAFF_TABS)).toBe('report');
  });

  it('marks no tab outside this site', () => {
    expect(activeTab('/site/o1/p2/gate', route, STAFF_TABS)).toBeUndefined();
  });

  it('shows only the tabs the role can use', () => {
    const keys = visibleTabs(STAFF_TABS, (p) => p === 'property.maintenance.work').map(
      (t) => t.key,
    );
    expect(keys).toEqual(['home', 'work']);
  });
});
