import type { FacilityBookingDto, FacilityDto } from '@veyra/api-contracts';
import { BOOKING_STATUS_LABELS, BOOKING_STATUS_TONES } from '@veyra/client/facilities';
import { formatInstant, formatTime } from '@veyra/client/visitors';
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

export default function BookingsScreen() {
  const home = useHome();
  const client = useClient();
  const router = useRouter();
  const tz = home.unit.propertyTimeZone;
  const facilities = useApiQuery<{ data: FacilityDto[] }>(`${home.unitPath}/facilities`);
  const bookings = useApiQuery<{ data: FacilityBookingDto[] }>(
    `${home.unitPath}/facility-bookings`,
  );
  const action = useAction();

  const cancel = (b: FacilityBookingDto) =>
    Alert.alert('Cancel this booking?', `${b.facilityName}, ${formatInstant(b.startsAt, tz)}`, [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Cancel booking',
        style: 'destructive',
        onPress: () =>
          void action
            .run(() => client.post(`${home.unitPath}/facility-bookings/${b.id}/cancel`, {}))
            .then((ok) => ok && bookings.reload()),
      },
    ]);

  const now = Date.now();
  return (
    <Screen
      refreshing={bookings.refreshing}
      onRefresh={() => {
        facilities.reload();
        bookings.reload();
      }}
    >
      <ErrorText error={action.error} />
      <Heading>Your bookings</Heading>
      <Loaded
        query={bookings}
        empty="No upcoming bookings."
        isEmpty={(d) => d.data.filter((b) => Date.parse(b.endsAt) > now).length === 0}
      >
        {(d) =>
          d.data
            .filter((b) => Date.parse(b.endsAt) > now)
            .map((b) => (
              <Card key={b.id}>
                <Row>
                  <Title>{b.facilityName}</Title>
                  <Badge tone={BOOKING_STATUS_TONES[b.status]}>
                    {BOOKING_STATUS_LABELS[b.status]}
                  </Badge>
                </Row>
                <Muted>
                  {formatInstant(b.startsAt, tz)} to {formatTime(b.endsAt, tz)} · {b.number}
                </Muted>
                {b.statusNote ? <Muted>{b.statusNote}</Muted> : null}
                {b.cancellable ? (
                  <Button title="Cancel booking" variant="secondary" onPress={() => cancel(b)} />
                ) : null}
              </Card>
            ))
        }
      </Loaded>

      <Heading>Book a facility</Heading>
      <Loaded
        query={facilities}
        empty="No facilities can be booked here."
        isEmpty={(d) => d.data.length === 0}
      >
        {(d) =>
          d.data.map((f) => (
            <Card
              key={f.id}
              onPress={() => router.push(`${home.route}/bookings/${f.id}`)}
              label={`Book ${f.name}`}
            >
              <Title>{f.name}</Title>
              {f.description ? <Muted>{f.description}</Muted> : null}
              {f.approvalRequired ? <Badge>Needs approval</Badge> : null}
            </Card>
          ))
        }
      </Loaded>
    </Screen>
  );
}
