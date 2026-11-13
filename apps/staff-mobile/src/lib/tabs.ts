import type { IconName } from '@/components/icon';

/** A bottom tab: a path below the home's route, plus paths that count as part of it. */
export interface TabDef {
  key: string;
  label: string;
  /** First path segment below the home route; '' is the home screen itself. */
  path: string;
  icon: IconName;
  /** Other first segments that belong to this tab (e.g. walk-in under Gate). */
  also?: string[];
  /** Permission needed to show the tab (UI only; the API decides). */
  permission?: string;
}

export const STAFF_TABS: TabDef[] = [
  { key: 'home', label: 'Home', path: '', icon: 'home' },
  {
    key: 'gate',
    label: 'Gate',
    path: 'gate',
    icon: 'qr',
    also: ['walk-in', 'inside'],
    permission: 'property.visitor.check_in',
  },
  {
    key: 'work',
    label: 'Work',
    path: 'work',
    icon: 'wrench',
    permission: 'property.maintenance.work',
  },
  {
    key: 'shifts',
    label: 'Shifts',
    path: 'shifts',
    icon: 'clock',
    permission: 'property.staff.work',
  },
  {
    key: 'report',
    label: 'Report',
    path: 'incident',
    icon: 'alert',
    permission: 'property.incident.report',
  },
];

/** The tab the current screen belongs to, or undefined for screens outside every tab. */
export function activeTab(pathname: string, route: string, tabs: TabDef[]): string | undefined {
  if (pathname !== route && !pathname.startsWith(`${route}/`)) return undefined;
  const first = pathname.slice(route.length).split('/').filter(Boolean)[0] ?? '';
  return tabs.find((t) => t.path === first || t.also?.includes(first))?.key;
}

/** Tabs the person may use here; hiding the rest is a convenience, the API still checks. */
export function visibleTabs(tabs: TabDef[], can: (permission: string) => boolean): TabDef[] {
  return tabs.filter((t) => !t.permission || can(t.permission));
}
