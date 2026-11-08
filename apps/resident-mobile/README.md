# VEYRA Resident (`@veyra/resident-mobile`)

iOS and Android app for owners, tenants and household members. React Native with Expo and
Expo Router (file-based routes in `app/`).

## Run

```powershell
# from the repo root, after bun install
$env:EXPO_PUBLIC_API_BASE_URL = "http://<your-PC-LAN-IP>:4000/api/v1"   # a phone cannot reach "localhost" on your PC
bun run --cwd apps/resident-mobile dev
```

Scan the QR code with Expo Go (Android) or the Camera app (iOS), or press `a` / `i` for an
emulator or simulator.

## Structure

```
app/            screens and navigation (Expo Router); one file per route
src/lib/        API client, configuration, non-UI logic (unit-tested with Vitest)
src/features/   feature modules (visitors, requests, bookings, bills) as they are built
test/           Vitest unit tests for src/lib
```

## Rules

- Styling uses `@veyra/design-tokens`; no raw colours or sizes.
- API types come from `@veyra/api-contracts`. No business rules in the app: the API decides.
- `EXPO_PUBLIC_*` values ship inside the app bundle. Never put secrets in them.
- Store tokens with `expo-secure-store`, never AsyncStorage.
- Store builds and submissions use EAS (`eas build`, `eas submit`) once the Apple and Google
  developer accounts exist.
