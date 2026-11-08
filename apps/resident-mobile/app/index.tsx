import { colors, fontSize, space } from '@veyra/design-tokens';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, useColorScheme, View } from 'react-native';
import { type ApiStatus, checkApiStatus } from '@/lib/api-client';
import { apiBaseUrl } from '@/lib/config';

export default function HomeScreen() {
  const palette = colors[useColorScheme() === 'dark' ? 'dark' : 'light'];
  const [status, setStatus] = useState<ApiStatus | 'checking'>('checking');

  useEffect(() => {
    const controller = new AbortController();
    let baseUrl: string;
    try {
      baseUrl = apiBaseUrl();
    } catch {
      setStatus('offline');
      return;
    }
    checkApiStatus(baseUrl, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setStatus(result);
    });
    return () => controller.abort();
  }, []);

  const statusLabel = {
    checking: 'Checking connection…',
    online: 'Connected to VEYRA',
    degraded: 'VEYRA is having problems. Some features may not work.',
    offline: 'Cannot reach VEYRA. Check your connection.',
  }[status];

  return (
    <View style={[styles.screen, { backgroundColor: palette.bg }]}>
      <Stack.Screen options={{ title: 'VEYRA' }} />
      <Text style={[styles.eyebrow, { color: palette.accent }]}>VEYRA RESIDENT</Text>
      <Text style={[styles.title, { color: palette.text }]}>Your home, in one app.</Text>
      <Text style={[styles.body, { color: palette.textMuted }]}>
        Visitor passes, maintenance requests, bookings, bills and announcements arrive as each
        feature is released. Sign-in arrives with Phase 2.
      </Text>
      <Text
        accessibilityRole="text"
        style={[
          styles.status,
          { color: status === 'online' ? palette.success : palette.textMuted },
        ]}
      >
        {statusLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: space[6], justifyContent: 'center' },
  eyebrow: { fontSize: fontSize.xs, fontWeight: '700', letterSpacing: 2, marginBottom: space[3] },
  title: { fontSize: fontSize.xl, fontWeight: '700', marginBottom: space[4] },
  body: { fontSize: fontSize.md, lineHeight: 24, marginBottom: space[6] },
  status: { fontSize: fontSize.sm },
});
