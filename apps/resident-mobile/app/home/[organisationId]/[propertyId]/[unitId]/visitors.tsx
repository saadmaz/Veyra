import type { VisitorInvitationDto, WalkInRequestDto } from '@veyra/api-contracts';
import { enumLabel } from '@veyra/client/messages';
import { formatInstant, secondsUntil, WALK_IN_STATUS_LABELS } from '@veyra/client/visitors';
import { useRouter } from 'expo-router';
import { Alert } from 'react-native';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Heading,
  Loaded,
  Muted,
  Row,
  Screen,
  Title,
} from '@/components/ui';
import { useHome } from '@/lib/home';
import { useClient } from '@/lib/session';
import { useAction, useApiQuery } from '@/lib/use-api';

export default function VisitorsScreen() {
  const home = useHome();
  const client = useClient();
  const router = useRouter();
  const tz = home.unit.propertyTimeZone;
  const passes = useApiQuery<{ data: VisitorInvitationDto[] }>(
    `${home.unitPath}/visitor-invitations`,
  );
  const walkIns = useApiQuery<{ data: WalkInRequestDto[] }>(`${home.unitPath}/walk-in-requests`);
  const action = useAction();

  const decide = (r: WalkInRequestDto, approve: boolean) =>
    void action
      .run(() =>
        client.post(`${home.unitPath}/walk-in-requests/${r.id}/${approve ? 'approve' : 'deny'}`),
      )
      .then((ok) => ok && walkIns.reload());

  const revoke = (p: VisitorInvitationDto) =>
    Alert.alert('Cancel this pass?', `${p.visitorName} will not be let in with it.`, [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Cancel pass',
        style: 'destructive',
        onPress: () =>
          void action
            .run(() => client.post(`${home.unitPath}/visitor-invitations/${p.id}/revoke`))
            .then((ok) => ok && passes.reload()),
      },
    ]);

  const now = Date.now();
  return (
    <Screen
      refreshing={passes.refreshing}
      onRefresh={() => {
        passes.reload();
        walkIns.reload();
      }}
    >
      <Button title="New visitor pass" onPress={() => router.push(`${home.route}/new-pass`)} />
      <ErrorText error={action.error} />

      <Heading>At the gate</Heading>
      <Loaded
        query={walkIns}
        empty="Nobody is waiting for you at the gate."
        isEmpty={(d) => d.data.filter((r) => r.status === 'PENDING').length === 0}
      >
        {(d) =>
          d.data
            .filter((r) => r.status === 'PENDING')
            .map((r) => (
              <Card key={r.id}>
                <Title>{r.visitorName}</Title>
                <Muted>
                  {enumLabel(r.category)}
                  {r.vehiclePlate ? ` · ${r.vehiclePlate}` : ''}
                  {r.gate ? ` · ${r.gate}` : ''}
                </Muted>
                <Muted>Answer within {Math.ceil(secondsUntil(r.expiresAt, now) / 60)} min</Muted>
                <Row>
                  <Button title="Let in" onPress={() => decide(r, true)} pending={action.pending} />
                  <Button
                    title="Refuse"
                    variant="danger"
                    onPress={() => decide(r, false)}
                    pending={action.pending}
                  />
                </Row>
              </Card>
            ))
        }
      </Loaded>

      <Heading>Passes</Heading>
      <Loaded query={passes} empty="No visitor passes yet." isEmpty={(d) => d.data.length === 0}>
        {(d) =>
          d.data.map((p) => {
            const ended = p.status === 'REVOKED' || Date.parse(p.validUntil) < now;
            const used = p.entriesUsed >= p.maxEntries;
            return (
              <Card key={p.id}>
                <Row>
                  <Title>{p.visitorName}</Title>
                  <Badge
                    tone={p.status === 'REVOKED' ? 'danger' : ended || used ? 'neutral' : 'success'}
                  >
                    {p.status === 'REVOKED'
                      ? 'Cancelled'
                      : ended
                        ? 'Ended'
                        : used
                          ? 'Used'
                          : 'Active'}
                  </Badge>
                </Row>
                <Muted>
                  {enumLabel(p.category)} · {formatInstant(p.validFrom, tz)} to{' '}
                  {formatInstant(p.validUntil, tz)}
                </Muted>
                <Muted>
                  Entries used: {p.entriesUsed} of {p.maxEntries}
                </Muted>
                {!ended && !used ? (
                  <Button title="Cancel pass" variant="secondary" onPress={() => revoke(p)} />
                ) : null}
              </Card>
            );
          })
        }
      </Loaded>

      <Heading>Recent gate requests</Heading>
      <Loaded
        query={walkIns}
        empty="No gate requests."
        isEmpty={(d) => d.data.filter((r) => r.status !== 'PENDING').length === 0}
      >
        {(d) =>
          d.data
            .filter((r) => r.status !== 'PENDING')
            .slice(0, 10)
            .map((r) => (
              <Card key={r.id}>
                <Title>{r.visitorName}</Title>
                <Muted>
                  {WALK_IN_STATUS_LABELS[r.status]} · {formatInstant(r.createdAt, tz)}
                </Muted>
              </Card>
            ))
        }
      </Loaded>
    </Screen>
  );
}
