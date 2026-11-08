import { baselineSecurityHeaders } from '@veyra/web-config';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@veyra/design-tokens'],
  async headers() {
    return baselineSecurityHeaders;
  },
};

export default nextConfig;
