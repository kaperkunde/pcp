import { expect, test, type Page } from "@playwright/test"

import { OWNER_PASSWORD, unlock } from "../lib/auth"

// Touch ID, as the Mac app offers it to PCP's pages (window.pcpDesktop,
// desktop/preload.cjs). The suite runs in Chromium, so a stand-in plays the
// app: it keeps the key in the page's localStorage instead of the keychain,
// and every "Touch ID" it is asked for succeeds and is counted. What is
// tested is PCP's side: turning Touch ID on takes the password, it unlocks
// and confirms a new token (and an app's sign-in) without typing, a key PCP
// no longer knows is forgotten and the password still works, and signing out
// everywhere turns it off. Signs every browser out, so it runs after the
// projects that start signed in, and signs in on its own.
test.describe.configure({ mode: "serial" })

// Signing in is limited per address: one of its own, as backup.spec.ts.
test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.202" } })

const RUN = Date.now().toString(36)
const STORE = "e2e-touch-id-key"
const PROMPTS = "e2e-touch-id-prompts"
const REJECTED = "Touch ID is no longer set up for PCP. Use your password."

// The stand-in's keychain, carried from one test (one browser context) to
// the next, as the app's survives a restart.
let kept: string | null = null

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ store, prompts, seed }) => {
      try {
        if (!sessionStorage.getItem("e2e-touch-id-seeded")) {
          sessionStorage.setItem("e2e-touch-id-seeded", "1")
          if (seed) localStorage.setItem(store, seed)
          else localStorage.removeItem(store)
        }
      } catch {
        // about:blank, before the first page: no storage, no app.
        return
      }

      const count = () => Number(localStorage.getItem(prompts) ?? "0")
      window.pcpDesktop = {
        touchId: {
          status: async () => ({
            available: true,
            saved: localStorage.getItem(store) !== null,
          }),
          unlock: async () => {
            localStorage.setItem(prompts, String(count() + 1))
            return localStorage.getItem(store)
          },
          save: async (key: string) => {
            localStorage.setItem(prompts, String(count() + 1))
            localStorage.setItem(store, key)
            return true
          },
          forget: async () => {
            localStorage.removeItem(store)
          },
        },
      }
    },
    { store: STORE, prompts: PROMPTS, seed: kept },
  )
})

test.afterEach(async ({ page }) => {
  kept = await savedKey(page).catch(() => kept)
})

function card(page: Page, title: string) {
  return page.locator("[data-slot=card]").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  })
}

function savedKey(page: Page) {
  return page.evaluate((store) => localStorage.getItem(store), STORE)
}

function prompts(page: Page) {
  return page.evaluate(
    (key) => Number(localStorage.getItem(key) ?? "0"),
    PROMPTS,
  )
}

/** With a key kept, the sign-in page asks for Touch ID as it opens. */
async function unlockWithTouchId(page: Page) {
  await page.goto("/login")
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Servers" }),
  ).toBeVisible({
    timeout: 30_000,
  })
}

/** Locks; with a key kept, the sign-in page may unlock again at once. */
async function lock(page: Page) {
  await page.getByRole("button", { name: "Lock" }).click()
  await page.waitForURL(/\/login/)
}

test("turns Touch ID on in Settings, which takes the password", async ({
  page,
}) => {
  await unlock(page)
  await page.goto("/settings")
  const touchId = card(page, "Touch ID")

  // A run that stopped halfway left it on: start from off.
  const off = touchId.getByRole("button", { name: "Turn off Touch ID" })
  if (await off.isVisible()) {
    await off.click()
  }

  await touchId.getByLabel("Your password").fill("not the password")
  await touchId.getByRole("button", { name: "Turn on Touch ID" }).click()
  await expect(touchId.locator("p[role=alert]")).toHaveText(/not right/)
  expect(await savedKey(page)).toBeNull()

  await touchId.getByLabel("Your password").fill(OWNER_PASSWORD)
  await touchId.getByRole("button", { name: "Turn on Touch ID" }).click()
  await expect(touchId.getByText("On in this app.")).toBeVisible()
  expect(await savedKey(page)).toMatch(/^pcp_device_[A-Za-z0-9_-]{43}$/)
})

