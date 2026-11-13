import type { InboxItemDto, MyFinanceDto } from '@veyra/api-contracts';
import { balanceText } from '@veyra/client/finance';
import { useRouter } from 'expo-router';
import { Badge, Card, Muted, Row, Screen, Title } from '@/components/ui';
import { useHome } from '@/lib/home';
import { useApiQuery } from '@/lib/use-api';

/** The home at a glance, and a way into each service the API allows here. */
export default function HomeScreen() {
  const home = useHome();
  const router = useRouter();
  const inbox = useApiQuery<{ data: InboxItemDto[] }>(`${home.orgPath}/inbox`);
  const finance = useApiQuery<MyFinanceDto>(
    home.can('unit.finance.read') ? `${home.unitPath}/my-finance` : null,
  );
  const unread =
    inbox.status === 'success'
      ? inbox.data.data.filter(
          (i) =>
            i.announcement.property.id === home.propertyId &&
            (!i.readAt || (i.announcement.requiresAcknowledgement && !i.acknowledgedAt)),
        ).length
      : 0;
  const { unit } = home;
  const go = (path: string) => router.push(`${home.route}/${path}`);

  const tiles: { path: string; title: string; text: string; show: boolean; badge?: string }[] = [
    {
      path: 'inbox',
      title: 'Inbox',
      text: 'Announcements from your property',
      show: true,
      ...(unread > 0 ? { badge: `${unread} new` } : {}),
    },
    {
      path: 'visitors',
      title: 'Visitors',
      text: 'Passes for guests and deliveries, and gate requests',
      show: home.can('unit.visitor.invite'),
    },
    {
      path: 'maintenance',
      title: 'Maintenance',
      text: 'Report a problem and follow it',
      show: home.can('unit.maintenance.request'),
    },
    {
      path: 'bookings',
      title: 'Bookings',
      text: 'Book shared facilities',
      show: home.can('unit.facility.book'),
    },
    {
      path: 'bills',
      title: 'Bills',
      text:
        finance.status === 'success'
          ? finance.data.accounts.map((a) => balanceText(a.balance)).join(' · ') || 'Nothing owed'
          : 'Invoices, payments and statement',
      show: home.can('unit.finance.read'),
    },
    {
      path: 'documents',
      title: 'Documents',
      text: 'Rules, notices and files for your home',
      show: home.can('unit.document.read'),
    },
  ];

  return (
    <Screen
      onRefresh={() => {
        inbox.reload();
        finance.reload();
      }}
      refreshing={inbox.refreshing}
    >
      <Card>
        <Title>
          Unit {unit.unitNumber}
          {unit.buildingName ? `, ${unit.buildingName}` : ''}
        </Title>
        <Muted>
          {unit.propertyName}
          {unit.floorName ? ` · ${unit.floorName}` : ''}
        </Muted>
      </Card>
      {tiles
        .filter((t) => t.show)
        .map((t) => (
          <Card key={t.path} onPress={() => go(t.path)} label={`${t.title}. ${t.text}`}>
            <Row>
              <Title>{t.title}</Title>
              {t.badge ? <Badge tone="accent">{t.badge}</Badge> : null}
            </Row>
            <Muted>{t.text}</Muted>
          </Card>
        ))}
    </Screen>
  );
}
