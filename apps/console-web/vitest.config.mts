import { defineConfig } from 'vitest/config';

// Unit tests only. Browser journeys are Playwright tests in e2e/ (bun run test:e2e).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
