export interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/**
 * Baseline security headers applied to every route of every VEYRA web app.
 * Content-Security-Policy is added per app once each app's script/style sources are known.
 */
export const baselineSecurityHeaders: HeaderRule[] = [
  {
    source: '/:path*',
    headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
    ],
  },
];

/** Internal tools must never be indexed by search engines. */
export const noIndexHeaders: HeaderRule[] = [
  { source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
];
