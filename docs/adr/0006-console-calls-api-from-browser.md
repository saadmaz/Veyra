# ADR 0006: The console calls the API from the browser, with the API's session cookie

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

The API issues web sessions as an httpOnly cookie on its own host (`__Host-veyra_session` in
production, ADR 0005). The console (`apps/console-web`, Next.js) needs that session to load data.
Two designs were considered:

1. **Browser to API directly.** Pages are client components that call the API with
   `credentials: 'include'`. The console server never handles the session.
2. **Backend-for-frontend (BFF).** The console server proxies API calls and renders pages
   server-side with the user's session, which then has to live on the console's host.

## Decision

Use option 1 for now.

- The console and the API must be **same-site**: `app.veyra.com` and `api.veyra.com` in
  production, `localhost:3000` and `localhost:4000` in development. The `SameSite=Lax` cookie is
  then sent on the console's API calls, and CORS (`API_CORS_ORIGINS`, credentials allowed) lets
  the console read the responses.
- Pages are client-rendered. Signed-in pages show a loading state while the session is checked,
  then redirect to sign-in if there is none. The API remains the only enforcement point; the
  console hides actions only for convenience.
- The API's Origin check (AUTHENTICATION section 6) must list the console's origin.

## Consequences

- No session handling or proxying in the console server; one less place that holds credentials.
- No server-side rendering of signed-in data: slower first paint on signed-in pages, and no SEO
  (not needed: the console is never indexed).
- Hosting the console and the API under different registrable domains would break sign-in. A
  custom-domain or white-label setup per customer needs a BFF (option 2) and a new ADR.
- Revisit if server rendering of signed-in pages becomes a measured need.
