import { useRouter } from 'expo-router';
import { GateStatus } from '@/components/gate-status';
import { Card, Hero, Muted, Screen, Section, Title } from '@/components/ui';
import { useSite } from '@/lib/site';

/** What this person can do at the site, as the API's permissions allow. */
export default function SiteScreen() {
  const site = useSite();
  const router = useRouter();
  const tiles = [
    {
      path: 'gate',
      title: 'Gate',
      text: 'Scan or type a visitor pass',
      show: site.can('property.visitor.check_in'),
    },
    {
      path: 'walk-in',
      title: 'Walk-in visitor',
      text: 'Ask residents to let someone in',
      show: site.can('property.visitor.check_in'),
    },
    {
      path: 'inside',
      title: 'Inside now',
      text: 'Visitors on site, and departures',
      show: site.can('property.visitor.check_in'),
    },
    {
      path: 'work',
      title: 'My work',
      text: 'Work orders assigned to you',
      show: site.can('property.maintenance.work'),
    },
    {
      path: 'incident',
      title: 'Report an incident',
      text: 'Security, safety and damage',
      show: site.can('property.incident.report'),
    },
    {
      path: 'shifts',
      title: 'My shifts',
      text: 'Start and end shifts, handover notes',
      show: site.can('property.staff.work'),
    },
  ];
  return (
    <Screen>
      <Hero
        overline="Your site"
        value={site.property.name}
        caption="Only what your role allows is shown."
      />
      <GateStatus />
      <Section title="Tasks" />
      {tiles
        .filter((t) => t.show)
        .map((t) => (
          <Card
            key={t.path}
            onPress={() => router.push(`${site.route}/${t.path}`)}
            label={`${t.title}. ${t.text}`}
          >
            <Title>{t.title}</Title>
            <Muted>{t.text}</Muted>
          </Card>
        ))}
    </Screen>
  );
}
