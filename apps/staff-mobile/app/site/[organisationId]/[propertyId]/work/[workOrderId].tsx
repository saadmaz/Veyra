import type { AttachmentDownloadDto, WorkOrderDetailDto } from '@veyra/api-contracts';
import {
  CATEGORY_LABELS,
  eventText,
  PRIORITY_LABELS,
  WORK_STATUS_LABELS,
  WORK_STATUS_TONES,
} from '@veyra/client/maintenance';
import { formatInstant } from '@veyra/client/visitors';
import * as Linking from 'expo-linking';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  Badge,
  Body,
  Button,
  Card,
  Chips,
  ErrorText,
  Field,
  Heading,
  Loaded,
  Muted,
  Row,
  Screen,
  Title,
} from '@/components/ui';
import { useClient } from '@/lib/session';
import { useSite } from '@/lib/site';
import { useAction, useApiQuery } from '@/lib/use-api';

type Asking = 'complete' | 'hold' | null;

export default function WorkOrderScreen() {
  const site = useSite();
  const client = useClient();
  const { workOrderId } = useLocalSearchParams<{ workOrderId: string }>();
  const path = `${site.base}/my-work-orders/${workOrderId}`;
  const detail = useApiQuery<WorkOrderDetailDto>(path);
  const action = useAction();
  const [asking, setAsking] = useState<Asking>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [visibility, setVisibility] = useState<'INTERNAL' | 'RESIDENT'>('INTERNAL');
  const tz = site.property.timeZone;

  const post = (suffix: string, body?: unknown) =>
    void action
      .run(() => client.post(`${path}/${suffix}`, body))
      .then((ok) => {
        if (!ok) return;
        setAsking(null);
        setText('');
        setNote('');
        detail.reload();
      });

  const openFile = (attachmentId: string) =>
    void action.run(async () => {
      const { url } = await client.get<AttachmentDownloadDto>(
        `${path}/attachments/${attachmentId}/download`,
      );
      await Linking.openURL(url);
    });

  return (
    <Screen onRefresh={detail.reload} refreshing={detail.refreshing}>
      <Loaded query={detail}>
        {({ workOrder: w, events, attachments }) => {
          const active =
            w.status === 'ASSIGNED' || w.status === 'IN_PROGRESS' || w.status === 'ON_HOLD';
          return (
            <>
              <Card>
                <Row>
                  <Title>{w.title}</Title>
                  <Badge tone={WORK_STATUS_TONES[w.status]}>{WORK_STATUS_LABELS[w.status]}</Badge>
                </Row>
                <Muted>
                  {w.number} · {CATEGORY_LABELS[w.category]} · {PRIORITY_LABELS[w.priority]}
                  {w.requestNumber ? ` · request ${w.requestNumber}` : ''}
                </Muted>
                {w.description ? <Body>{w.description}</Body> : null}
                {w.dueAt ? <Muted>Due {formatInstant(w.dueAt, tz)}</Muted> : null}
                {w.statusNote ? <Muted>Note: {w.statusNote}</Muted> : null}
              </Card>
              <ErrorText error={action.error} />

              {active && asking === null ? (
                <Row>
                  {w.status !== 'IN_PROGRESS' ? (
                    <Button
                      title={w.status === 'ON_HOLD' ? 'Resume' : 'Start'}
                      pending={action.pending}
                      onPress={() => post('start')}
                    />
                  ) : null}
                  {w.status === 'IN_PROGRESS' ? (
                    <>
                      <Button title="Complete" onPress={() => setAsking('complete')} />
                      <Button
                        title="Put on hold"
                        variant="secondary"
                        onPress={() => setAsking('hold')}
                      />
                    </>
                  ) : null}
                </Row>
              ) : null}
              {asking ? (
                <Card>
                  <Field
                    label={asking === 'complete' ? 'What was done' : 'Why is it on hold'}
                    value={text}
                    onChangeText={setText}
                    multiline
                  />
                  <Row>
                    <Button
                      title={asking === 'complete' ? 'Complete' : 'Put on hold'}
                      disabled={!text.trim()}
                      pending={action.pending}
                      onPress={() =>
                        post(
                          asking,
                          asking === 'complete' ? { note: text.trim() } : { reason: text.trim() },
                        )
                      }
                    />
                    <Button title="Back" variant="secondary" onPress={() => setAsking(null)} />
                  </Row>
                </Card>
              ) : null}

              {attachments.length > 0 ? (
                <>
                  <Heading>Photos and files</Heading>
                  {attachments.map((a) => (
                    <Card key={a.id} onPress={() => openFile(a.id)} label={`Open ${a.fileName}`}>
                      <Title>{a.fileName}</Title>
                      <Muted>{a.kind.toLowerCase()}</Muted>
                    </Card>
                  ))}
                </>
              ) : null}

              <Heading>History</Heading>
              {events.map((e) => (
                <Card key={e.id}>
                  <Body>
                    {e.type === 'NOTE'
                      ? `${e.actor?.name ?? 'VEYRA'}${e.visibility === 'INTERNAL' ? ' (staff only)' : ''}: ${e.body ?? ''}`
                      : eventText(e, () => 'a technician')}
                  </Body>
                  <Muted>{formatInstant(e.createdAt, tz)}</Muted>
                </Card>
              ))}

              {active ? (
                <Card>
                  <Field label="Add a note" value={note} onChangeText={setNote} multiline />
                  <Chips
                    label="Who can see it"
                    options={[
                      { value: 'INTERNAL', label: 'Staff only' },
                      { value: 'RESIDENT', label: 'Also the resident' },
                    ]}
                    value={visibility}
                    onChange={setVisibility}
                  />
                  <Button
                    title="Add note"
                    disabled={!note.trim()}
                    pending={action.pending}
                    onPress={() => post('notes', { body: note.trim(), visibility })}
                  />
                </Card>
              ) : null}
            </>
          );
        }}
      </Loaded>
    </Screen>
  );
}
