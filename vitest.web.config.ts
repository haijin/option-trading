import { defineConfig } from 'vitest/config';

/** Web UI tests: pure helpers and components, jsdom, no database and no network. */
export default defineConfig({
  test: {
    include: ['web/src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['web/src/test-setup.ts'],
    testTimeout: 15_000,
    pool: 'forks',
  },
});
