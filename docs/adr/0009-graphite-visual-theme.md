# ADR 0009: Graphite as the default visual theme

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

The first design tokens used an evergreen accent (`#1f4e46`) on warm neutrals. The owner reviewed
four brand themes in the product design file (Evergreen, Indigo, Terracotta, Graphite) and chose
Graphite as the look of the product: near-black ink on cool neutrals, with colour kept for status.

## Decision

1. `packages/design-tokens` uses the Graphite palette for both schemes:
   - **Light:** paper `#f8f8f8`, surface `#ffffff`, ink text `#111113`, accent `#18181b`.
   - **Dark:** `#0c0c0d` / `#161618`, text `#f4f4f5`, accent `#e8e8ea` on `#0c0c0d`.
2. Status colours (success, warning, danger) are unchanged. They remain the only saturated colours
   in the interface, so a colour always carries meaning and is always paired with a text label.
3. Transactional emails use the same ink, paper and text values.
4. The token names and the `cssVariables()` output format are unchanged. Only the values change,
   so web and mobile apps pick up the theme without code changes.
5. The other three themes stay in the design file as white-label options. Supporting them in code
   (per-organisation theming) is future work and needs its own decision.

## Consequences

- Every surface (console, admin, marketing, resident and staff apps, emails) switches to Graphite in
  one change.
- The existing contrast tests (WCAG 2.2 AA, 4.5:1 for text and status colours on page and card
  backgrounds, in both schemes) still apply and pass with the new values.
- The design file and the code share one source of values again.
