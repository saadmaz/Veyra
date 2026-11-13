import { fontSize, space } from '@veyra/design-tokens';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { Button, ErrorText, Field, Muted, usePalette } from '@/components/ui';
import { useSession } from '@/lib/session';
import { useAction } from '@/lib/use-api';

export default function SignInScreen() {
  const palette = usePalette();
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const action = useAction();

  const submit = () => {
    if (!email.trim() || !password) return;
    void action.run(() => signIn(email.trim(), password));
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.screen, { backgroundColor: palette.bg }]}
    >
      <View style={styles.form}>
        <Text style={[styles.eyebrow, { color: palette.accent }]}>VEYRA RESIDENT</Text>
        <Text accessibilityRole="header" style={[styles.title, { color: palette.text }]}>
          Sign in to your home
        </Text>
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="username"
          returnKeyType="next"
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <ErrorText error={action.error} />
        <Button
          title="Sign in"
          onPress={submit}
          pending={action.pending}
          disabled={!email.trim() || !password}
        />
        <Muted>
          Use the account from your invitation email. Forgot your password? Reset it from the VEYRA
          website.
        </Muted>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center' },
  form: { padding: space[6], gap: space[4] },
  eyebrow: { fontSize: fontSize.xs, fontWeight: '700', letterSpacing: 2 },
  title: { fontSize: fontSize.xl, fontWeight: '700' },
});
