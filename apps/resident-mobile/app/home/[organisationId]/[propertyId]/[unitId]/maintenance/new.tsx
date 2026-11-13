import type {
  MaintenanceCategory,
  ResidentMaintenanceRequestDetailDto,
} from '@veyra/api-contracts';
import { CATEGORIES, CATEGORY_LABELS } from '@veyra/client/maintenance';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Button,
  Chips,
  ErrorText,
  Field,
  fieldError,
  Muted,
  Notice,
  Screen,
} from '@/components/ui';
import { useHome } from '@/lib/home';
import { useClient } from '@/lib/session';
import { useAction } from '@/lib/use-api';

export default function NewRequestScreen() {
  const home = useHome();
  const client = useClient();
  const router = useRouter();
  const [category, setCategory] = useState<MaintenanceCategory | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [where, setWhere] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const action = useAction();

  const submit = () => {
    if (!category) return setProblem('Choose what kind of problem it is.');
    if (!title.trim() || !description.trim())
      return setProblem('Give the problem a title and describe it.');
    setProblem(null);
    void action.run(async () => {
      const created = await client.post<ResidentMaintenanceRequestDetailDto>(
        `${home.unitPath}/maintenance-requests`,
        {
          category,
          title: title.trim(),
          description: description.trim(),
          ...(where.trim() ? { locationDetail: where.trim() } : {}),
        },
      );
      router.replace(`${home.route}/maintenance/${created.request.id}`);
    });
  };

  return (
    <Screen>
      <Chips
        label="What kind of problem"
        options={CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
        value={category}
        onChange={setCategory}
      />
      <Field
        label="Title"
        value={title}
        onChangeText={setTitle}
        placeholder="Kitchen tap is leaking"
        error={fieldError(action.error, 'title')}
      />
      <Field
        label="What is wrong"
        value={description}
        onChangeText={setDescription}
        multiline
        style={{ minHeight: 120, textAlignVertical: 'top' }}
        error={fieldError(action.error, 'description')}
      />
      <Field
        label="Where in your home (optional)"
        value={where}
        onChangeText={setWhere}
        placeholder="Kitchen"
        error={fieldError(action.error, 'locationDetail')}
      />
      <Muted>For an emergency such as fire, flooding or a gas smell, call security first.</Muted>
      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      <ErrorText error={action.error} />
      <Button title="Send request" onPress={submit} pending={action.pending} />
    </Screen>
  );
}
