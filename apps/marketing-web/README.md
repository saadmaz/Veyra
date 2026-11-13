# VEYRA website (`@veyra/marketing-web`)

The public site at `veyra.com`: product, pricing, trust/security, legal and contact pages.
Static-first (no database, no login). The layout follows the **Marketing Web** page of the VEYRA
design file (home, pricing and the mobile layout).

| Variable | Effect |
| --- | --- |
| `NEXT_PUBLIC_CONTACT_EMAIL` | "Talk to us" opens an email to this address. Unset: the button reads "Start free trial" and opens console sign-up. |
| `NEXT_PUBLIC_CONSOLE_URL` | Base URL for "Sign in" and "Start free trial" (default `http://localhost:3000`). |

The product screenshot in `src/assets/product-console.png` is exported from the design file and
contains sample data only.

```powershell
bun run --cwd apps/marketing-web dev   # http://localhost:3001
```

If non-developers need to edit content often, consider a headless CMS rather than moving the
site to a hosted website builder, so it keeps the shared design tokens.
