import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { usePalette } from '@/components/ui';
import { SessionProvider, useSession } from '@/lib/session';

function Navigator() {
  const palette = usePalette();
  const scheme = useColorScheme();
  const { state } = useSession();
  const segments = useSegments();
  const router = useRouter();

  // Signed-out people only see the sign-in screen; signed-in people never see it.
  useEffect(() => {
    if (state.status === 'loading' || state.status === 'unconfigured') return;
    const onSignIn = segments[0] === 'sign-in';
    if (state.status === 'signed-out' && !onSignIn) router.replace('/sign-in');
    if (state.status === 'signed-in' && onSignIn) router.replace('/');
  }, [state.status, segments, router]);

  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: palette.surface },
          headerTintColor: palette.text,
          contentStyle: { backgroundColor: palette.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Your homes' }} />
        <Stack.Screen name="sign-in" options={{ title: 'Sign in', headerShown: false }} />
        <Stack.Screen
          name="home/[organisationId]/[propertyId]/[unitId]"
          options={{ headerShown: false }}
        />
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
