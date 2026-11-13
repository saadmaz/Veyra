# VEYRA Staff (`@veyra/staff-mobile`)

Android and iOS app for guards, technicians and other property staff. React Native with Expo
and Expo Router, on the shared client `@veyra/client` (ADR 0008).

## What staff can do

| Screen | Route | API permission |
| ------ | ----- | -------------- |
| Sign in; authenticator or recovery code when the account has two-step sign-in | `/sign-in`, `/verify` | — |
| Workplaces: properties where this person has a staff role | `/` | `organisation.profile.read` |
| Gate: scan a QR code (camera) or type a code, let in or refuse with a reason | `/site/[org]/[property]/gate` | `property.visitor.check_in` |
| Walk-in visitors: ask the unit's residents, or admit to the property itself; waiting requests | `…/walk-in` | `property.visitor.check_in` |
| Inside now: visitors on site, departures | `…/inside` | `property.visitor.check_in` |
| My work orders: start, hold, resume, complete, notes (staff only or also the resident), files | `…/work` | `property.maintenance.work` |
| Report an incident | `…/incident` | `property.incident.report` |
| My shifts: start, end with a handover note, read the previous handover | `…/shifts` | `property.staff.work` |

## Offline gate

The gate keeps working when the connection drops, with the same rules as the console's gate
(Phase 5 Part 5); the pass checks are shared code (`@veyra/client/offline-gate`).

- While online, the phone keeps the property's offline list: passes usable in the next 4 hours,
  as hashes only, never codes. It is stored in the app's private storage and refreshed every
  15 minutes.
- Offline, a scanned or typed pass is hashed on the phone (`expo-crypto`) and checked against
  that list. Once the list is past its trust time, every pass is refused with a message to follow
  the paper procedure: a stale list never decides on its own.
- Admissions, refusals, walk-ins to the property itself and departures are queued on the phone.
  They are sent when the connection returns (the app checks every 20 seconds and when it comes
  back to the foreground).
- The server re-checks every queued entry at the time it happened. Entries the pass would not
  have allowed are recorded for a supervisor to review. Entries it cannot record at all are
  listed for the paper log.
- Walk-ins to a unit need the residents' answer, so they are refused offline.

## Run

```powershell
# from the repo root, after bun install; the API must be running (bun run dev:api)
$env:EXPO_PUBLIC_API_BASE_URL = "http://<your-PC-LAN-IP>:4000/api/v1"
bun run --cwd apps/staff-mobile dev
```

Scanning needs a real phone (Expo Go includes the camera module).

## Installable APK

GitHub Actions builds an Android APK of this app (workflow **Android APKs**). How to build it
with your API address and install it: [docs/operations/MOBILE_APPS.md](../../docs/operations/MOBILE_APPS.md).

## Structure

```
app/                  screens and navigation (Expo Router)
src/components/       design-token UI building blocks, gate status
src/lib/              session with two-step sign-in, site context, gate rules, device storage,
                      connection and offline queue
test/                 Vitest unit tests for src/lib
```

## Rules

As in `apps/resident-mobile`. In addition, the gate never stores pass codes: only the hashes in
the offline list, which is replaced on every refresh and ignored once expired.

## Known limitations

- The UI building blocks (`src/components/ui.tsx`, `src/lib/use-api.ts`, `src/lib/dates.ts`) are a
  copy of the resident app's. They should move to a shared package once both apps and the web
  apps use one React version: today the apps pin React 19.3.0 for React Native, and a shared
  package would load a second React.
- No photo upload on work orders yet (needs the image picker; planned).
- No push notifications yet. Walk-in answers and new work appear on refresh.
- Kiosk mode for dedicated gate phones (screen pinning, auto sign-out) is not set up.
