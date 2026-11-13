import { usePathname, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activeTab, type TabDef } from '@/lib/tabs';
import { Icon } from './icon';
import { usePalette } from './ui';

/**
 * Bottom tab bar from the design file. It sits under the stack so every route and deep link stays
 * as it was; a tab press navigates to the tab's root screen.
 */
export function TabBar({ route, tabs }: { route: string; tabs: TabDef[] }) {
  const palette = usePalette();
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const current = activeTab(pathname, route, tabs);
  if (tabs.length < 2) return null;
  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.bar,
        {
          backgroundColor: palette.surface,
          borderTopColor: palette.border,
          paddingBottom: Math.max(insets.bottom, 8),
        },
      ]}
    >
      {tabs.map((tab) => {
        const selected = tab.key === current;
        const color = selected ? palette.accent : palette.textMuted;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={tab.label}
            onPress={() => router.navigate(tab.path ? `${route}/${tab.path}` : route)}
            style={({ pressed }) => [styles.item, pressed && { opacity: 0.6 }]}
          >
            <Icon name={tab.icon} color={color} />
            <Text style={[styles.label, { color, fontWeight: selected ? '600' : '500' }]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
  },
  item: { minWidth: 64, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 3 },
  label: { fontSize: 11 },
});
