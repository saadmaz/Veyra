import { baselineSecurityHeaders } from '@veyra/web-config';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@veyra/domain', '@veyra/design-tokens', '@veyra/api-contracts'],
  async headers() {
    return baselineSecurityHeaders;
  },
};

export default nextConfig;
