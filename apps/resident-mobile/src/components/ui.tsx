import { errorMessage, fieldErrors } from '@veyra/client/messages';
import { colors, fontSize, radius, space } from '@veyra/design-tokens';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  useColorScheme,
  View,
} from 'react-native';
import type { QueryState } from '@/lib/use-api';

/*
 * The app's building blocks, all on the design tokens. Every screen shows loading, empty, error
 * and success states (AGENTS.md section 19); touch targets are at least 44 points.
 */

export type Palette = (typeof colors)['light'] | (typeof colors)['dark'];

export function usePalette(): Palette {
  return colors[useColorScheme() === 'dark' ? 'dark' : 'light'];
}

export function Screen({
  children,
  onRefresh,
  refreshing = false,
}: {
  children: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const palette = usePalette();
  return (
    <ScrollView
      style={{ backgroundColor: palette.bg }}
      contentContainerStyle={styles.screen}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined
      }
    >
      {children}
    </ScrollView>
  );
}

export function Card({
  children,
  onPress,
  label,
}: {
  children: ReactNode;
  onPress?: () => void;
  label?: string;
}) {
  const palette = usePalette();
  const style = [styles.card, { backgroundColor: palette.surface, borderColor: palette.border }];
  // Pressable cards dim slightly when pressed, like the design's list rows.
  if (!onPress) return <View style={style}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [...style, pressed && { opacity: 0.7 }]}
    >
      {children}
    </Pressable>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return (
    <Text accessibilityRole="header" style={[styles.heading, { color: palette.text }]}>
      {children}
    </Text>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return <Text style={[styles.title, { color: palette.text }]}>{children}</Text>;
}

