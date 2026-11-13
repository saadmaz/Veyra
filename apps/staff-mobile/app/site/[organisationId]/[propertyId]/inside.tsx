import type { VisitDto } from '@veyra/api-contracts';
import { enumLabel } from '@veyra/client/messages';
import { formatTime } from '@veyra/client/visitors';
import { GateStatus } from '@/components/gate-status';
import {
  Button,
  Card,
  ErrorText,
  Heading,
  Loaded,
  Muted,
  Notice,
  Screen,
  Title,
} from '@/components/ui';
import { useGate } from '@/lib/gate-context';
import { useClient } from '@/lib/session';
import { useSite } from '@/lib/site';
import { useAction, useApiQuery } from '@/lib/use-api';

/** Visitors on site now, and their departures (queued on the phone while offline). */
export default function InsideScreen() {
  const site = useSite();
  const client = useClient();
  const gate = useGate();
  const inside = useApiQuery<{ data: VisitDto[] }>(
    gate?.online ? `${site.base}/visits/inside` : null,
  );
  const act = useAction();
  if (!gate) return null;
  const tz = site.property.timeZone;
  const gateName = gate.gate ? { gate: gate.gate } : {};
  const departed = new Set(
    gate.queue.flatMap((q) =>
      q.entry.kind === 'DEPART' && q.entry.visitId ? [q.entry.visitId] : [],
    ),
  );
  // Admissions made offline: they can leave again before the queue is sent.
  const queuedArrivals = gate.queue.filter(
    (q) =>
      (q.entry.kind === 'ADMIT' || q.entry.kind === 'WALK_IN') &&
      !gate.queue.some((d) => d.entry.kind === 'DEPART' && d.entry.departRef === q.entry.clientRef),
  );

  const depart = (v: VisitDto) => {
    if (!gate.online) {
      gate.enqueue({ kind: 'DEPART', visitId: v.id, ...gateName }, `${v.visitorName} left`);
      return;
    }
    void act
      .run(() => client.post(`${site.base}/visits/${v.id}/depart`, gateName))
      .then((ok) => ok && inside.reload());
  };

  return (
    <Screen onRefresh={inside.reload} refreshing={inside.refreshing}>
      <GateStatus />
      <ErrorText error={act.error} />
      {gate.online ? (
        <Loaded query={inside} empty="No visitors on site." isEmpty={(d) => d.data.length === 0}>
          {(d) =>
            d.data
              .filter((v) => !departed.has(v.id))
              .map((v) => (
                <Card key={v.id}>
                  <Title>{v.visitorName}</Title>
                  <Muted>
                    {enumLabel(v.category)}
                    {v.unitNumber ? ` · unit ${v.unitNumber}` : ''}
                    {v.vehiclePlate ? ` · ${v.vehiclePlate}` : ''} · arrived{' '}
                    {formatTime(v.arrivedAt, tz)}
                  </Muted>
                  <Button
                    title="Left"
                    variant="secondary"
                    pending={act.pending}
                    onPress={() => depart(v)}
                  />
                </Card>
              ))
          }
        </Loaded>
      ) : (
        <Notice tone="warning">
          The list of visitors on site needs a connection. Departures of visitors admitted on this
          phone can still be recorded below.
        </Notice>
      )}
      {queuedArrivals.length > 0 ? (
        <>
          <Heading>Admitted on this phone, not sent yet</Heading>
          {queuedArrivals.map((q) => (
            <Card key={q.entry.clientRef}>
              <Title>{q.label}</Title>
              <Button
                title="Left"
                variant="secondary"
                onPress={() =>
                  gate.enqueue(
                    { kind: 'DEPART', departRef: q.entry.clientRef, ...gateName },
                    `${q.label}: left`,
                  )
                }
              />
            </Card>
          ))}
        </>
      ) : null}
    </Screen>
  );
}
