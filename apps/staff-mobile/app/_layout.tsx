import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { usePalette } from '@/components/ui';
import { SessionProvider, useSession } from '@/lib/session';

const target = (status: string) =>
  status === 'signed-out' ? 'sign-in' : status === 'mfa-required' ? 'verify' : null;

function Navigator() {
  const palette = usePalette();
  const { state } = useSession();
  const segments = useSegments();
  const router = useRouter();

  // Signed-out people only see sign-in; accounts with two-step sign-in confirm their code first.
  useEffect(() => {
    if (state.status === 'loading' || state.status === 'unconfigured') return;
    const at = segments[0];
    const want = target(state.status);
    if (want && at !== want) router.replace(`/${want}`);
    if (!want && (at === 'sign-in' || at === 'verify')) router.replace('/');
  }, [state.status, segments, router]);

  return (
    <>
      {/* The staff app is always dark (see usePalette), so the status bar is always light. */}
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: palette.surface },
          headerTintColor: palette.text,
          contentStyle: { backgroundColor: palette.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Workplaces' }} />
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="verify" options={{ title: 'Two-step sign-in' }} />
        <Stack.Screen name="site/[organisationId]/[propertyId]" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SessionProvider>
      <Navigator />
    </SessionProvider>
  );
}
