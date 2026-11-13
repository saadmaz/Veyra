import type { IncidentCategory, IncidentDto, IncidentSeverity } from '@veyra/api-contracts';
import { INCIDENT_CATEGORY_LABELS, SEVERITY_LABELS } from '@veyra/client/governance';
import { useState } from 'react';
import {
  Button,
  Card,
  Chips,
  ErrorText,
  Field,
  fieldError,
  Muted,
  Notice,
  Screen,
  Title,
} from '@/components/ui';
import { dayOptions, instantAt } from '@/lib/dates';
import { useClient } from '@/lib/session';
import { useSite } from '@/lib/site';
import { useAction } from '@/lib/use-api';

const CATEGORIES = Object.keys(INCIDENT_CATEGORY_LABELS) as IncidentCategory[];
const SEVERITIES = Object.keys(SEVERITY_LABELS) as IncidentSeverity[];

/** Reports an incident as it happened; it goes to the property's incident log for follow-up. */
export default function IncidentScreen() {
  const site = useSite();
  const client = useClient();
  const tz = site.property.timeZone;
  // Today and yesterday, at the property.
  const days = dayOptions(tz, 1).concat(
    dayOptions(tz, 1, Date.now() - 86_400_000).map((d) => ({ ...d, label: 'Yesterday' })),
  );
  const [category, setCategory] = useState<IncidentCategory | null>(null);
  const [severity, setSeverity] = useState<IncidentSeverity>('MEDIUM');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [where, setWhere] = useState('');
  const [day, setDay] = useState(days[0]?.date ?? '');
  const [time, setTime] = useState('');
  const [sensitive, setSensitive] = useState<'no' | 'yes'>('no');
  const [problem, setProblem] = useState<string | null>(null);
  const [reported, setReported] = useState<IncidentDto | null>(null);
  const action = useAction();

  const submit = () => {
    if (!category) return setProblem('Choose what kind of incident it is.');
    if (!title.trim() || !description.trim())
      return setProblem('Give a title and describe what happened.');
    const occurredAt = time.trim() ? instantAt(day, time, tz) : new Date().toISOString();
    if (!occurredAt)
      return setProblem(
        'Enter the time as hours and minutes, e.g. 21:15, or leave it empty for now.',
      );
    setProblem(null);
    void action.run(async () => {
      setReported(
        await client.post<IncidentDto>(`${site.base}/incidents`, {
          category,
          severity,
          title: title.trim(),
          description: description.trim(),
          occurredAt,
          ...(where.trim() ? { locationDetail: where.trim() } : {}),
          sensitive: sensitive === 'yes',
        }),
      );
    });
  };

  if (reported) {
    return (
      <Screen>
        <Notice>Incident {reported.reference} reported. The property team has been told.</Notice>
        <Card>
          <Title>{reported.title}</Title>
          <Muted>
            {INCIDENT_CATEGORY_LABELS[reported.category]} · {SEVERITY_LABELS[reported.severity]}
          </Muted>
        </Card>
        <Button
          title="Report another"
          variant="secondary"
          onPress={() => {
            setReported(null);
            setTitle('');
            setDescription('');
            setWhere('');
            setTime('');
            setCategory(null);
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Muted>In an emergency, call the emergency services first.</Muted>
      <Chips
        label="What happened"
        options={CATEGORIES.map((c) => ({ value: c, label: INCIDENT_CATEGORY_LABELS[c] }))}
        value={category}
        onChange={setCategory}
      />
      <Chips
        label="How serious"
        options={SEVERITIES.map((s) => ({ value: s, label: SEVERITY_LABELS[s] }))}
        value={severity}
        onChange={setSeverity}
      />
      <Field
        label="Title"
        value={title}
        onChangeText={setTitle}
        error={fieldError(action.error, 'title')}
      />
      <Field
        label="What happened"
        value={description}
        onChangeText={setDescription}
        multiline
        style={{ minHeight: 120, textAlignVertical: 'top' }}
        error={fieldError(action.error, 'description')}
      />
      <Field
        label="Where (optional)"
        value={where}
        onChangeText={setWhere}
        placeholder="Car park level 2"
      />
      <Chips
        label="When"
        options={days.map((d) => ({ value: d.date, label: d.label }))}
        value={day}
        onChange={setDay}
      />
      <Field
        label="At (optional)"
        value={time}
        onChangeText={setTime}
        placeholder="21:15"
        keyboardType="numbers-and-punctuation"
        hint="Leave empty if it is happening now."
        error={fieldError(action.error, 'occurredAt')}
      />
      <Chips
        label="Sensitive (only managers see the details)"
        options={[
          { value: 'no', label: 'No' },
          { value: 'yes', label: 'Yes' },
        ]}
        value={sensitive}
        onChange={setSensitive}
      />
      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      <ErrorText error={action.error} />
      <Button title="Report incident" onPress={submit} pending={action.pending} />
    </Screen>
  );
}
