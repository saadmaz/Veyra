import { baselineSecurityHeaders, noIndexHeaders } from '@veyra/web-config';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@veyra/design-tokens', '@veyra/api-contracts'],
  async headers() {
    return [...baselineSecurityHeaders, ...noIndexHeaders];
  },
};

export default nextConfig;
