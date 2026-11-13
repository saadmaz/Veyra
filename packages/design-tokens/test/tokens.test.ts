import { describe, expect, it } from 'vitest';
import { colors, cssVariables } from '../src';

describe('design tokens', () => {
  it('defines the same colour tokens for light and dark schemes', () => {
    expect(Object.keys(colors.dark).sort()).toEqual(Object.keys(colors.light).sort());
  });

  it('uses valid hex colours', () => {
    for (const scheme of Object.values(colors)) {
      for (const value of Object.values(scheme)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('renders CSS custom properties with a dark-mode override', () => {
    const css = cssVariables();
    expect(css).toContain('--color-text-muted: #5c5c63;');
    expect(css).toContain('--space-4: 1rem;');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('--color-bg: #0c0c0d;');
  });
});

/** WCAG 2.x contrast ratio of two hex colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('contrast (WCAG 2.2 AA, normal text)', () => {
  it('keeps text and status colours at 4.5:1 on the page and on cards, in both schemes', () => {
    for (const scheme of Object.values(colors)) {
      for (const token of [
        'text',
        'textMuted',
        'accent',
        'success',
        'warning',
        'danger',
      ] as const) {
        for (const background of [scheme.bg, scheme.surface]) {
          expect(
            contrast(scheme[token], background),
            `${token} on ${background}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
