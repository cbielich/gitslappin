import { defineConfig } from 'vitest/config';

// Run with: npm run test:docker (the root vitest.config.ts does not collect tests/docker).
export default defineConfig({
  test: {
    include: ['tests/docker/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 120_000,
    hookTimeout: 900_000, // first image build
    fileParallelism: false,
  },
});
