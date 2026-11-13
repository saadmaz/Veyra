import type { CreateVisitorInvitationResponse, VisitorCategory } from '@veyra/api-contracts';
import { enumLabel } from '@veyra/client/messages';
import { formatInstant, VISITOR_CATEGORIES } from '@veyra/client/visitors';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Share } from 'react-native';
import { QrCode } from '@/components/qr-code';
import {
  Body,
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
import { dayOptions, instantAt, plusHours } from '@/lib/dates';
import { useHome } from '@/lib/home';
import { useClient } from '@/lib/session';
import { useAction } from '@/lib/use-api';

const DURATIONS = [
  { value: '2', label: '2 hours' },
  { value: '4', label: '4 hours' },
  { value: '8', label: '8 hours' },
  { value: '24', label: 'All day' },
];
const ENTRIES = [
  { value: '1', label: 'Once' },
  { value: '2', label: 'Twice' },
  { value: '5', label: 'Up to 5 times' },
];

export default function NewPassScreen() {
  const home = useHome();
  const client = useClient();
  const router = useRouter();
  const tz = home.unit.propertyTimeZone;
  const days = useMemo(() => dayOptions(tz, 7), [tz]);
  const [category, setCategory] = useState<VisitorCategory>('GUEST');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [plate, setPlate] = useState('');
  const [day, setDay] = useState(days[0]?.date ?? '');
  const [time, setTime] = useState('');
  const [hours, setHours] = useState('4');
  const [entries, setEntries] = useState('1');
  const [problem, setProblem] = useState<string | null>(null);
  const [issued, setIssued] = useState<CreateVisitorInvitationResponse | null>(null);
  const action = useAction();

  const submit = () => {
    if (!name.trim()) return setProblem('Enter the visitor’s name.');
    const from = instantAt(day, time, tz);
    if (!from) return setProblem('Enter the arrival time as hours and minutes, e.g. 18:30.');
    setProblem(null);
    const validFrom = Date.parse(from) < Date.now() ? new Date().toISOString() : from;
    void action.run(async () => {
      const response = await client.post<CreateVisitorInvitationResponse>(
        `${home.unitPath}/visitor-invitations`,
        {
          category,
          visitorName: name.trim(),
          ...(phone.trim() ? { visitorPhone: phone.trim() } : {}),
          ...(plate.trim() ? { vehiclePlate: plate.trim() } : {}),
          validFrom,
          validUntil: plusHours(from, Number(hours)),
          maxEntries: Number(entries),
        },
      );
      setIssued(response);
    });
  };

  if (issued) {
    const { invitation, pass } = issued;
    const message =
      `Your visitor pass for ${home.unit.propertyName}, unit ${home.unit.unitNumber}.\n` +
      `Code: ${pass.code}\n` +
      `Valid ${formatInstant(invitation.validFrom, tz)} to ${formatInstant(invitation.validUntil, tz)}.`;
    return (
      <Screen>
        <Notice>Pass ready for {invitation.visitorName}.</Notice>
        <Card>
          <QrCode value={pass.token} label={`QR code for ${invitation.visitorName}`} />
          <Title>Code: {pass.code}</Title>
          <Muted>
            Valid {formatInstant(invitation.validFrom, tz)} to{' '}
            {formatInstant(invitation.validUntil, tz)}
          </Muted>
          <Body>
            Send the code to your visitor, or let them scan this screen. This is the only time the
            code is shown: if it is lost, cancel the pass and make a new one.
          </Body>
        </Card>
        <Button title="Share the code" onPress={() => void Share.share({ message })} />
        <Button title="Done" variant="secondary" onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Chips
        label="Who is coming"
        options={VISITOR_CATEGORIES.map((c) => ({ value: c, label: enumLabel(c) }))}
        value={category}
        onChange={setCategory}
      />
      <Field
        label="Visitor’s name"
        value={name}
        onChangeText={setName}
        error={fieldError(action.error, 'visitorName')}
        autoCapitalize="words"
      />
      <Field
        label="Phone (optional)"
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        error={fieldError(action.error, 'visitorPhone')}
      />
      <Field
        label="Vehicle plate (optional)"
        value={plate}
        onChangeText={setPlate}
        autoCapitalize="characters"
        error={fieldError(action.error, 'vehiclePlate')}
      />
      <Chips
        label="Day"
        options={days.map((d) => ({ value: d.date, label: d.label }))}
        value={day}
        onChange={setDay}
      />
      <Field
        label="Arrives at"
        value={time}
        onChangeText={setTime}
        placeholder="18:30"
        keyboardType="numbers-and-punctuation"
        hint={`Time at the property (${tz}).`}
        error={fieldError(action.error, 'validFrom')}
      />
      <Chips label="Valid for" options={DURATIONS} value={hours} onChange={setHours} />
      <Chips label="Entries" options={ENTRIES} value={entries} onChange={setEntries} />
      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      <ErrorText error={action.error} />
      <Button title="Create pass" onPress={submit} pending={action.pending} />
    </Screen>
  );
}
