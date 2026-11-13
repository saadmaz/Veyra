/**
 * Runtime configuration. Expo inlines EXPO_PUBLIC_* variables at build time, so never put
 * secrets here: anything in the app bundle is readable by users.
 */
export function apiBaseUrl(): string {
  const url = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!url) {
    throw new Error('EXPO_PUBLIC_API_BASE_URL is not set (see apps/resident-mobile/README.md)');
  }
  return url.replace(/\/+$/, '');
}
