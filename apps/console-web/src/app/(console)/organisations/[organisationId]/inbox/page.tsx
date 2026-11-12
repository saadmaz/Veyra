'use client';

import type {
  InboxItemDto,
  NotificationDto,
  OrganisationDetailResponse,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

/** The signed-in person's announcements and notifications in an organisation. */
export default function InboxPage() {
  const { organisationId } = useParams<{ organisationId: string }>();
  const base = `/organisations/${organisationId}`;
  const organisation = useApiQuery<OrganisationDetailResponse>(base);
  const inbox = useApiQuery<{ data: InboxItemDto[] }>(`${base}/inbox`);
  const notifications = useApiQuery<{ data: NotificationDto[]; unread: number }>(
    `${base}/notifications`,
  );
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    document.title = 'Inbox · VEYRA Console';
  }, []);

  async function act(path: string, reload: () => void) {
    setError(null);
    try {
      await api.post(path);
      reload();
    } catch (e) {
      setError(e);
    }
  }

  const items = inbox.status === 'success' ? inbox.data.data : [];
  const notes = notifications.status === 'success' ? notifications.data.data : [];
  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={base}>
          {organisation.status === 'success' ? organisation.data.name : 'Organisation'}
        </Link>
      </nav>
      <div className="page__header">
        <h1>Inbox</h1>
      </div>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}

      <Card title="Announcements">
        {inbox.status === 'loading' ? <LoadingState label="Loading announcements" /> : null}
        {inbox.status === 'error' ? (
          <ErrorState error={inbox.error} onRetry={inbox.reload} />
        ) : null}
        {inbox.status === 'success' && items.length === 0 ? (
          <p className="muted">No announcements for you.</p>
        ) : null}
        {items.length > 0 ? (
          <ul className="list" aria-label="Announcements">
            {items.map((i) => {
              const a = i.announcement;
              return (
                <li key={a.id} className="list__item">
                  <article className="inline-form" aria-label={a.title}>
                    <p className="list__primary">
                      {a.title}{' '}
                      {a.priority === 'URGENT' ? <Badge tone="danger">urgent</Badge> : null}
                      {i.readAt ? null : <Badge tone="warning">new</Badge>}
                    </p>
                    <p className="note">{a.body}</p>
                    <p className="list__meta">
                      {a.property.name} · {a.publishedAt ? when(a.publishedAt) : ''}
                      {i.acknowledgedAt ? ` · acknowledged ${when(i.acknowledgedAt)}` : ''}
                    </p>
                    <div className="form__actions">
                      {a.requiresAcknowledgement && !i.acknowledgedAt ? (
                        <Button
                          onClick={() => act(`${base}/inbox/${a.id}/acknowledge`, inbox.reload)}
                        >
                          I have read this
                        </Button>
                      ) : null}
                      {!a.requiresAcknowledgement && !i.readAt ? (
                        <Button
                          variant="secondary"
                          onClick={() => act(`${base}/inbox/${a.id}/read`, inbox.reload)}
                        >
                          Mark read
                        </Button>
                      ) : null}
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        ) : null}
      </Card>

      <Card title="Notifications">
        {notifications.status === 'loading' ? <LoadingState label="Loading notifications" /> : null}
        {notifications.status === 'error' ? (
          <ErrorState error={notifications.error} onRetry={notifications.reload} />
        ) : null}
        {notifications.status === 'success' && notes.length === 0 ? (
          <p className="muted">Nothing new.</p>
        ) : null}
        {notes.length > 0 ? (
          <>
            <ul className="list" aria-label="Notifications">
              {notes.map((n) => (
                <li key={n.id} className="list__item">
                  <div>
                    <p className="list__primary">
                      {n.link ? <Link href={n.link}>{n.title}</Link> : n.title}{' '}
                      {n.urgent ? <Badge tone="danger">urgent</Badge> : null}
                      {n.readAt ? null : <Badge tone="warning">new</Badge>}
                    </p>
                    <p className="list__meta">
                      {n.body} · {when(n.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            {notifications.status === 'success' && notifications.data.unread > 0 ? (
              <div className="form__actions">
                <Button
                  variant="secondary"
                  onClick={() => act(`${base}/notifications/read-all`, notifications.reload)}
                >
                  Mark all read
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </Card>
    </>
  );
}
