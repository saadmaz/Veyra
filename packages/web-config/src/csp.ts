import type { HeaderRule } from './index';

export interface CspOptions {
  /** Origins the app calls with fetch: the API, object storage for signed uploads. */
  connect: string[];
  /** Extra image origins (signed download links shown inline). */
  images?: string[];
  /** Development needs eval for fast refresh; never in production builds. */
  development?: boolean;
}

/** An origin ("https://host:port") from a URL, or null when it is not a URL. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Content-Security-Policy (Phase 14 Part 3). Scripts and styles only from the app itself (Next.js
 * inlines its bootstrap, so 'unsafe-inline' stays for scripts until nonces are added); network
 * calls only to the named origins; no plugins, no framing, no foreign form targets.
 */
export function contentSecurityPolicy(options: CspOptions): string {
  const unique = (list: (string | null | undefined)[]) =>
    [...new Set(list.filter((x): x is string => Boolean(x)))].join(' ');
  const directives: [string, string][] = [
    ['default-src', "'self'"],
    [
      'script-src',
      unique(["'self'", "'unsafe-inline'", options.development ? "'unsafe-eval'" : null]),
    ],
    ['style-src', "'self' 'unsafe-inline'"],
    ['img-src', unique(["'self'", 'data:', 'blob:', ...(options.images ?? [])])],
    ['font-src', "'self' data:"],
    ['connect-src', unique(["'self'", ...options.connect])],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
    ['frame-ancestors', "'none'"],
  ];
  return directives.map(([name, value]) => `${name} ${value}`).join('; ');
}

export function cspHeaders(options: CspOptions): HeaderRule[] {
  return [
    {
      source: '/:path*',
      headers: [{ key: 'Content-Security-Policy', value: contentSecurityPolicy(options) }],
    },
  ];
}
