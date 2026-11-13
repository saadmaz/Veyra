/**
 * VEYRA design tokens (Graphite theme, ADR 0009). Web apps consume them as CSS custom properties (`cssVariables()`);
 * the React Native app imports the objects directly. Components use tokens, never raw values.
 */

export const colors = {
  light: {
    bg: '#f8f8f8',
    surface: '#ffffff',
    text: '#111113',
    textMuted: '#5c5c63',
    border: '#e6e6e8',
    accent: '#18181b',
    accentContrast: '#ffffff',
    success: '#1d7a4d',
    warning: '#975c0a',
    danger: '#b42318',
  },
  dark: {
    bg: '#0c0c0d',
    surface: '#161618',
    text: '#f4f4f5',
    textMuted: '#a3a3aa',
    border: '#2a2a2e',
    accent: '#e8e8ea',
    accentContrast: '#0c0c0d',
    success: '#4cc38a',
    warning: '#f0b44c',
    danger: '#f97066',
  },
} as const;

export type ColorScheme = keyof typeof colors;
export type ColorToken = keyof (typeof colors)['light'];

/** Spacing scale in pixels (4px grid). */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 12: 48 } as const;

export const radius = { sm: 6, md: 10, lg: 16 } as const;

/** Font sizes in pixels. */
export const fontSize = { xs: 12, sm: 14, md: 16, lg: 20, xl: 32, xxl: 52 } as const;

export const fontFamily = {
  sans: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
} as const;

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function block(selector: string, scheme: ColorScheme, includeScale: boolean): string {
  const lines = Object.entries(colors[scheme]).map(([k, v]) => `  --color-${kebab(k)}: ${v};`);
  if (includeScale) {
    lines.push(
      ...Object.entries(space).map(([k, v]) => `  --space-${k}: ${v / 16}rem;`),
      ...Object.entries(radius).map(([k, v]) => `  --radius-${k}: ${v}px;`),
      ...Object.entries(fontSize).map(([k, v]) => `  --text-${k}: ${v / 16}rem;`),
      `  --font-sans: ${fontFamily.sans};`,
    );
  }
  return `${selector} {\n${lines.join('\n')}\n}`;
}

/** CSS custom properties for web apps, with a dark-mode override. */
export function cssVariables(): string {
  return [
    block(':root', 'light', true),
    `@media (prefers-color-scheme: dark) {\n${block(':root', 'dark', false)}\n}`,
  ].join('\n');
}
