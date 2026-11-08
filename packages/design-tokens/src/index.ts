/**
 * VEYRA design tokens. Web apps consume them as CSS custom properties (`cssVariables()`);
 * the React Native app imports the objects directly. Components use tokens, never raw values.
 */

export const colors = {
  light: {
    bg: '#f7f7f5',
    surface: '#ffffff',
    text: '#15171a',
    textMuted: '#5b616b',
    border: '#e3e4e0',
    accent: '#1f4e46',
    accentContrast: '#ffffff',
    success: '#1d7a4d',
    warning: '#a8670b',
    danger: '#b42318',
  },
  dark: {
    bg: '#0f1113',
    surface: '#171a1d',
    text: '#eceeef',
    textMuted: '#9aa1aa',
    border: '#2a2e33',
    accent: '#7cc4b5',
    accentContrast: '#0f1113',
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
