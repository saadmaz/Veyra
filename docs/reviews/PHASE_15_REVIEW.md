# Phase 15 exit review: Mobile apps (resident and staff)

- **Date:** 2026-11-13
- **Scope:** PRs #74 (shared API client), #75 (VEYRA Resident), #76 (VEYRA Staff), #77 (Android
  APKs and install guide), and this review
- **Decision:** Phase 15 is complete for testing and pilots. Both apps run against the existing
  API with no server changes. Installable Android APKs come from CI. Store releases wait for the
  developer accounts (owner action) and the device journeys.

Decisions (2026-11-13, the recommended options, ADR 0008):

- two Expo apps, VEYRA Resident and VEYRA Staff;
- one shared client package used by the console too;
- bearer sessions kept in the secure store;
- the offline gate on the console's shared rules;
- APKs from GitHub Actions for testing, store builds through EAS later.

## 1. Exit criteria

| Criterion | Status | Evidence |
| --------- | ------ | -------- |
| The apps never decide what a person may do | ✅ | Every screen calls the same API, which checks each request; tiles only mirror the API's unit or property permissions (`/units/:id` and `/properties/:id` responses) |
| Sessions are stored and ended safely | ✅ | Token only in `expo-secure-store`; any 401 forgets it; sign-out ends the server session; two-step sign-in confirmed before the staff app opens |
| Stale offline permissions never grant access on their own (AGENTS.md section 9) | ✅ | Shared `checkOffline` refuses after the list's trust time; queued admissions count against entries left; the server re-checks every queued entry and flags it for review (unit tests in `@veyra/client` and the staff app) |
| No logic drifts between console and apps | ✅ | Messages, labels, time zones, money, uploads and gate checks live in `@veyra/client`; the console re-exports it (46 console unit tests unchanged) |
| Times are the property's, whatever the phone's | ✅ | Day options, typed times and display in the property's IANA zone (unit tests) |
| The apps build for Android | ✅ | `expo export` bundles each app (1185 and 1208 modules); the Android APKs workflow builds both APKs from scratch |
| Screens handle loading, empty, error and success states | ✅ | Shared `Loaded`, `ErrorText` and notices on every screen; touch targets of at least 44 points, with roles and labels for screen readers |

## 2. What residents and staff can do

| VEYRA Resident | VEYRA Staff |
| -------------- | ----------- |
| Homes across organisations | Workplaces where the person has a staff role |
| Visitor passes with QR code and code (shown once), cancel, approve or refuse gate requests | Gate: scan or type, let in or refuse, offline list and queue |
| Maintenance requests: report, follow, notes, cancel, confirm, reopen | Walk-ins to a unit (residents asked) or to the property |
| Facility bookings: free times, book, cancel | Inside now: departures, also for visitors admitted offline |
| Bills: balances, invoices, bank transfer notices | My work orders: start, hold, complete, notes, files |
| Documents (fresh signed link per tap) | Incident reports |
| Inbox: announcements (read, acknowledge) and notifications | My shifts: start, end with handover note |

## 3. Verification at the time of review

Run locally on 2026-11-13 (Windows 11, Node 24, Bun 1.4.4). The APKs were built in CI only:
Android SDK and Gradle are not installed locally.

| Suite | Result |
| ----- | ------ |
| `@veyra/client` unit tests | ✅ 27 |
| Resident app unit tests | ✅ 8 |
| Staff app unit tests | ✅ 5 |
| Console unit tests on the shared client | ✅ 46 |
| Typecheck (all workspaces), lint | ✅ |
| `expo export --platform android`, both apps | ✅ |
| CI `verify` and `smoke` on #74–#77; `Android APKs` on #77 | ✅ before each merge |

## 4. Design review

| Area | Assessment |
| ---- | ---------- |
| Architecture | Two thin clients over the modular monolith's API; no new server code, endpoints or permissions were needed |
| Security | Bearer tokens only in the secure store; no secrets in `EXPO_PUBLIC_*`; plain HTTP only in APKs built against an `http://` address; pass codes never stored, only the offline list's hashes, in private app storage, replaced every refresh |
| Offline | Same rules as the console's gate: trust time, entry counting, server re-check and review, paper log for refusals |
| Dependencies | Expo SDK modules only, at versions chosen by `expo install`: `expo-camera` for QR scanning, `expo-crypto` for SHA-256 and UUIDs, `expo-file-system` for the offline list and queue, `expo-system-ui` for light and dark. The resident app uses `qrcode-generator`, which the console already used |
| Accessibility | Roles, labels, live regions for errors and notices, and 44-point targets. The design tokens' light and dark palettes follow the phone. A screen-reader pass on real devices is still due |

## 5. Open items

### Owner decisions and actions

- Google Play and Apple developer accounts, and an EAS project with managed signing keys, before
  store releases.
- A push notification provider. Today walk-in answers, new work and announcements appear when
  the screen refreshes.
- Whether gate phones run in kiosk mode (screen pinning, sign-out at the end of a shift).

### Engineering follow-ups

- Device journeys (Maestro) for sign-in, a visitor pass end to end, and the offline gate.
- Photo upload on maintenance requests and work orders, using the image picker and the shared
  `uploadFile`.
- Move the copied UI building blocks into a shared mobile package once the workspace uses one
  React version (technical debt in the roadmap).
- Online payments in the resident app, once a payment provider is chosen.
- Password reset and invitation acceptance in the apps; today they are on the website.
