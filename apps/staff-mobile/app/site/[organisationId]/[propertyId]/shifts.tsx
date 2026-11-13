import type { MyShiftDetailDto, ShiftDto } from '@veyra/api-contracts';
import { formatInstant, formatTime } from '@veyra/client/visitors';
import { useState } from 'react';
import {
  Badge,
  Body,
  Button,
  Card,
  ErrorText,
  Field,
  Loaded,
  Muted,
  Row,
  Screen,
  Title,
} from '@/components/ui';
import { useClient } from '@/lib/session';
import { useSite } from '@/lib/site';
import { useAction, useApiQuery } from '@/lib/use-api';

const STATUS: Record<ShiftDto['status'], { label: string; tone: string }> = {
  SCHEDULED: { label: 'Scheduled', tone: 'neutral' },
  STARTED: { label: 'On shift', tone: 'success' },
  ENDED: { label: 'Ended', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'danger' },
};

function ShiftCard({ shift, onChange }: { shift: ShiftDto; onChange(): void }) {
  const site = useSite();
  const client = useClient();
  const tz = site.property.timeZone;
  const path = `${site.base}/my-shifts/${shift.id}`;
  const detail = useApiQuery<MyShiftDetailDto>(shift.status === 'SCHEDULED' ? path : null);
  const action = useAction();
  const [ending, setEnding] = useState(false);
  const [handover, setHandover] = useState('');
  const previous = detail.status === 'success' ? detail.data.previousHandover : null;

  const act = (what: 'start' | 'end') =>
    void action
      .run(() =>
        client.post(
          `${path}/${what}`,
          what === 'end' ? { handoverNote: handover.trim() } : undefined,
        ),
      )
      .then((ok) => {
        if (!ok) return;
        setEnding(false);
        onChange();
      });

  const s = STATUS[shift.status];
  return (
    <Card>
      <Row>
        <Title>{shift.department.name}</Title>
        <Badge tone={s.tone}>{s.label}</Badge>
      </Row>
      <Muted>
        {formatInstant(shift.startsAt, tz)} to {formatTime(shift.endsAt, tz)}
      </Muted>
      {previous ? (
        <Body>
          Handover from {previous.by}: {previous.note}
        </Body>
      ) : null}
      {shift.handoverNote ? <Muted>Your handover: {shift.handoverNote}</Muted> : null}
      <ErrorText error={action.error} />
      {shift.status === 'SCHEDULED' ? (
        <Button title="Start shift" pending={action.pending} onPress={() => act('start')} />
      ) : null}
      {shift.status === 'STARTED' && !ending ? (
        <Button title="End shift" variant="secondary" onPress={() => setEnding(true)} />
      ) : null}
      {ending ? (
        <>
          <Field
            label="Handover note for the next shift"
            value={handover}
            onChangeText={setHandover}
            multiline
          />
          <Row>
            <Button
              title="End shift"
              disabled={!handover.trim()}
              pending={action.pending}
              onPress={() => act('end')}
            />
            <Button title="Back" variant="secondary" onPress={() => setEnding(false)} />
          </Row>
        </>
      ) : null}
    </Card>
  );
}

export default function ShiftsScreen() {
  const site = useSite();
  const shifts = useApiQuery<{ data: ShiftDto[] }>(`${site.base}/my-shifts`);
  return (
    <Screen onRefresh={shifts.reload} refreshing={shifts.refreshing}>
      <Loaded
        query={shifts}
        empty="No shifts planned for you."
        isEmpty={(d) => d.data.length === 0}
      >
        {(d) => d.data.map((s) => <ShiftCard key={s.id} shift={s} onChange={shifts.reload} />)}
      </Loaded>
    </Screen>
  );
}
