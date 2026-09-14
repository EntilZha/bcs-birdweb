import { defineConfig, devices } from "@playwright/test";

/**
 * Runs against a production build, not the dev server.
 *
 * Several of the things these tests check only exist after a build: hashed asset URLs,
 * the prerendered HTML that every island hydrates from, and the exact `base` prefix that
 * GitHub Pages serves under. Testing the dev server would pass while the deployed site
 * shipped 404s.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: "http://localhost:4321",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:4321/bcs-birdweb/",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
