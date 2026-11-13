import type { MaintenanceRequestDto } from '@veyra/api-contracts';
import {
  CATEGORY_LABELS,
  REQUEST_STATUS_LABELS,
  REQUEST_STATUS_TONES,
} from '@veyra/client/maintenance';
import { formatInstant } from '@veyra/client/visitors';
import { useRouter } from 'expo-router';
import { Badge, Button, Card, Loaded, Muted, Row, Screen, Title } from '@/components/ui';
import { useHome } from '@/lib/home';
import { useApiQuery } from '@/lib/use-api';

export default function MaintenanceScreen() {
  const home = useHome();
  const router = useRouter();
  const requests = useApiQuery<{ data: MaintenanceRequestDto[] }>(
    `${home.unitPath}/maintenance-requests`,
  );
  return (
    <Screen onRefresh={requests.reload} refreshing={requests.refreshing}>
      <Button
        title="Report a problem"
        onPress={() => router.push(`${home.route}/maintenance/new`)}
      />
      <Loaded query={requests} empty="No requests yet." isEmpty={(d) => d.data.length === 0}>
        {(d) =>
          d.data.map((r) => (
            <Card
              key={r.id}
              onPress={() => router.push(`${home.route}/maintenance/${r.id}`)}
              label={`Request ${r.number}, ${r.title}, ${REQUEST_STATUS_LABELS[r.status]}`}
            >
              <Row>
                <Title>{r.title}</Title>
                <Badge tone={REQUEST_STATUS_TONES[r.status]}>
                  {REQUEST_STATUS_LABELS[r.status]}
                </Badge>
              </Row>
              <Muted>
                {r.number} · {CATEGORY_LABELS[r.category]} ·{' '}
                {formatInstant(r.createdAt, home.unit.propertyTimeZone)}
              </Muted>
            </Card>
          ))
        }
      </Loaded>
    </Screen>
  );
}
