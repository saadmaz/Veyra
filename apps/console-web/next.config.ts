import { baselineSecurityHeaders, cspHeaders, type HeaderRule, originOf } from '@veyra/web-config';
import type { NextConfig } from 'next';

/**
 * The gate screen scans visitors' QR codes with the camera. Only that page may use it; every
 * other page keeps the baseline (camera off). A later matching rule overrides an earlier one.
 */
export const gateCameraHeaders: HeaderRule[] = [
  {
    source: '/organisations/:organisationId/properties/:propertyId/gate',
    headers: [{ key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' }],
  },
];

/** Where the console sends requests: the API, and object storage for signed uploads. */
const API_ORIGIN = originOf(process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1');
const STORAGE_ORIGIN = originOf(process.env.NEXT_PUBLIC_STORAGE_ORIGIN ?? 'http://localhost:8333');

export const consoleCspHeaders = cspHeaders({
  connect: [API_ORIGIN, STORAGE_ORIGIN].filter((o): o is string => o !== null),
  images: STORAGE_ORIGIN ? [STORAGE_ORIGIN] : [],
  development: process.env.NODE_ENV === 'development',
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@veyra/domain', '@veyra/design-tokens', '@veyra/api-contracts'],
  async headers() {
    return [...baselineSecurityHeaders, ...consoleCspHeaders, ...gateCameraHeaders];
  },
};

export default nextConfig;
