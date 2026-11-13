import type { WorkOrderDto } from '@veyra/api-contracts';
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  relativeTime,
  WORK_STATUS_LABELS,
  WORK_STATUS_TONES,
} from '@veyra/client/maintenance';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Badge, Card, Chips, Loaded, Muted, Row, Screen, Title } from '@/components/ui';
import { useSite } from '@/lib/site';
import { useApiQuery } from '@/lib/use-api';

const SHOW = [
  { value: 'current', label: 'To do' },
  { value: 'COMPLETED', label: 'Completed' },
] as const;

export default function MyWorkScreen() {
  const site = useSite();
  const router = useRouter();
  const [show, setShow] = useState<(typeof SHOW)[number]['value']>('current');
  const work = useApiQuery<{ data: WorkOrderDto[] }>(
    `${site.base}/my-work-orders${show === 'current' ? '' : `?status=${show}`}`,
  );
  return (
    <Screen onRefresh={work.reload} refreshing={work.refreshing}>
      <Chips label="Show" options={[...SHOW]} value={show} onChange={setShow} />
      <Loaded query={work} empty="Nothing assigned to you." isEmpty={(d) => d.data.length === 0}>
        {(d) =>
          d.data.map((w) => (
            <Card
              key={w.id}
              onPress={() => router.push(`${site.route}/work/${w.id}`)}
              label={`Work order ${w.number}, ${w.title}`}
            >
              <Row>
                <Title>{w.title}</Title>
                <Badge tone={WORK_STATUS_TONES[w.status]}>{WORK_STATUS_LABELS[w.status]}</Badge>
              </Row>
              <Muted>
                {w.number} · {CATEGORY_LABELS[w.category]} · {PRIORITY_LABELS[w.priority]}
                {w.dueAt ? ` · due ${relativeTime(w.dueAt)}` : ''}
              </Muted>
            </Card>
          ))
        }
      </Loaded>
    </Screen>
  );
}
