import { defineConfig, devices } from "@playwright/test";

/**
 * Runs against a production build, not the dev server.
 *
 * Several of the things these tests check only exist after a build: hashed asset URLs,
 * the prerendered HTML that every island hydrates from, and the exact `base` prefix that
 * GitHub Pages serves under. Testing the dev server would pass while the deployed site
 * shipped 404s.
 *
 * Hence port 4322, not Astro's default 4321. With `reuseExistingServer` on, a dev server
 * left running on the default port gets adopted as if it were the build -- which is not
 * hypothetical: it happened, and the run failed with a dozen `504 Outdated Optimize Dep`
 * hydration errors that had nothing to do with the code under test. On its own port the
 * two cannot be confused, and `pixi run dev` can stay up while the suite runs.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: "http://localhost:4322",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run preview -- --port 4322",
    url: "http://localhost:4322/bcs-birdweb/",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
