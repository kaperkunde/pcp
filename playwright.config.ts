import path from "node:path"

import { defineConfig, devices } from "@playwright/test"

import { E2E_EDGE_HTTP_PORT, E2E_EDGE_HTTPS_PORT } from "./e2e/lib/network"

const baseURL = process.env.PCP_URL ?? "http://localhost:3000"

// The app under test keeps its database here, apart from a developer's own
// ./data. `pnpm test:e2e` wipes it first (e2e/scripts/reset.mjs); a bare
// `playwright test` keeps it, and every project copes with a dirty state.
export const E2E_DATA_DIR = path.join(__dirname, "e2e", ".state", "data")

/**
 * Each spec is its own project. `setup` creates the owner and signs each of
 * the others in with a session of its own, so `--project=gateway` runs
 * `setup` first by itself. See e2e/README.md.
 */
/**
 * A project that starts signed in, with the session `setup` signed in for it
 * alone: typing the password again (to make a token) is limited per session,
 * and the whole suite in one session runs out.
 */
function signedIn(project: string) {
  return {
    ...devices["Desktop Chrome"],
    storageState: `e2e/.auth/${project}.json`,
  }
}

export default defineConfig({
  testDir: "./e2e/tests",
  outputDir: "./e2e/.artifacts/test-results",
  globalSetup: "./e2e/global-setup.ts",
  // Projects share one database and one owner; run them in order.
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
    env: {
      PCP_DATA_DIR: E2E_DATA_DIR,
      // The network project turns HTTPS on: its listeners on high ports, a
      // Let's Encrypt where nothing answers, and no public address lookup
      // leaving the machine.
      PCP_HTTP_PORT: String(E2E_EDGE_HTTP_PORT),
      PCP_HTTPS_PORT: String(E2E_EDGE_HTTPS_PORT),
      PCP_ACME_DIRECTORY: "http://127.0.0.1:9/directory",
      PCP_PUBLIC_IP_URL: "http://127.0.0.1:9/ip",
    },
  },
  projects: [
    {
      // First visit: setup, the recovery key, lock and unlock. Writes
      // e2e/.state/setup.json, and e2e/.auth/<project>.json for each project
      // that starts signed in.
      name: "setup",
      testMatch: /setup\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "secrets",
      testMatch: /secrets\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("secrets"),
    },
    {
      // A header-authenticated upstream, an API token, and the gateway's
      // three tools over plain HTTP.
      name: "gateway",
      testMatch: /gateway\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("gateway"),
    },
    {
      // Connecting an OAuth upstream through the browser, then using it.
      name: "oauth",
      testMatch: /oauth\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("oauth"),
    },
    {
      // An API that signs in with OAuth: proposed by an assistant with the
      // owner's client ID, the client secret typed in on the approval page,
      // connected, and called with the token.
      name: "endpoint-oauth",
      testMatch: /endpoint-oauth\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("endpoint-oauth"),
    },
    {
      // An OAuth upstream that lets no app register itself: the owner's own
      // client, its redirect URI, and extra sign-in parameters.
      name: "oauth-client",
      testMatch: /oauth-client\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("oauth-client"),
    },
    {
      // An API described by an OpenAPI schema: added from a URL and from a
      // file, its operations found and called through the gateway.
      name: "endpoints",
      testMatch: /endpoints\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("endpoints"),
    },
    {
      // A mail account: JMAP with an app password and with OAuth, read-only,
      // a refused password, an unreachable IMAP server; its tools called
      // through the gateway.
      name: "mail",
      testMatch: /mail\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("mail"),
    },
    {
      // Per-token tool access and the owner's permission: the link, the
      // client's own prompt, PCP's panel, copying access, and servers an
      // assistant proposes.
      name: "permissions",
      testMatch: /permissions\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("permissions"),
    },
    {
      // A token that keeps memories: its own notes, sharing one through the
      // owner's permission, and the Memories tab.
      name: "memories",
      testMatch: /memories\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("memories"),
    },
    {
      // Dynamic DNS through the fake upstream's update URL, a refused login
      // stopping it; HTTPS turned on, port 80 open, the failure explained;
      // both turned off.
      name: "network",
      testMatch: /network\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("network"),
    },
    {
      // An API whose credential is a key and a secret key in two headers:
      // added by the owner, called through /mcp, proposed by an assistant.
      name: "secret-headers",
      testMatch: /secret-headers\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("secret-headers"),
    },
    {
      // A token that fetches web pages: the tool and its instructions, a new
      // site asking first and listed on the token's page, method and site
      // levels, All tokens, and public addresses only.
      name: "web-fetch",
      testMatch: /web-fetch\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("web-fetch"),
    },
    {
      // Touch ID with a stand-in for the Mac app. Signs every browser out,
      // so it comes after the projects that start signed in, and signs in
      // on its own.
      name: "touch-id",
      testMatch: /touch-id\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Signs every browser out, so it comes last and signs in on its own.
      name: "recovery",
      testMatch: /recovery\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Exports the vault to a file and restores it, which signs every
      // browser out too: after recovery, signing in on its own.
      name: "backup",
      testMatch: /backup\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
