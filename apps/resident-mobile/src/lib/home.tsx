import type { UnitDetailResponse } from '@veyra/api-contracts';
import { useLocalSearchParams } from 'expo-router';
import { createContext, type ReactNode, useContext } from 'react';

/*
 * The home (unit) a set of screens is about: its ids, the property's time zone and what the API
 * says this person may do there. The screens only hide what the API would refuse anyway.
 */

export interface Home {
  organisationId: string;
  propertyId: string;
  unitId: string;
  /** API path of the organisation, e.g. /organisations/o1. */
  orgPath: string;
  /** API path of the unit. */
  unitPath: string;
  /** App route of the home, for links. */
  route: string;
  unit: UnitDetailResponse;
  can(permission: string): boolean;
}

const HomeContext = createContext<Home | null>(null);

export function useHomeParams() {
  const params = useLocalSearchParams<{
    organisationId: string;
    propertyId: string;
    unitId: string;
  }>();
  const organisationId = String(params.organisationId);
  const propertyId = String(params.propertyId);
  const unitId = String(params.unitId);
  const orgPath = `/organisations/${organisationId}`;
  return {
    organisationId,
    propertyId,
    unitId,
    orgPath,
    unitPath: `${orgPath}/properties/${propertyId}/units/${unitId}`,
    route: `/home/${organisationId}/${propertyId}/${unitId}`,
  };
}

export function HomeProvider({ home, children }: { home: Home; children: ReactNode }) {
  return <HomeContext.Provider value={home}>{children}</HomeContext.Provider>;
}

export function useHome(): Home {
  const home = useContext(HomeContext);
  if (!home) throw new Error('useHome outside a home');
  return home;
}
