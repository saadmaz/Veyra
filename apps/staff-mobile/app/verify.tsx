import { useState } from 'react';
import { Body, Button, ErrorText, Field, Muted, Screen } from '@/components/ui';
import { useSession } from '@/lib/session';
import { useAction } from '@/lib/use-api';

/** Confirms the authenticator code (or a recovery code) for this session. */
export default function VerifyScreen() {
  const { verify, signOut } = useSession();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const action = useAction();

  const submit = () => {
    const value = code.trim();
    if (!value) return;
    void action.run(() =>
      verify(recovery ? { recoveryCode: value } : { code: value.replace(/\s/g, '') }),
    );
  };

  return (
    <Screen>
      <Body>
        {recovery
          ? 'Enter one of your recovery codes. Each code works once.'
          : 'Enter the 6-digit code from your authenticator app.'}
      </Body>
      <Field
        label={recovery ? 'Recovery code' : 'Code'}
        value={code}
        onChangeText={setCode}
        keyboardType={recovery ? 'default' : 'number-pad'}
        autoCapitalize="none"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <ErrorText error={action.error} />
      <Button title="Confirm" onPress={submit} pending={action.pending} disabled={!code.trim()} />
      <Button
        title={recovery ? 'Use the authenticator app instead' : 'Use a recovery code instead'}
        variant="secondary"
        onPress={() => {
          setRecovery(!recovery);
          setCode('');
          action.clear();
        }}
      />
      <Muted>Lost your phone and your codes? Ask your organisation administrator.</Muted>
      <Button title="Sign out" variant="secondary" onPress={() => void signOut()} />
    </Screen>
  );
}
