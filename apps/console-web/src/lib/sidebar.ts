/**
 * Sidebar navigation, derived from the current URL. Only pages that exist are listed. Showing a
 * link is not a permission check: every page and API request checks access on its own, and
 * pages show a permission-denied state when the caller lacks it.
 */
export type NavIcon =
  | 'grid'
  | 'users'
  | 'shield'
  | 'qr'
  | 'wrench'
  | 'wallet'
  | 'calendar'
  | 'megaphone'
  | 'check'
  | 'landmark'
  | 'file'
  | 'box'
  | 'alert'
  | 'briefcase'
  | 'clipboard'
  | 'clock'
  | 'building'
  | 'inbox'
  | 'link'
  | 'lock';

export interface NavItem {
  label: string;
  href: string;
  icon: NavIcon;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

const PROPERTY_ITEMS: [string, string, NavIcon][] = [
  ['Overview', '', 'grid'],
  ['Residents', '/residents', 'users'],
  ['Visitors', '/visitors', 'shield'],
  ['Gate', '/gate', 'qr'],
  ['Maintenance', '/maintenance', 'wrench'],
  ['Finance', '/finance', 'wallet'],
  ['Facilities', '/facilities', 'calendar'],
  ['Announcements', '/announcements', 'megaphone'],
  ['Approvals', '/approvals', 'check'],
  ['Governance', '/committees', 'landmark'],
  ['Documents', '/documents', 'file'],
  ['Assets', '/assets', 'box'],
  ['Incidents', '/incidents', 'alert'],
  ['Staff & shifts', '/staff', 'briefcase'],
];

const WORK_ITEMS: [string, string, NavIcon][] = [
  ['My work', '/my-work', 'clipboard'],
  ['My shifts', '/my-shifts', 'clock'],
];

const ORGANISATION_ITEMS: [string, string, NavIcon][] = [
  ['Overview', '', 'building'],
  ['Inbox', '/inbox', 'inbox'],
  ['Vendors', '/vendors', 'briefcase'],
  ['Plan & billing', '/plan', 'wallet'],
  ['Webhooks', '/webhooks', 'link'],
];

/** Reads the organisation and property ids from a console path. */
export function routeIds(pathname: string): { organisationId?: string; propertyId?: string } {
  const match = /^\/organisations\/([^/]+)(?:\/properties\/([^/]+))?/.exec(pathname);
  const organisationId = match?.[1];
  const propertyId = match?.[2];
  return {
    ...(organisationId && organisationId !== 'new' ? { organisationId } : {}),
    ...(propertyId && propertyId !== 'new' ? { propertyId } : {}),
  };
}

export function sidebarGroups(pathname: string): NavGroup[] {
  const { organisationId, propertyId } = routeIds(pathname);
  const groups: NavGroup[] = [];
  if (organisationId && propertyId) {
    const base = `/organisations/${organisationId}/properties/${propertyId}`;
    const map = ([label, path, icon]: [string, string, NavIcon]) => ({
      label,
      href: `${base}${path}`,
      icon,
    });
    groups.push({ label: 'Property', items: PROPERTY_ITEMS.map(map) });
    groups.push({ label: 'My workspace', items: WORK_ITEMS.map(map) });
  }
  if (organisationId) {
    const base = `/organisations/${organisationId}`;
    groups.push({
      label: 'Organisation',
      items: ORGANISATION_ITEMS.map(([label, path, icon]) => ({
        label,
        href: `${base}${path}`,
        icon,
      })),
    });
  }
  groups.push({
    label: 'Account',
    items: [
      { label: 'All organisations', href: '/organisations', icon: 'building' },
      { label: 'Two-step sign-in', href: '/account/security', icon: 'lock' },
    ],
  });
  return groups;
}

/**
 * The single most specific item that contains the current path, so "Overview" is not marked
 * active on every page below it.
 */
export function activeHref(pathname: string, groups: NavGroup[]): string | undefined {
  let best: string | undefined;
  for (const item of groups.flatMap((g) => g.items)) {
    const matches = pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (matches && (!best || item.href.length > best.length)) best = item.href;
  }
  return best;
}
