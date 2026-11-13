import type {
  FacilityAvailabilityDto,
  FacilityBookingDetailDto,
  FacilityDto,
  FacilitySlotDto,
} from '@veyra/api-contracts';
import { describeRules, SLOT_STATE_LABELS } from '@veyra/client/facilities';
import { formatMoney } from '@veyra/client/finance';
import { formatTime } from '@veyra/client/visitors';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  Body,
  Button,
  Card,
  Chips,
  ErrorText,
  Field,
  Heading,
  Loaded,
  Muted,
  Notice,
  Screen,
  Title,
} from '@/components/ui';
import { dayOptions } from '@/lib/dates';
import { useHome } from '@/lib/home';
import { useClient } from '@/lib/session';
import { useAction, useApiQuery } from '@/lib/use-api';

export default function BookFacilityScreen() {
  const home = useHome();
  const client = useClient();
  const router = useRouter();
  const { facilityId } = useLocalSearchParams<{ facilityId: string }>();
  const tz = home.unit.propertyTimeZone;
  const facilities = useApiQuery<{ data: FacilityDto[] }>(`${home.unitPath}/facilities`);
  const facility =
    facilities.status === 'success'
      ? facilities.data.data.find((f) => f.id === facilityId)
      : undefined;
  const days = useMemo(
    () => dayOptions(tz, Math.min(14, (facility?.maxAdvanceDays ?? 6) + 1)),
    [tz, facility],
  );
  const [day, setDay] = useState<string | null>(null);
  const date = day ?? days[0]?.date ?? '';
  const availability = useApiQuery<FacilityAvailabilityDto>(
    facility ? `${home.unitPath}/facilities/${facilityId}/availability?date=${date}` : null,
  );
  const [slot, setSlot] = useState<FacilitySlotDto | null>(null);
  const [count, setCount] = useState('1');
  const [purpose, setPurpose] = useState('');
  const [booked, setBooked] = useState<FacilityBookingDetailDto | null>(null);
  const action = useAction();

  const book = () =>
    slot &&
    void action.run(async () => {
      setBooked(
        await client.post<FacilityBookingDetailDto>(`${home.unitPath}/facility-bookings`, {
          facilityId,
          startsAt: slot.startsAt,
          slots: Number(count),
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        }),
      );
    });

  if (booked) {
    const b = booked.booking;
    return (
      <Screen>
        <Notice>
          {b.status === 'PENDING'
            ? `Requested ${b.facilityName}. The property team will confirm it.`
            : `${b.facilityName} is booked.`}
        </Notice>
        <Card>
          <Title>{b.number}</Title>
          <Muted>
            {formatTime(b.startsAt, tz)} to {formatTime(b.endsAt, tz)}, {date}
          </Muted>
        </Card>
        <Button title="Done" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen onRefresh={availability.reload} refreshing={availability.refreshing}>
      <Loaded query={facilities}>
        {() =>
          !facility ? (
            <Muted>This facility cannot be booked.</Muted>
          ) : (
            <>
              <Stack.Screen options={{ title: facility.name }} />
              <Card>
                <Title>{facility.name}</Title>
                {describeRules(facility).map((rule) => (
                  <Muted key={rule}>{rule}</Muted>
                ))}
                {facility.fee ? (
                  <Body>Fee: {formatMoney(facility.fee.perSlot)} per slot</Body>
                ) : null}
                {facility.deposit ? (
                  <Body>Deposit: {formatMoney(facility.deposit.amount)}</Body>
                ) : null}
              </Card>
              <Chips
                label="Day"
                options={days.map((d) => ({ value: d.date, label: d.label }))}
                value={date}
                onChange={(value) => {
                  setDay(value);
                  setSlot(null);
                }}
              />
              <Heading>Times</Heading>
              <Loaded
                query={availability}
                empty="Closed on this day."
                isEmpty={(a) => a.slots.length === 0}
              >
                {(a) => (
                  <Chips
                    label="Start time"
                    options={a.slots
                      .filter((s) => s.state === 'OPEN')
                      .map((s) => ({ value: s.startsAt, label: s.time }))}
                    value={slot?.startsAt ?? null}
                    onChange={(value) => setSlot(a.slots.find((s) => s.startsAt === value) ?? null)}
                  />
                )}
              </Loaded>
              {availability.status === 'success' &&
              availability.data.slots.length > 0 &&
              availability.data.slots.every((s) => s.state !== 'OPEN') ? (
                <Muted>
                  No free times on this day (
                  {SLOT_STATE_LABELS[availability.data.slots[0]?.state ?? 'FULL']}).
                </Muted>
              ) : null}
              {facility.maxSlotsPerBooking > 1 ? (
                <Chips
                  label="Length"
                  options={Array.from({ length: facility.maxSlotsPerBooking }, (_, i) => ({
                    value: String(i + 1),
                    label: `${((i + 1) * facility.slotMinutes) / 60} h`,
                  }))}
                  value={count}
                  onChange={setCount}
                />
              ) : null}
              <Field label="What is it for (optional)" value={purpose} onChangeText={setPurpose} />
              <ErrorText error={action.error} />
              <Button
                title={facility.approvalRequired ? 'Request booking' : 'Book'}
                disabled={!slot}
                pending={action.pending}
                onPress={book}
              />
            </>
          )
        }
      </Loaded>
    </Screen>
  );
}
