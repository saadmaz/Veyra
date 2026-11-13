# ADR 0008: Two mobile apps on a shared API client

- **Status:** Accepted
- **Date:** 2026-11-13
- **Builds on:** ADR 0004 (React Native with Expo), ADR 0005 (built-in authentication)

## Context

The resident and frontline features exist in the API and the console (Phases 4–11). AGENTS.md
section 9 asks for a resident app and a staff and security app, with offline gate contingency
that never lets a stale permission grant access on its own. The console already holds the
error messages, labels, time-zone handling and offline-gate checks those apps need; copying them
would let the three clients drift apart.

## Decision

1. **Two apps.**
   - **VEYRA Resident** (`apps/resident-mobile`) is for owners, tenants and household members.
   - **VEYRA Staff** (`apps/staff-mobile`) is for guards, technicians and other property staff.

   They serve different people, with different sign-in habits: gate phones are often shared,
   residents keep their own. Their navigation and store listings also differ. Both are Expo apps
   in the Bun workspace.
2. **One shared client, `@veyra/client`** (`packages/client`). It holds the request layer and
   the API error type, user-facing error messages, labels, time-zone and money formatting, upload
   helpers, and the offline-gate checks. It runs on both the web and React Native: no DOM, no
   React, and no platform crypto.
   - **How the session travels:** the console sends the httpOnly cookie
     (`credentials: 'include'`). The apps send `Authorization: Bearer <token>`, with the token
     read from `expo-secure-store`.
   - **Offline-gate hashing:** each platform passes in its own SHA-256 (WebCrypto in the browser,
     `expo-crypto` on phones).

   The console's `src/lib` modules re-export the package, so the console and the apps cannot
   drift apart. Business rules stay in the API.
3. **Two-step sign-in.** It applies to the apps as it does to the console: in production a
   privileged change needs a verified session. The staff app asks for the authenticator code at
   sign-in when the account has two-step sign-in turned on.
4. **Testing.** Vitest covers the shared package and each app's non-UI logic (`src/lib`). Screens
   are typechecked. Device journeys (Maestro) come with the first store release.
5. **Builds.**
   - An installable Android APK for each app is built in GitHub Actions: `expo prebuild`, then
     Gradle `assembleRelease`, uploaded as a workflow artifact. The API address is a workflow
     input, because it is baked into the app.
   - Store builds use EAS once the Google Play and Apple developer accounts exist.
   - The CI APKs are signed with the build's throwaway key. They are for testing and pilots
     only, never for a store.

## Consequences

- A change to an error message or label reaches the console and both apps together.
- `ApiRequestError` recognises its own errors across copies of the package (`Symbol.for` brand),
  because bundlers and test runners can load a package twice.
- Phones cannot reach `localhost`. A test APK needs the API at an address the phone can reach:
  a deployed environment, or the developer machine's LAN address over plain HTTP. The APK allows
  plain HTTP only when it is built with an `http://` API address.
- Two apps means two release trains. They share the client, the design tokens and the build
  workflow.
