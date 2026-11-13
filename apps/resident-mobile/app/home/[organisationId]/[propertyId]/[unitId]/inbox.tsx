import type { InboxItemDto, NotificationDto } from '@veyra/api-contracts';
import { formatInstant } from '@veyra/client/visitors';
import {
  Badge,
  Body,
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

/** Announcements for this home's property, then personal notifications. */
export default function InboxScreen() {
  const home = useHome();
  const client = useClient();
  const tz = home.unit.propertyTimeZone;
  const inbox = useApiQuery<{ data: InboxItemDto[] }>(`${home.orgPath}/inbox`);
  const notifications = useApiQuery<{ data: NotificationDto[] }>(`${home.orgPath}/notifications`);
  const action = useAction();

  const act = (path: string, reload: () => void) =>
    void action.run(() => client.post(path)).then((ok) => ok && reload());

  return (
    <Screen
      refreshing={inbox.refreshing}
      onRefresh={() => {
        inbox.reload();
        notifications.reload();
      }}
    >
      <ErrorText error={action.error} />
      <Heading>Announcements</Heading>
      <Loaded
        query={inbox}
        empty="No announcements."
        isEmpty={(d) =>
          d.data.filter((i) => i.announcement.property.id === home.propertyId).length === 0
        }
      >
        {(d) =>
          d.data
            .filter((i) => i.announcement.property.id === home.propertyId)
            .map(({ announcement: a, readAt, acknowledgedAt }) => {
              const needsAck = a.requiresAcknowledgement && !acknowledgedAt;
              return (
                <Card key={a.id}>
                  <Row>
                    <Title>{a.title}</Title>
                    {a.priority === 'URGENT' ? <Badge tone="danger">Urgent</Badge> : null}
                    {!readAt ? <Badge tone="accent">New</Badge> : null}
                  </Row>
                  <Muted>{a.publishedAt ? formatInstant(a.publishedAt, tz) : ''}</Muted>
                  <Body>{a.body}</Body>
                  {needsAck ? (
                    <Button
                      title="I have read this"
                      pending={action.pending}
                      onPress={() => act(`${home.orgPath}/inbox/${a.id}/acknowledge`, inbox.reload)}
                    />
                  ) : !readAt ? (
                    <Button
                      title="Mark as read"
                      variant="secondary"
                      pending={action.pending}
                      onPress={() => act(`${home.orgPath}/inbox/${a.id}/read`, inbox.reload)}
                    />
                  ) : null}
                </Card>
              );
            })
        }
      </Loaded>

      <Heading>Notifications</Heading>
      <Loaded query={notifications} empty="No notifications." isEmpty={(d) => d.data.length === 0}>
        {(d) => (
          <>
            {d.data.some((n) => !n.readAt) ? (
              <Button
                title="Mark all as read"
                variant="secondary"
                onPress={() => act(`${home.orgPath}/notifications/read-all`, notifications.reload)}
              />
            ) : null}
            {d.data.slice(0, 50).map((n) => (
              <Card key={n.id}>
                <Row>
                  <Title>{n.title}</Title>
                  {!n.readAt ? <Badge tone="accent">New</Badge> : null}
                </Row>
                <Body>{n.body}</Body>
                <Muted>{formatInstant(n.createdAt, tz)}</Muted>
              </Card>
            ))}
          </>
        )}
      </Loaded>
    </Screen>
  );
}
