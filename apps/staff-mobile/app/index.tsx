import type {
  MyOrganisationDto,
  Paginated,
  PropertyDetailResponse,
  PropertyDto,
} from '@veyra/api-contracts';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Button, Card, ErrorText, Muted, Screen, Title, usePalette } from '@/components/ui';
import { useClient, useSession } from '@/lib/session';
import { isWorkplace } from '@/lib/site';

interface Workplace {
  organisationId: string;
  organisationName: string;
  property: PropertyDto;
}

type State =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; places: Workplace[] };

/** The properties where this person works (gate, maintenance, incidents or shifts). */
export default function WorkplacesScreen() {
  const { state, signOut } = useSession();
  const client = useClient();
  const router = useRouter();
  const palette = usePalette();
  const [places, setPlaces] = useState<State>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const orgs = await client.get<{ data: MyOrganisationDto[] }>('/organisations');
      const lists = await Promise.all(
        orgs.data.map(async ({ organisation }) => {
          const base = `/organisations/${organisation.id}/properties`;
          const properties = await client.get<Paginated<PropertyDto>>(`${base}?limit=50`);
          const details = await Promise.all(
            properties.data.map((p) =>
              client.get<PropertyDetailResponse>(`${base}/${p.id}`).catch(() => null),
            ),
          );
          return details
            .filter((d): d is PropertyDetailResponse => d !== null && isWorkplace(d.permissions))
            .map((property) => ({
              organisationId: organisation.id,
              organisationName: organisation.name,
              property,
            }));
        }),
      );
      setPlaces({ status: 'ready', places: lists.flat() });
    } catch (error) {
      setPlaces({ status: 'error', error });
    } finally {
      setRefreshing(false);
    }
  }, [client]);

  useEffect(() => {
    if (state.status === 'signed-in') void load();
  }, [state.status, load]);

  if (state.status === 'unconfigured') {
    return (
      <Screen>
        <Title>This app is not set up</Title>
        <Muted>
          It was built without the address of the VEYRA service. Ask your supervisor for the right
          app.
        </Muted>
      </Screen>
    );
  }
  if (state.status !== 'signed-in') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: palette.bg }}>
        <ActivityIndicator color={palette.accent} accessibilityLabel="Loading" />
      </View>
    );
  }

  const open = (w: Workplace) => router.push(`/site/${w.organisationId}/${w.property.id}`);
  return (
    <Screen
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void load();
      }}
    >
      <Muted>Signed in as {state.user.displayName}</Muted>
      {places.status === 'loading' ? (
        <ActivityIndicator color={palette.accent} accessibilityLabel="Loading" />
      ) : null}
      {places.status === 'error' ? (
        <>
          <ErrorText error={places.error} />
          <Button title="Try again" variant="secondary" onPress={() => void load()} />
        </>
      ) : null}
      {places.status === 'ready' && places.places.length === 0 ? (
        <Card>
          <Title>No workplaces</Title>
          <Muted>Your account has no staff role at a property yet. Ask your supervisor.</Muted>
        </Card>
      ) : null}
      {places.status === 'ready'
        ? places.places.map((w) => (
            <Card key={w.property.id} onPress={() => open(w)} label={`Open ${w.property.name}`}>
              <Title>{w.property.name}</Title>
              <Muted>
                {w.property.city} · {w.organisationName}
              </Muted>
            </Card>
          ))
        : null}
      <Button title="Sign out" variant="secondary" onPress={() => void signOut()} />
    </Screen>
  );
}
