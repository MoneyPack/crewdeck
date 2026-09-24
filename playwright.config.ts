import { defineConfig } from '@playwright/test';

// Electron smoke test only: run `npm run build` first (test:e2e does it).
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: 'list',
});
