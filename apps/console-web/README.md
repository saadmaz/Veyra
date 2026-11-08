# VEYRA Console (`@veyra/console-web`)

The main management web app at `app.veyra.com`, for organisation admins, property managers,
finance officers and committee members. The **Operations** experience for security and
maintenance staff (visitor check-in, incidents, work orders) is built here too, as a responsive,
installable PWA. It moves to its own app only if it outgrows this one.

```powershell
bun run --cwd apps/console-web dev   # http://localhost:3000 (needs the API on :4000)
```

## Screens (Phase 2)

| Route | Purpose |
| ----- | ------- |
| `/sign-in`, `/sign-up` | Sign in or create an account; `?next=` returns to the requested page (same-site paths only) |
| `/organisations` | The user's organisations, empty state with "create" |
| `/organisations/new` | Create an organisation (the creator becomes its admin) |
| `/organisations/[id]` | Overview; members and invitations when the user may see them |
| `/invitations/accept#token=…` | Accept an invitation; the token is in the URL fragment, never sent to a server |

The header has a skip link, an organisation switcher (native `<select>`) and sign-out.

## How it talks to the API

Pages are client components that call the API directly with `credentials: 'include'`, using
the API's httpOnly session cookie ([ADR 0006](../../docs/adr/0006-console-calls-api-from-browser.md)).
`NEXT_PUBLIC_API_BASE_URL` sets the API address (default `http://localhost:4000/api/v1`) and is
read at build time. The API's `API_CORS_ORIGINS` must include the console's origin.

## Structure

- `src/app/` routes: `(auth)` sign-in/up layout, `(console)` signed-in layout, invitation page.
- `src/components/` shared UI (`ui.tsx`: buttons, fields, alerts, loading/empty/error states;
  `app-shell.tsx`).
- `src/lib/` API client, session context, data hook, error messages, safe redirects.
- Styling: `src/app/globals.css`, values from `@veyra/design-tokens` only.

## Tests

- `bun run test`: unit tests for the client library (`test/`).
- `bun run test:e2e`: Playwright journeys in Chromium at desktop and phone sizes, with axe
  WCAG 2.2 AA checks (`e2e/`). Needs a production build (`bun run build`) and, once,
  `bunx playwright install chromium`. API calls are answered by `e2e/fake-api.ts`.