test("unlocks with Touch ID as the page opens, and confirms a token with it", async ({
  page,
}) => {
  await unlockWithTouchId(page)
  const before = await prompts(page)
  await lock(page)

  // Asked for once, at once; no password typed.
  await page.waitForURL(/\/servers/, { timeout: 30_000 })
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Servers" }),
  ).toBeVisible()
  expect(await prompts(page)).toBe(before + 1)

  // The token's password step is answered by Touch ID as it appears.
  const name = `Touch ID ${RUN}`
  const asked = await prompts(page)
  await page.goto("/tokens")
  await page.getByLabel("Name").fill(name)
  await page.getByRole("button", { name: "Create token" }).click()
  await expect(page).toHaveURL(/\/tokens\/[0-9a-f-]+$/)
  await expect(page.getByRole("heading", { name })).toBeVisible()
  await expect(page.getByTestId("new-token")).toHaveText(/^pcp_/)
  expect(await prompts(page)).toBe(asked + 1)
})

test("unlocks on the way to an app's sign-in, and confirms it with Touch ID", async ({
  page,
  baseURL,
}) => {
  const redirect = "http://127.0.0.1:9/callback"
  const name = `Touch ID app ${RUN}`
  const registered = await fetch(`${baseURL}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
    }),
  })
  const { client_id } = await registered.json()
  const callback = new Promise<URLSearchParams>((resolve) => {
    void page.route("http://127.0.0.1:9/**", async (route) => {
      resolve(new URL(route.request().url()).searchParams)
      await route.fulfill({ contentType: "text/plain", body: "Back" })
    })
  })

  // Locked: the sign-in page asks for Touch ID and goes on to the app's.
  await page.goto(
    `/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: redirect,
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: RUN,
    })}`,
  )
  await expect(
    page.getByRole("heading", { name: `Connect ${name}?` }),
  ).toBeVisible({
    timeout: 30_000,
  })

  // The password step is answered by Touch ID as it appears.
  await page.getByRole("button", { name: "Allow" }).click()
  const answer = await callback
  expect(answer.get("state")).toBe(RUN)
  expect(answer.get("code")).toMatch(/^pcp_code_/)
})

test("forgets a key PCP no longer knows, and the password still works", async ({
  page,
}) => {
  await unlockWithTouchId(page)
  // What the app would hold after PCP replaced or removed its key.
  await page.evaluate(
    (store) => localStorage.setItem(store, `pcp_device_${"A".repeat(43)}`),
    STORE,
  )
  await lock(page)

  await expect(page.getByText(REJECTED)).toBeVisible()
  await expect.poll(() => savedKey(page)).toBeNull()
  await expect(
    page.getByRole("button", { name: "Unlock with Touch ID" }),
  ).toHaveCount(0)

  await unlock(page)

  // PCP still has a key; this app no longer does: Settings says so, and
  // turning it off there takes no password.
  await page.goto("/settings")
  const touchId = card(page, "Touch ID")
  await expect(touchId.getByText(/no longer holds its key/)).toBeVisible()
  await touchId.getByRole("button", { name: "Turn off Touch ID" }).click()
  await expect(
    touchId.getByRole("button", { name: "Turn on Touch ID" }),
  ).toBeVisible()
})

test("turns on at sign-in, and signing out everywhere turns it off", async ({
  page,
}) => {
  // Off, but available: the sign-in page offers it with the password.
  expect(kept).toBeNull()
  await page.goto("/login")
  await page.getByLabel("Password").fill(OWNER_PASSWORD)
  await page.getByLabel("Unlock with Touch ID from now on").check()
  await page.getByRole("button", { name: "Unlock", exact: true }).click()
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Servers" }),
  ).toBeVisible({
    timeout: 30_000,
  })
  expect(await savedKey(page)).toMatch(/^pcp_device_/)

  // Turned off in Settings, the app forgets its key too; the sign-in page
  // offers it again.
  await page.goto("/settings")
  await card(page, "Touch ID")
    .getByRole("button", { name: "Turn off Touch ID" })
    .click()
  await expect(
    card(page, "Touch ID").getByRole("button", { name: "Turn on Touch ID" }),
  ).toBeVisible()
  await expect.poll(() => savedKey(page)).toBeNull()

  await lock(page)
  await page.getByLabel("Password").fill(OWNER_PASSWORD)
  await page.getByLabel("Unlock with Touch ID from now on").check()
  await page.getByRole("button", { name: "Unlock", exact: true }).click()
  await expect(
    page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Servers" }),
  ).toBeVisible({
    timeout: 30_000,
  })
  expect(await savedKey(page)).toMatch(/^pcp_device_/)

  // Signing out everywhere takes Touch ID with it: the app's key is refused
  // on the next unlock, and forgotten.
  await page.goto("/settings")
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Sign out everywhere" }).click()
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByText(REJECTED)).toBeVisible()
  await expect.poll(() => savedKey(page)).toBeNull()
  // And the sign-in page offers to turn it on again.
  await expect(
    page.getByLabel("Unlock with Touch ID from now on"),
  ).toBeVisible()
})
