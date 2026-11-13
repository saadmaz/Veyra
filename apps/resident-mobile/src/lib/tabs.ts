import type { IconName } from '@/components/icon';

/** A bottom tab: a path below the home's route, plus paths that count as part of it. */
export interface TabDef {
  key: string;
  label: string;
  /** First path segment below the home route; '' is the home screen itself. */
  path: string;
  icon: IconName;
  /** Other first segments that belong to this tab (e.g. new-pass under Visitors). */
  also?: string[];
  /** Permission needed to show the tab (UI only; the API decides). */
  permission?: string;
}

export const RESIDENT_TABS: TabDef[] = [
  { key: 'home', label: 'Home', path: '', icon: 'home' },
  {
    key: 'visitors',
    label: 'Visitors',
    path: 'visitors',
    icon: 'qr',
    also: ['new-pass'],
    permission: 'unit.visitor.invite',
  },
  {
    key: 'requests',
    label: 'Requests',
    path: 'maintenance',
    icon: 'wrench',
    permission: 'unit.maintenance.request',
  },
  { key: 'bills', label: 'Bills', path: 'bills', icon: 'wallet', permission: 'unit.finance.read' },
  { key: 'inbox', label: 'Inbox', path: 'inbox', icon: 'inbox' },
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
