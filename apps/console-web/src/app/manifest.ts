import type { MetadataRoute } from 'next';

/**
 * Installable app (Operations PWA): security staff add the console to the home screen of the
 * gate phone. Offline use comes with Phase 5 Part 5; until then the app needs a connection.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'VEYRA Console',
    short_name: 'VEYRA',
    description: 'Property operations: residents, visitors and the gate.',
    start_url: '/organisations',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#0f2a3d',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
