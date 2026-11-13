import type { Paginated, UnitDto, VisitorCategory, WalkInRequestDto } from '@veyra/api-contracts';
import { enumLabel } from '@veyra/client/messages';
import { secondsUntil, VISITOR_CATEGORIES, WALK_IN_STATUS_LABELS } from '@veyra/client/visitors';
import { useMemo, useState } from 'react';
import { GateStatus } from '@/components/gate-status';
import {
  Badge,
  Button,
  Card,
  Chips,
  ErrorText,
  Field,
  fieldError,
  Heading,
  Loaded,
  Muted,
  Notice,
  Row,
  Screen,
  Title,
} from '@/components/ui';
import { useGate } from '@/lib/gate-context';
import { useClient } from '@/lib/session';
import { useSite } from '@/lib/site';
import { useAction, useApiQuery } from '@/lib/use-api';

const TO_PROPERTY = 'PROPERTY';

/**
 * A visitor without a pass. To a unit: the residents are asked and have 10 minutes to answer.
 * To the property itself (e.g. the management office): recorded and admitted. Offline, only the
 * property itself is possible, because residents cannot be asked.
 */
export default function WalkInScreen() {
  const site = useSite();
  const client = useClient();
  const gate = useGate();
  const units = useApiQuery<Paginated<UnitDto>>(`${site.base}/units?limit=200`);
  const requests = useApiQuery<{ data: WalkInRequestDto[] }>(
    gate?.online ? `${site.base}/gate/walk-in-requests` : null,
  );
  const [category, setCategory] = useState<VisitorCategory>('GUEST');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [plate, setPlate] = useState('');
  const [unitSearch, setUnitSearch] = useState('');
  const [unitId, setUnitId] = useState<string>(TO_PROPERTY);
  const [notice, setNotice] = useState<string | null>(null);
  const send = useAction();
  const act = useAction();

  const matches = useMemo(() => {
    if (units.status !== 'success') return [];
    const q = unitSearch.trim().toLowerCase();
    return units.data.data.filter((u) => q && u.number.toLowerCase().includes(q)).slice(0, 8);
  }, [units, unitSearch]);

  if (!gate) return null;
  const gateName = gate.gate ? { gate: gate.gate } : {};
  const chosenUnit =
    units.status === 'success' ? units.data.data.find((u) => u.id === unitId) : undefined;

  const reset = () => {
    setName('');
    setPhone('');
    setPlate('');
    setUnitSearch('');
    setUnitId(TO_PROPERTY);
  };

  const submit = () => {
    if (!name.trim()) return;
    setNotice(null);
    const body = {
      category,
      visitorName: name.trim(),
      ...(phone.trim() ? { visitorPhone: phone.trim() } : {}),
      ...(plate.trim() ? { vehiclePlate: plate.trim() } : {}),
      ...gateName,
    };
    if (!gate.online) {
      if (unitId !== TO_PROPERTY) {
        setNotice(
          'Without a connection the residents cannot be asked. Follow the paper procedure.',
        );
        return;
      }
      const { visitorPhone: _phone, ...entry } = body;
      gate.enqueue({ kind: 'WALK_IN', ...entry }, `${body.visitorName} admitted to the property`);
      setNotice(`${body.visitorName} admitted to the property. Saved on this device.`);
      reset();
      return;
    }
    void send
      .run(() =>
        unitId === TO_PROPERTY
          ? client.post(`${site.base}/gate/walk-in`, body)
          : client.post(`${site.base}/gate/walk-in-requests`, { ...body, unitId }),
      )
      .then((ok) => {
        if (!ok) return;
        setNotice(
          unitId === TO_PROPERTY
            ? `${body.visitorName} admitted to the property.`
            : 'Request sent. The residents have 10 minutes to answer.',
        );
        reset();
        requests.reload();
      });
  };

  const now = Date.now();
  return (
    <Screen onRefresh={requests.reload} refreshing={requests.refreshing}>
      <GateStatus />
      {notice ? (
        <Notice tone={notice.startsWith('Without') ? 'danger' : 'success'}>{notice}</Notice>
      ) : null}
      <Chips
        label="Who is it"
        options={VISITOR_CATEGORIES.map((c) => ({ value: c, label: enumLabel(c) }))}
        value={category}
        onChange={setCategory}
      />
      <Field
        label="Visitor’s name"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        error={fieldError(send.error, 'visitorName')}
      />
      <Field
        label="Phone (optional)"
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
      />
      <Field
        label="Vehicle plate (optional)"
        value={plate}
        onChangeText={setPlate}
        autoCapitalize="characters"
      />
      <Field
        label="Visiting unit"
        value={unitSearch}
        onChangeText={(text) => {
          setUnitSearch(text);
          setUnitId(TO_PROPERTY);
        }}
        placeholder="Type the unit number, or leave empty for the property office"
        autoCapitalize="characters"
      />
      {matches.length > 0 && !chosenUnit ? (
        <Chips
          label="Choose the unit"
          options={matches.map((u) => ({ value: u.id, label: u.number }))}
          value={null}
          onChange={(id) => {
            setUnitId(id);
            setUnitSearch(
              units.status === 'success'
                ? (units.data.data.find((u) => u.id === id)?.number ?? '')
                : '',
            );
          }}
        />
      ) : null}
      <Muted>
        {chosenUnit
          ? `The residents of unit ${chosenUnit.number} will be asked to let them in.`
          : 'Recorded as a visit to the property itself, and let in.'}
      </Muted>
      <ErrorText error={send.error} />
      <Button
        title={chosenUnit ? 'Ask the residents' : 'Let in'}
        onPress={submit}
        pending={send.pending}
        disabled={!name.trim()}
      />

      {gate.online ? (
        <>
          <Heading>Waiting at the gate</Heading>
          <ErrorText error={act.error} />
          <Loaded query={requests} empty="Nobody is waiting." isEmpty={(d) => d.data.length === 0}>
            {(d) =>
              d.data.map((r) => (
                <Card key={r.id}>
                  <Row>
                    <Title>{r.visitorName}</Title>
                    <Badge
                      tone={
                        r.status === 'APPROVED'
                          ? 'success'
                          : r.status === 'PENDING'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {WALK_IN_STATUS_LABELS[r.status]}
                    </Badge>
                  </Row>
                  <Muted>
                    Unit {r.unitNumber}
                    {r.status === 'PENDING'
                      ? ` · ${Math.ceil(secondsUntil(r.expiresAt, now) / 60)} min left`
                      : ''}
                  </Muted>
                  <Row>
                    {r.status === 'APPROVED' && !r.used ? (
                      <Button
                        title="Let in"
                        pending={act.pending}
                        onPress={() =>
                          void act
                            .run(() =>
                              client.post(
                                `${site.base}/gate/walk-in-requests/${r.id}/admit`,
                                gateName,
                              ),
                            )
                            .then((ok) => ok && requests.reload())
                        }
                      />
                    ) : null}
                    {r.status === 'PENDING' ? (
                      <Button
                        title="Cancel"
                        variant="secondary"
                        onPress={() =>
                          void act
                            .run(() =>
                              client.post(`${site.base}/gate/walk-in-requests/${r.id}/cancel`),
                            )
                            .then((ok) => ok && requests.reload())
                        }
                      />
                    ) : null}
                  </Row>
                </Card>
              ))
            }
          </Loaded>
        </>
      ) : null}
    </Screen>
  );
}
