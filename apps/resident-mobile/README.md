# VEYRA Resident (`@veyra/resident-mobile`)

iOS and Android app for owners, tenants and household members. React Native with Expo and
Expo Router (file-based routes in `app/`), on the shared client `@veyra/client` (ADR 0008).

## What residents can do

| Screen | Route | API permission |
| ------ | ----- | -------------- |
| Sign in (bearer session in the secure store) | `/sign-in` | — |
| Your homes, across organisations | `/` | `organisation.profile.read` |
| Home overview: inbox count, balance, services | `/home/[org]/[property]/[unit]` | `unit.profile.read` |
| Visitor passes (QR code and code, shared once), cancel, gate requests to approve or refuse | `…/visitors`, `…/new-pass` | `unit.visitor.invite` |
| Maintenance requests: report, follow, add notes, cancel, confirm or reopen | `…/maintenance` | `unit.maintenance.request` |
| Facility bookings: free times per day, book, cancel | `…/bookings` | `unit.facility.book` |
| Bills: balance, invoices, bank transfer notice | `…/bills` | `unit.finance.read`, `unit.finance.pay` |
| Documents (fresh signed link per tap) | `…/documents` | `unit.document.read` |
| Announcements (read, acknowledge) and notifications | `…/inbox` | signed in |

A service only appears when the API's unit permissions include it. The API checks every request
again. Times are shown and entered in the property's time zone, whatever the phone's own.

## Run

```powershell
# from the repo root, after bun install; the API must be running (bun run dev:api)
$env:EXPO_PUBLIC_API_BASE_URL = "http://<your-PC-LAN-IP>:4000/api/v1"   # a phone cannot reach "localhost" on your PC
bun run --cwd apps/resident-mobile dev
```

Scan the QR code with Expo Go (Android) or the Camera app (iOS), or press `a` or `i` for an
emulator or simulator. Sign in with a resident account (accept its invitation in the console
first).

## Installable APK

GitHub Actions builds an Android APK of this app (workflow **Android APKs**). How to build it
with your API address and install it: [docs/operations/MOBILE_APPS.md](../../docs/operations/MOBILE_APPS.md).

## Structure

```
app/                  screens and navigation (Expo Router); one file per route
src/components/       design-token UI building blocks, QR code view
src/lib/              session (secure store), queries, home context, dates, QR matrix
test/                 Vitest unit tests for src/lib
```

## Rules

- Styling uses `@veyra/design-tokens`; no raw colours or sizes (except the QR code, which is
  always black on white for scanners).
- API types come from `@veyra/api-contracts`; messages, labels and formatting from
  `@veyra/client`. No business rules in the app: the API decides.
- `EXPO_PUBLIC_*` values ship inside the app bundle. Never put secrets in them.
- The session token lives only in `expo-secure-store`, never AsyncStorage.
- Store builds and submissions use EAS once the Apple and Google developer accounts exist.

## Known limitations

- No photo upload on maintenance requests yet (needs the image picker; planned).
- No push notifications yet (owner decision on a provider).
- Paying online is not offered: only a sandbox payment provider exists.
- Password reset and invitation acceptance happen on the website.
