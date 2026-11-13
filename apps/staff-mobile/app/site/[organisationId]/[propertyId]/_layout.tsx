import type { PropertyDetailResponse } from '@veyra/api-contracts';
import { Stack } from 'expo-router';
import { useMemo } from 'react';
import { Loaded, Screen, usePalette } from '@/components/ui';
import { GateProvider } from '@/lib/gate-context';
import { SiteProvider, useSiteParams } from '@/lib/site';
import { useApiQuery } from '@/lib/use-api';

/** Loads the property once for all of its screens (time zone, permissions). */
export default function SiteLayout() {
  const palette = usePalette();
  const params = useSiteParams();
  const property = useApiQuery<PropertyDetailResponse>(params.base);
  const site = useMemo(
    () =>
      property.status === 'success'
        ? {
            ...params,
            property: property.data,
            can: (permission: string) => property.data.permissions.includes(permission),
          }
        : null,
    [params, property],
  );

  if (!site) {
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: true, title: 'Workplace' }} />
        <Loaded query={property}>{() => null}</Loaded>
      </Screen>
    );
  }
  const stack = (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: palette.surface },
        headerTintColor: palette.text,
        contentStyle: { backgroundColor: palette.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: site.property.name }} />
      <Stack.Screen name="gate" options={{ title: 'Gate' }} />
      <Stack.Screen name="walk-in" options={{ title: 'Walk-in visitor' }} />
      <Stack.Screen name="inside" options={{ title: 'Inside now' }} />
      <Stack.Screen name="work/index" options={{ title: 'My work' }} />
      <Stack.Screen name="work/[workOrderId]" options={{ title: 'Work order' }} />
      <Stack.Screen name="incident" options={{ title: 'Report an incident' }} />
      <Stack.Screen name="shifts" options={{ title: 'My shifts' }} />
    </Stack>
  );
  return (
    <SiteProvider site={site}>
      {site.can('property.visitor.check_in') ? (
        <GateProvider propertyId={site.propertyId} base={site.base}>
          {stack}
        </GateProvider>
      ) : (
        stack
      )}
    </SiteProvider>
  );
}
