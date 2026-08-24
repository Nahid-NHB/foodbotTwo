import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/db/migrate.ts', 'src/db/seed.ts'],
    },
    testTimeout: 20_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});