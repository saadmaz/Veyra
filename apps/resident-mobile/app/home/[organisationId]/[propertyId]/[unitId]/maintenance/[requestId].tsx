import type { ResidentMaintenanceRequestDetailDto } from '@veyra/api-contracts';
import {
  CATEGORY_LABELS,
  eventText,
  PRIORITY_LABELS,
  REQUEST_STATUS_LABELS,
  REQUEST_STATUS_TONES,
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
  ErrorText,
  Field,
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

type Pending = 'cancel' | 'reopen' | null;

export default function RequestScreen() {
  const home = useHome();
  const client = useClient();
  const { requestId } = useLocalSearchParams<{ requestId: string }>();
  const base = `${home.unitPath}/maintenance-requests/${requestId}`;
  const detail = useApiQuery<ResidentMaintenanceRequestDetailDto>(base);
  const action = useAction();
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState<Pending>(null);
  const [reason, setReason] = useState('');
  const tz = home.unit.propertyTimeZone;

  const post = (path: string, body?: unknown) =>
    void action
      .run(() => client.post(`${base}/${path}`, body))
      .then((ok) => {
        if (!ok) return;
        setNote('');
        setReason('');
        setAsking(null);
        detail.reload();
      });

  const openFile = (attachmentId: string) =>
    void action.run(async () => {
      const { url } = await client.get<{ url: string }>(
        `${base}/attachments/${attachmentId}/download`,
      );
      await Linking.openURL(url);
    });

  return (
    <Screen onRefresh={detail.reload} refreshing={detail.refreshing}>
      <Loaded query={detail}>
        {({ request: r, events, attachments }) => (
          <>
            <Card>
              <Row>
                <Title>{r.title}</Title>
                <Badge tone={REQUEST_STATUS_TONES[r.status]}>
                  {REQUEST_STATUS_LABELS[r.status]}
                </Badge>
              </Row>
              <Muted>
                {r.number} · {CATEGORY_LABELS[r.category]} · {PRIORITY_LABELS[r.priority]} priority
              </Muted>
              <Body>{r.description}</Body>
              {r.locationDetail ? <Muted>Where: {r.locationDetail}</Muted> : null}
              {r.statusNote ? <Muted>Note: {r.statusNote}</Muted> : null}
            </Card>

            <ErrorText error={action.error} />

            {r.status === 'RESOLVED' ? (
              <Card>
                <Title>Is it fixed?</Title>
                <Muted>
                  Confirm to close the request, or reopen it if the problem is still there.
                </Muted>
                <Row>
                  <Button
                    title="Yes, it is fixed"
                    onPress={() => post('confirm')}
                    pending={action.pending}
                  />
                  <Button
                    title="Not fixed"
                    variant="secondary"
                    onPress={() => setAsking('reopen')}
                  />
                </Row>
              </Card>
            ) : null}
            {r.status === 'SUBMITTED' && asking === null ? (
              <Button
                title="Cancel this request"
                variant="secondary"
                onPress={() => setAsking('cancel')}
              />
            ) : null}
            {asking ? (
              <Card>
                <Field
                  label={asking === 'cancel' ? 'Why are you cancelling?' : 'What is still wrong?'}
                  value={reason}
                  onChangeText={setReason}
                  multiline
                />
                <Row>
                  <Button
                    title={asking === 'cancel' ? 'Cancel request' : 'Reopen request'}
                    variant={asking === 'cancel' ? 'danger' : 'primary'}
                    disabled={!reason.trim()}
                    pending={action.pending}
                    onPress={() => post(asking, { reason: reason.trim() })}
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
                  </Card>
                ))}
              </>
            ) : null}

            <Heading>History</Heading>
            {events.map((e) => (
              <Card key={e.id}>
                <Body>
                  {e.type === 'NOTE'
                    ? `${e.actor?.name ?? 'VEYRA'}: ${e.body ?? ''}`
                    : eventText(e, () => 'a technician')}
                </Body>
                <Muted>{formatInstant(e.createdAt, tz)}</Muted>
              </Card>
            ))}

            {r.status !== 'CLOSED' && r.status !== 'CANCELLED' && r.status !== 'REJECTED' ? (
              <Card>
                <Field label="Add a note" value={note} onChangeText={setNote} multiline />
                <Button
                  title="Send note"
                  disabled={!note.trim()}
                  pending={action.pending}
                  onPress={() => post('notes', { body: note.trim() })}
                />
              </Card>
            ) : null}
          </>
        )}
      </Loaded>
    </Screen>
  );
}
