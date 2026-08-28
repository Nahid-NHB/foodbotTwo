import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { baseURL: "http://localhost:3001" },
  // The dev environment (postgres + redis + api + web) is expected to be
  // running already; this config does not manage webServers because CI
  // starts them externally. Run with:
  //   cd web && pnpm exec playwright install --with-deps chromium
  // before executing `pnpm exec playwright test`.
});
