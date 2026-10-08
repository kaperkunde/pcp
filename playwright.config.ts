import path from "node:path"

import { defineConfig, devices } from "@playwright/test"

import {
  E2E_EDGE_HTTP_PORT,
  E2E_EDGE_HTTPS_PORT,
  E2E_PCPGG_RELAY_URL,
  E2E_RELEASES_URL,
} from "./e2e/lib/network"

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
      // Host settings (HTTPS, pcp.gg, the update check) are covered by unit
      // tests, not by a project. If a spec ever reaches them, they stay on
      // this machine: listeners on high ports, a Let's Encrypt where nothing
      // answers, no public address lookup, no GitHub, no pcp.gg.
      PCP_HTTP_PORT: String(E2E_EDGE_HTTP_PORT),
      PCP_HTTPS_PORT: String(E2E_EDGE_HTTPS_PORT),
      PCP_ACME_DIRECTORY: "http://127.0.0.1:9/directory",
      PCP_PUBLIC_IP_URL: "http://127.0.0.1:9/ip",
      // The update check asks a port nothing answers on, never GitHub.
      PCP_RELEASES_URL: E2E_RELEASES_URL,
      PCP_PCPGG_RELAY_URL: E2E_PCPGG_RELAY_URL,
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
      // The Servers page's Add menu, and an OAuth upstream added from it:
      // connected through the browser, used, then disconnected.
      name: "oauth",
      testMatch: /(^|\/)oauth\.spec\.ts$/,
      dependencies: ["setup"],
      use: signedIn("oauth"),
    },
    {
      // PCP's own authorization server: an assistant finds it from /mcp's
      // 401, registers itself, the owner signs in and allows it, and the
      // token it gets works, rotates, and is revoked under API tokens.
      name: "oauth-server",
      testMatch: /oauth-server\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("oauth-server"),
    },
    {
      // An API that signs in with OAuth: proposed by an assistant with the
      // owner's client ID, the client secret typed in on the approval page,
      // connected, and called with the token, which the assistant never
      // sees.
      name: "endpoint-oauth",
      testMatch: /endpoint-oauth\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("endpoint-oauth"),
    },
    {
      // An OAuth upstream that lets no app register itself: its redirect URI
      // on the add form, and the owner's own client connecting it.
      name: "oauth-client",
      testMatch: /oauth-client\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("oauth-client"),
    },
    {
      // An API described by an OpenAPI schema: added from a URL with a
      // secret, its operations found and called through the gateway; one an
      // assistant proposes, and what it may change once the owner's.
      name: "endpoints",
      testMatch: /endpoints\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("endpoints"),
    },
    {
      // A mail account: JMAP with an app password, its tools called through
      // the gateway, a read-only one that cannot send, and one an assistant
      // proposes, whose password the owner types in on PCP's page.
      name: "mail",
      testMatch: /mail\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("mail"),
    },
    {
      // An SSH server: added in PCP, PCP's key put in authorized_keys, the
      // host key pinned; a command an assistant asks for, shown to the owner
      // first; and a server that later shows another host key.
      name: "ssh",
      testMatch: /ssh\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("ssh"),
    },
    {
      // Per-token tool access and the owner's permission: the link (also for
      // a client that offers prompts and panels), Block, copying access,
      // tool levels and servers an assistant proposes.
      name: "permissions",
      testMatch: /permissions\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("permissions"),
    },
    {
      // A token that keeps memories: sharing one through the owner's
      // permission, and what is read in every conversation.
      name: "memories",
      testMatch: /memories\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("memories"),
    },
    {
      // APIs an assistant proposes with more than a bearer token: HTTP Basic
      // with the password typed in on the approval page, and a key and a
      // secret key in two headers; each sent by PCP, and kept from the
      // assistant.
      name: "endpoint-credentials",
      testMatch: /endpoint-credentials\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("endpoint-credentials"),
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
      // A token that runs code: the tool and its instructions, a program
      // calling tools with the server's secret, a picture moved by its
      // handle, a blocked tool caught, and an "ask" tool stopping the
      // program until the owner allows it.
      name: "run-code",
      testMatch: /run-code\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("run-code"),
    },
    {
      // Wrappers: a token that may propose them gets their tools; a wrapper
      // over a tool that wants its key as an argument, approved with the key
      // typed in on the request's page; its tool puts the key in and the
      // answer shows it redacted; the tool it replaces leaves search.
      name: "wrappers",
      testMatch: /wrappers\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("wrappers"),
    },
    {
      // The browser: added by the owner, its tools and instructions, a new
      // site asking first, refs to act on a page, a link to another site
      // stopped, and the sign-ins kept across a restart and forgotten.
      name: "browser",
      testMatch: /browser\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("browser"),
    },
    {
      // The Log page: a token's calls by tool and outcome, never what they
      // sent.
      name: "log",
      testMatch: /log\.spec\.ts/,
      dependencies: ["setup"],
      use: signedIn("log"),
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
    {
      // Deletes the vault from Settings and sets it up again with the same
      // name and password, which ends every session and token: after
      // backup, signing in on its own.
      name: "reset",
      testMatch: /reset\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
