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
    expect(css).toContain('--color-text-muted: #5b616b;');
    expect(css).toContain('--space-4: 1rem;');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('--color-bg: #0f1113;');
  });
});
