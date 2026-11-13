// Expo config plugin (Phase 15 Part 4, ADR 0008): allows plain-HTTP requests on Android only when
// the app is built against an http:// API address (a developer machine on the LAN, or the
// emulator's 10.0.2.2). Builds against an https:// address keep Android's default, which refuses
// plain HTTP.
const { withAndroidManifest } = require('expo/config-plugins');

function withCleartextForHttpApi(config) {
  const api = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  if (!api.startsWith('http://')) return config;
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (application) application.$['android:usesCleartextTraffic'] = 'true';
    return mod;
  });
}

module.exports = withCleartextForHttpApi;
