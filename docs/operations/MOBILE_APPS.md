# Mobile apps: getting and installing the APKs

VEYRA has two Android and iOS apps (ADR 0008):

- **VEYRA Resident** (`apps/resident-mobile`) for owners, tenants and household members.
- **VEYRA Staff** (`apps/staff-mobile`) for guards, technicians and property staff.

For testing and pilots, GitHub Actions builds an installable Android APK of each app. Store
releases (Google Play, App Store) come later, through EAS, once the developer accounts exist.

## 1. Decide which API the phones will use

The API address is built into the app, so choose it before building:

| Where the API runs | Address to build with |
| ------------------ | --------------------- |
| A deployed environment (pilot, staging) | `https://<api host>/api/v1` |
| Your PC, phone on the same Wi-Fi | `http://<your PC's LAN IP>:4000/api/v1` (find the IP with `ipconfig`) |
| Your PC, Android emulator on the same PC | `http://10.0.2.2:4000/api/v1` (the default) |

A phone can never reach `localhost` on your PC. Plain `http://` is allowed only in apps built with
an `http://` address, for testing. For a PC, start the stack (`bun run services:up`,
`bun run db:migrate`, `bun run dev:api`) and allow port 4000 through the Windows firewall for
private networks.

## 2. Build the APKs

1. On GitHub, open **Actions → Android APKs → Run workflow**.
2. Enter the API address from step 1 and run it. Each app takes about 20–30 minutes.
3. When the run is green, download **veyra-resident-apk** and **veyra-staff-apk** from the run's
   **Artifacts** section. Each is a zip holding `veyra-<app>-<commit>.apk`. Artifacts are kept for
   30 days.

The workflow also runs on every pull request and every merge that changes a mobile app or a
package it uses, with the emulator address. Those APKs only reach an API running on the same
machine as an emulator. To save runner minutes they build only the app that changed (both when a
shared package, the lockfile or the workflow changes), and pull-request builds are for phones
(arm64) only, so they will not install on an x86_64 emulator. Merges to `main`
build for phones and the emulator; manual runs build both apps.

## 3. Install on an Android phone

1. Copy the `.apk` to the phone (USB, a cloud drive or email), or download the artifact on the
   phone itself and unzip it.
2. Open the file. Android asks to allow installing apps from that source (the browser or the
   Files app): allow it for that app only.
3. Install. Android may warn that the app is from an unknown developer. That is expected for test
   builds signed with the throwaway key.
4. Open **VEYRA** (resident) or **VEYRA Staff** and sign in.

To update, install the newer APK over the old one. If Android refuses because the signature
differs, uninstall first (this signs you out). Each CI build may use a different throwaway key.

**Emulator:** drag the `.apk` onto a running Android emulator window, or run
`adb install veyra-resident-<commit>.apk`.

## 4. Accounts to sign in with

- **Resident app:** a resident account. Invite the person to a unit in the console, accept the
  invitation from the email link on the website, then sign in with the same email and password.
- **Staff app:** an account with a staff role at a property: Security Guard or Supervisor,
  Technician or Maintenance Manager, or another role with the gate, work order, incident or shift
  permissions. Accounts with two-step sign-in are asked for the authenticator code after the
  password.

## Without building: Expo Go

For quick testing on a phone, install **Expo Go** from the Play Store or App Store. Then on the
PC run:

```powershell
$env:EXPO_PUBLIC_API_BASE_URL = "http://<your PC's LAN IP>:4000/api/v1"
bun run dev:mobile    # resident app;  bun run dev:staff for the staff app
```

Scan the QR code shown in the terminal with Expo Go (Android) or the Camera app (iOS).

## iPhone

An installable iPhone build needs an Apple Developer account (paid) and EAS. Until then, use Expo
Go on iPhones.

## Not for production

These APKs are signed with a throwaway key and may allow plain HTTP. Production releases need:

- the store developer accounts;
- an EAS project with managed signing keys;
- an `https://` API address;
- the device journeys (Maestro) from the testing strategy.
