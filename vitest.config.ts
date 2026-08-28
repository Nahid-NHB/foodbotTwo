import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Playwright e2e specs are run separately via `pnpm exec playwright test`
    // from web/ — exclude them from vitest discovery.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/db/migrate.ts', 'src/db/seed.ts'],
    },
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // Tests share a real Postgres + Redis. Run sequentially so a flushdb in
    // one file doesn't wipe another's data mid-test.
    fileParallelism: false,
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});