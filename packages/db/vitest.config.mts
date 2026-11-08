import { defineConfig } from 'vitest/config';

// Unit tests only. Database integration tests: vitest.integration.config.mts.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
  },
});
