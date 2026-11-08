# VEYRA Console (`@veyra/console-web`)

The main management web app at `app.veyra.com`, for organisation admins, property managers,
finance officers and committee members. The **Operations** experience for security and
maintenance staff (visitor check-in, incidents, work orders) is built here too, as a responsive,
installable PWA. It moves to its own app only if it outgrows this one.

```powershell
bun run --cwd apps/console-web dev   # http://localhost:3000
```

Structure as features land: `src/app/` routes, `src/features/<feature>/` (api, components,
hooks, schemas), `src/components/` shared UI. Styling uses `@veyra/design-tokens`.
