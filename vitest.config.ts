import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'client/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/e2e/**'],
    // Real-git integration tests start many processes; the 5 s default is too short on Windows.
    testTimeout: 60_000,
  },
});
