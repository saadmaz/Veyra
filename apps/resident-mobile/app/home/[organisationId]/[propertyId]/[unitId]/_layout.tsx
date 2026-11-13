import type { UnitDetailResponse } from '@veyra/api-contracts';
import { Stack } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';
import { TabBar } from '@/components/tab-bar';
import { Loaded, Screen, usePalette } from '@/components/ui';
import { HomeProvider, useHomeParams } from '@/lib/home';
import { RESIDENT_TABS, visibleTabs } from '@/lib/tabs';
import { useApiQuery } from '@/lib/use-api';

/** Loads the home once for all of its screens (time zone, permissions). */
export default function HomeLayout() {
  const palette = usePalette();
  const params = useHomeParams();
  const unit = useApiQuery<UnitDetailResponse>(params.unitPath);
  const home = useMemo(
    () =>
      unit.status === 'success'
        ? {
            ...params,
            unit: unit.data,
            can: (permission: string) => unit.data.permissions.includes(permission),
          }
        : null,
    [params, unit],
  );

  if (!home) {
    return (
      <Screen>
        <Stack.Screen options={{ headerShown: true, title: 'Home' }} />
        <Loaded query={unit}>{() => null}</Loaded>
      </Screen>
    );
  }
  return (
    <HomeProvider home={home}>
      <View style={{ flex: 1, backgroundColor: palette.bg }}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: palette.surface },
            headerTintColor: palette.text,
            contentStyle: { backgroundColor: palette.bg },
          }}
        >
          <Stack.Screen name="index" options={{ title: `Unit ${home.unit.unitNumber}` }} />
          <Stack.Screen name="visitors" options={{ title: 'Visitors' }} />
          <Stack.Screen name="new-pass" options={{ title: 'New visitor pass' }} />
          <Stack.Screen name="maintenance/index" options={{ title: 'Maintenance' }} />
          <Stack.Screen name="maintenance/new" options={{ title: 'Report a problem' }} />
          <Stack.Screen name="maintenance/[requestId]" options={{ title: 'Request' }} />
          <Stack.Screen name="bookings/index" options={{ title: 'Bookings' }} />
          <Stack.Screen name="bookings/[facilityId]" options={{ title: 'Book' }} />
          <Stack.Screen name="bills/index" options={{ title: 'Bills' }} />
          <Stack.Screen name="bills/[invoiceId]" options={{ title: 'Invoice' }} />
          <Stack.Screen name="documents" options={{ title: 'Documents' }} />
          <Stack.Screen name="inbox" options={{ title: 'Inbox' }} />
        </Stack>
        <TabBar route={home.route} tabs={visibleTabs(RESIDENT_TABS, home.can)} />
      </View>
    </HomeProvider>
  );
}
