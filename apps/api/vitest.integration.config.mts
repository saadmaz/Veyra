import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// API integration tests against a real, throwaway PostgreSQL (see test/integration/global-setup.ts).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
