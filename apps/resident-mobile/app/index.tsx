import type { MyOrganisationDto, MyUnitDto } from '@veyra/api-contracts';
import { residentRoleLabel } from '@veyra/client/messages';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Muted,
  Row,
  Screen,
  Title,
  usePalette,
} from '@/components/ui';
import { useClient, useSession } from '@/lib/session';

interface HomeEntry extends MyUnitDto {
  organisationId: string;
  organisationName: string;
}

type HomesState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; homes: HomeEntry[] };

/** Every home this person has, across organisations. One home opens straight away. */
export default function HomesScreen() {
  const { state, signOut } = useSession();
  const client = useClient();
  const router = useRouter();
  const palette = usePalette();
  const [homes, setHomes] = useState<HomesState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const orgs = await client.get<{ data: MyOrganisationDto[] }>('/organisations');
      const lists = await Promise.all(
        orgs.data.map(async ({ organisation }) => {
          const units = await client.get<{ data: MyUnitDto[] }>(
            `/organisations/${organisation.id}/my-units`,
          );
          return units.data.map((u) => ({
            ...u,
            organisationId: organisation.id,
            organisationName: organisation.name,
          }));
        }),
      );
      setHomes({ status: 'ready', homes: lists.flat() });
    } catch (error) {
      setHomes({ status: 'error', error });
    } finally {
      setRefreshing(false);
    }
  }, [client]);

  useEffect(() => {
    if (state.status === 'signed-in') void load();
  }, [state.status, load]);

  const open = useCallback(
    (h: HomeEntry) => router.push(`/home/${h.organisationId}/${h.propertyId}/${h.unitId}`),
    [router],
  );

  if (state.status === 'unconfigured') {
    return (
      <Screen>
        <Title>This app is not set up</Title>
        <Muted>
          It was built without the address of the VEYRA service. Ask your property manager for the
          right app.
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

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void load();
      }}
    >
      <Stack.Screen options={{ title: 'Your homes' }} />
      <Muted>Signed in as {state.user.displayName}</Muted>
      {homes.status === 'loading' ? (
        <ActivityIndicator color={palette.accent} accessibilityLabel="Loading" />
      ) : null}
      {homes.status === 'error' ? (
        <>
          <ErrorText error={homes.error} />
          <Button title="Try again" variant="secondary" onPress={() => void load()} />
        </>
      ) : null}
      {homes.status === 'ready' && homes.homes.length === 0 ? (
        <Card>
          <Title>No homes yet</Title>
          <Muted>
            When your property manager adds you to a unit, it appears here. If you were invited,
            open the invitation email and accept it first.
          </Muted>
        </Card>
      ) : null}
      {homes.status === 'ready'
        ? homes.homes.map((h) => (
            <Card
              key={`${h.organisationId}:${h.unitId}`}
              onPress={() => open(h)}
              label={`Open unit ${h.unitNumber}, ${h.propertyName}`}
            >
              <Title>
                Unit {h.unitNumber}
                {h.buildingName ? `, ${h.buildingName}` : ''}
              </Title>
              <Muted>
                {h.propertyName} · {h.organisationName}
              </Muted>
              <Row>
                {h.roles.map((role) => (
                  <Badge key={role}>{residentRoleLabel(role)}</Badge>
                ))}
              </Row>
            </Card>
          ))
        : null}
      <Button title="Sign out" variant="secondary" onPress={() => void signOut()} />
    </Screen>
  );
}
