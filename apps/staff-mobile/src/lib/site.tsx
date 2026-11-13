import type { PropertyDetailResponse } from '@veyra/api-contracts';
import { useLocalSearchParams } from 'expo-router';
import { createContext, type ReactNode, useContext } from 'react';

/*
 * The property (site) a set of staff screens is about, with what the API says this person may
 * do there. The screens only hide what the API would refuse anyway.
 */

/** Permissions that make a property a workplace in this app. */
export const STAFF_PERMISSIONS = [
  'property.visitor.check_in',
  'property.maintenance.work',
  'property.incident.report',
  'property.staff.work',
] as const;

export const isWorkplace = (permissions: readonly string[]) =>
  STAFF_PERMISSIONS.some((p) => permissions.includes(p));

export interface Site {
  organisationId: string;
  propertyId: string;
  /** API path of the property. */
  base: string;
  /** App route of the site, for links. */
  route: string;
  property: PropertyDetailResponse;
  can(permission: string): boolean;
}

const SiteContext = createContext<Site | null>(null);

export function useSiteParams() {
  const params = useLocalSearchParams<{ organisationId: string; propertyId: string }>();
  const organisationId = String(params.organisationId);
  const propertyId = String(params.propertyId);
  return {
    organisationId,
    propertyId,
    base: `/organisations/${organisationId}/properties/${propertyId}`,
    route: `/site/${organisationId}/${propertyId}`,
  };
}

export function SiteProvider({ site, children }: { site: Site; children: ReactNode }) {
  return <SiteContext.Provider value={site}>{children}</SiteContext.Provider>;
}

export function useSite(): Site {
  const site = useContext(SiteContext);
  if (!site) throw new Error('useSite outside a site');
  return site;
}
