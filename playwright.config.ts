import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: the real app against the local Supabase stack (`supabase start`),
 * on emulated iPhone Safari (WebKit) and Android Chrome. Run with `npm run e2e`.
 * Screenshots for review land in e2e/screenshots (gitignored).
 */
const PORT = 5174;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${String(PORT)}/evenly/`,
    timezoneId: 'America/Toronto',
    locale: 'en-CA',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 15'] } },
    { name: 'android', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `npm run dev -- --port ${String(PORT)} --strictPort`,
    url: `http://localhost:${String(PORT)}/evenly/`,
    reuseExistingServer: !process.env.CI,
    env: { VITE_SUPABASE_URL: 'http://127.0.0.1:54321' },
  },
});
