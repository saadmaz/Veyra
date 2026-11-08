# VEYRA website (`@veyra/marketing-web`)

The public site at `veyra.com`: product, pricing, trust/security, legal and contact pages.
Static-first (no database, no login). Set `NEXT_PUBLIC_CONTACT_EMAIL` to show the contact button.

```powershell
bun run --cwd apps/marketing-web dev   # http://localhost:3001
```

If non-developers need to edit content often, consider a headless CMS rather than moving the
site to a hosted website builder, so it keeps the shared design tokens.