export function Body({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return <Text style={[styles.body, { color: palette.text }]}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return <Text style={[styles.muted, { color: palette.textMuted }]}>{children}</Text>;
}

/** Any tone name from the shared label tables; unknown ones read as neutral. */
export type Tone = string;

/** A translucent version of a token colour (#rrggbb), for tinted backgrounds. */
export function tint(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${a}` : hex;
}

function toneColor(palette: Palette, tone: Tone): string {
  if (tone === 'success' || tone === 'warning' || tone === 'danger') return palette[tone];
  if (tone === 'accent' || tone === 'info') return palette.accent;
  return palette.textMuted;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  const palette = usePalette();
  const color = toneColor(palette, tone);
  return (
    <View style={[styles.badge, { backgroundColor: tint(color, 0.12) }]}>
      <View style={[styles.badgeDot, { backgroundColor: color }]} />
      <Text style={[styles.badgeText, { color }]}>{children}</Text>
    </View>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  pending = false,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  pending?: boolean;
}) {
  const palette = usePalette();
  const background =
    variant === 'primary'
      ? palette.accent
      : variant === 'danger'
        ? palette.danger
        : palette.surface;
  const color = variant === 'secondary' ? palette.text : palette.accentContrast;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || pending, busy: pending }}
      disabled={disabled || pending}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: variant === 'secondary' ? palette.border : background,
        },
        (disabled || pending) && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
      ]}
    >
      {pending ? (
        <ActivityIndicator color={color} />
      ) : (
        <Text style={[styles.buttonText, { color }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  error,
  hint,
  ...input
}: TextInputProps & { label: string; error?: string | undefined; hint?: string }) {
  const palette = usePalette();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: palette.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={palette.textMuted}
        style={[
          styles.input,
          {
            color: palette.text,
            backgroundColor: palette.surface,
            borderColor: error ? palette.danger : palette.border,
          },
        ]}
        {...input}
      />
      {hint && !error ? <Muted>{hint}</Muted> : null}
      {error ? <Text style={[styles.fieldError, { color: palette.danger }]}>{error}</Text> : null}
    </View>
  );
}

export function Chips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
}) {
  const palette = usePalette();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: palette.text }]}>{label}</Text>
      <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => onChange(option.value)}
              style={[
                styles.chip,
                {
                  borderColor: selected ? palette.accent : palette.border,
                  borderRadius: 999,
                  backgroundColor: selected ? palette.accent : palette.surface,
                },
              ]}
            >
              <Text
                style={{
                  color: selected ? palette.accentContrast : palette.textMuted,
                  fontSize: fontSize.sm,
                  fontWeight: '500',
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** An error from the API in plain words, announced to screen readers. */
export function ErrorText({ error }: { error: unknown }) {
  const palette = usePalette();
  if (!error) return null;
  return (
    <Text
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[styles.errorText, { color: palette.danger }]}
    >
      {errorMessage(error)}
    </Text>
  );
}

export const fieldError = (error: unknown, name: string) => fieldErrors(error)[name];

export function Notice({ children, tone = 'success' }: { children: ReactNode; tone?: Tone }) {
  const palette = usePalette();
  const color = toneColor(palette, tone);
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.notice, { borderColor: tint(color, 0.3), backgroundColor: tint(color, 0.08) }]}
    >
      <Text style={{ color: palette.text, fontSize: fontSize.sm }}>{children}</Text>
    </View>
  );
}

/** The ink headline card at the top of a screen (balance, site, pass), as in the design file. */
export function Hero({
  overline,
  value,
  caption,
  children,
}: {
  overline: string;
  value: string;
  caption?: string;
  children?: ReactNode;
}) {
  const palette = usePalette();
  // The hero is always ink-on-paper inverted: dark in light mode, light in dark mode.
  const background = palette.text;
  const foreground = palette.bg;
  return (
    <View style={[styles.hero, { backgroundColor: background }]}>
      <Text style={[styles.overline, { color: tint(foreground, 0.7) }]}>{overline}</Text>
      <Text accessibilityRole="header" style={[styles.heroValue, { color: foreground }]}>
        {value}
      </Text>
      {caption ? (
        <Text style={[styles.muted, { color: tint(foreground, 0.72) }]}>{caption}</Text>
      ) : null}
      {children}
    </View>
  );
}

/** A small uppercase label above a group of cards. */
export function Section({ title }: { title: string }) {
  const palette = usePalette();
  return (
    <Text
      accessibilityRole="header"
      style={[styles.overline, styles.section, { color: palette.textMuted }]}
    >
      {title}
    </Text>
  );
}

/** Loading, error (with retry) and empty states for a query; renders children with the data. */
export function Loaded<T>({
  query,
  empty,
  isEmpty,
  children,
}: {
  query: QueryState<T> & { reload(): void };
  empty?: string;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  const palette = usePalette();
  if (query.status === 'loading') {
    return (
      <View style={styles.state} accessibilityLabel="Loading">
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }
  if (query.status === 'error') {
    return (
      <View style={styles.state}>
        <ErrorText error={query.error} />
        <Button title="Try again" variant="secondary" onPress={query.reload} />
      </View>
    );
  }
  if (empty && isEmpty?.(query.data)) {
    return (
      <View style={styles.state}>
        <Muted>{empty}</Muted>
      </View>
    );
  }
  return <>{children(query.data)}</>;
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: space[3], paddingBottom: space[12] },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: space[4], gap: space[1] },
  heading: { fontSize: 26, fontWeight: '600', letterSpacing: -0.5, marginTop: space[2] },
  title: { fontSize: 15, fontWeight: '600', letterSpacing: -0.1 },
  body: { fontSize: 15, lineHeight: 22 },
  muted: { fontSize: 13, lineHeight: 19 },
  overline: { fontSize: 11, fontWeight: '600', letterSpacing: 1.2, textTransform: 'uppercase' },
  section: { marginTop: space[3] },
  hero: { borderRadius: 20, padding: 20, gap: space[1] },
  heroValue: { fontSize: 30, fontWeight: '600', letterSpacing: -0.8 },
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  badgeDot: { width: 6, height: 6, borderRadius: 3 },
  badgeText: { fontSize: fontSize.xs, fontWeight: '500' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2], alignItems: 'center' },
  button: {
    minHeight: 50,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space[4],
  },
  buttonText: { fontSize: 15, fontWeight: '600' },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '500' },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space[3],
    fontSize: 15,
  },
  fieldError: { fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  chip: {
    minHeight: 44,
    justifyContent: 'center',
    borderWidth: 1,
    paddingHorizontal: 14,
  },
  errorText: { fontSize: 13 },
  notice: { borderWidth: 1, borderRadius: radius.md, padding: 14 },
  state: { paddingVertical: space[8], alignItems: 'center', gap: space[3] },
});
