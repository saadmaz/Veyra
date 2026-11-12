import { baselineSecurityHeaders, cspHeaders, noIndexHeaders, originOf } from '@veyra/web-config';
import type { NextConfig } from 'next';

const API_ORIGIN = originOf(process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@veyra/design-tokens', '@veyra/api-contracts'],
  async headers() {
    return [
      ...baselineSecurityHeaders,
      ...noIndexHeaders,
      ...cspHeaders({
        connect: API_ORIGIN ? [API_ORIGIN] : [],
        development: process.env.NODE_ENV === 'development',
      }),
    ];
  },
};

export default nextConfig;
