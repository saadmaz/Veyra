import { baselineSecurityHeaders, type HeaderRule } from '@veyra/web-config';
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

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@veyra/domain', '@veyra/design-tokens', '@veyra/api-contracts'],
  async headers() {
    return [...baselineSecurityHeaders, ...gateCameraHeaders];
  },
};

export default nextConfig;
