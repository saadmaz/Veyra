import { defineConfig } from 'vitest/config';

// Integration tests against a real PostgreSQL started by global-setup.ts.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // One database for the whole run: keep files sequential so fixtures do not interleave.
    fileParallelism: false,
  },
});
