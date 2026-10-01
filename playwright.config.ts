import path from "node:path"

import { defineConfig, devices } from "@playwright/test"

const baseURL = process.env.PCP_URL ?? "http://localhost:3000"

// The app under test keeps its database here, apart from a developer's own
// ./data. `pnpm test:e2e` wipes it first (e2e/scripts/reset.mjs); a bare
// `playwright test` keeps it, and every project copes with a dirty state.
export const E2E_DATA_DIR = path.join(__dirname, "e2e", ".state", "data")

/**
 * Each spec is its own project. `setup` creates the owner and writes the
 * signed-in storage state the others reuse, so `--project=gateway` runs
 * `setup` first by itself. See e2e/README.md.
 */
export default defineConfig({
  testDir: "./e2e/tests",
  outputDir: "./e2e/.artifacts/test-results",
  globalSetup: "./e2e/global-setup.ts",
  // Projects share one database and one signed-in owner; run them in order.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: "./e2e/.artifacts/report", open: "never" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // A machine with a Chromium of its own (a sandbox without network, say)
    // can point at it instead of the revision Playwright would download.
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? {
          launchOptions: {
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
          },
        }
      : {}),
  },
  webServer: {
    command: "pnpm dev",
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { PCP_DATA_DIR: E2E_DATA_DIR },
  },
  projects: [
    {
      // First visit: setup, the recovery key, lock and unlock. Writes
      // e2e/.auth/owner.json and e2e/.state/setup.json.
      name: "setup",
      testMatch: /setup\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "secrets",
      testMatch: /secrets\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/owner.json",
      },
    },
    {
      // A header-authenticated upstream, an API token, and the gateway's
      // three tools over plain HTTP.
      name: "gateway",
      testMatch: /gateway\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/owner.json",
      },
    },
    {
      // Connecting an OAuth upstream through the browser, then using it.
      name: "oauth",
      testMatch: /oauth\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/owner.json",
      },
    },
    {
      // An API described by an OpenAPI schema: added from a URL and from a
      // file, its operations found and called through the gateway.
      name: "endpoints",
      testMatch: /endpoints\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/owner.json",
      },
    },
    {
      // Signs every browser out, so it comes last and signs in on its own.
      name: "recovery",
      testMatch: /recovery\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
