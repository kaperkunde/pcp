import { expect, type Page, test } from "@playwright/test"

import type {
  Authorization,
  Directory,
} from "../../lib/core/network/pcpgg/test-relay/directory"
import {
  createRelay,
  type Relay,
} from "../../lib/core/network/pcpgg/test-relay/relay"
import { E2E_PCPGG_RELAY_PORT } from "../lib/network"

// Connecting PCP to pcp.gg from Settings, against a copy of pcp.gg's relay
// (PCP_PCPGG_RELAY_URL in playwright.config.ts). Let's Encrypt is an address
// where nothing answers, so the certificate for the name is refused on the
// first try and PCP stops asking until the owner does.
test.describe.configure({ mode: "serial" })

const NAME = `e2e-${Date.now().toString(36)}.pcp.test`
const KEY = "pcpgg_e2e_0123456789abcdefghijklmnop"
const WRONG_KEY = "pcpgg_wrong_0123456789abcdefghijkl"

class FakeDirectory implements Directory {
  async authorize(token: string): Promise<Authorization | null> {
    return token === KEY
      ? { deviceId: "dev_e2e", hostnames: [NAME], generation: 1 }
      : null
  }

  async report() {
    return { disconnect: [] }
  }
}

let relay: Relay

test.beforeAll(async () => {
  relay = createRelay({ directory: new FakeDirectory() })
  await new Promise<void>((resolve) =>
    relay.tunnelServer.listen(E2E_PCPGG_RELAY_PORT, "127.0.0.1", resolve),
  )
  // The public ports are not needed here; the unit tests carry connections.
  relay.httpsServer.listen(0, "127.0.0.1")
  relay.httpServer.listen(0, "127.0.0.1")
})

test.afterAll(async () => {
  await relay.close()
})

function pcpggForm(page: Page) {
  return page.getByRole("form", { name: "pcp.gg" })
}

/** A run stopped halfway leaves PCP connected; the network project needs it off. */
async function disconnect(page: Page) {
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Disconnect from pcp.gg" }).click()
  await expect(
    page.getByRole("button", { name: "Connect to pcp.gg" }),
  ).toBeVisible()
}

async function connect(page: Page, key: string) {
  const form = pcpggForm(page)
  await form.getByLabel("Connection key").fill(key)
  await form
    .getByLabel("I accept the Let's Encrypt Subscriber Agreement")
    .check()
  await form
    .getByRole("button", { name: /Connect to pcp.gg|Save and connect/ })
    .click()
}

test("a key pcp.gg does not know is not tried again, and the bell says so", async ({
  page,
}) => {
  await page.goto("/settings")

  if (await page.getByTestId("pcpgg-status").count()) {
    await disconnect(page)
  }

  await connect(page, WRONG_KEY)

  const form = pcpggForm(page)
  await expect(form.getByRole("alert")).toContainText(
    "pcp.gg did not accept this connection key",
  )
  const status = page.getByTestId("pcpgg-status")
  await expect(status.getByText("Key not accepted")).toBeVisible()
  await expect(
    status.getByText("PCP will not try again until you save a key."),
  ).toBeVisible()
  // The key is never shown back, only its start.
  await expect(page.getByText(WRONG_KEY)).toHaveCount(0)
  await expect(page.getByText("Saved: pcpgg_wron…")).toBeVisible()

  await page.getByRole("button", { name: /waiting for you/ }).click()
  await expect(
    page.getByRole("menuitem", {
      name: /pcp.gg did not accept PCP's connection key/,
    }),
  ).toBeVisible()
  await page.keyboard.press("Escape")
})

test("a key pcp.gg takes brings PCP online at its name, and HTTPS for it", async ({
  page,
}) => {
  await page.goto("/settings")
  await connect(page, KEY)

  await expect(pcpggForm(page).getByRole("status")).toContainText(
    `PCP is online at ${NAME}`,
  )
  expect(relay.hostnames()).toEqual([NAME])
  const status = page.getByTestId("pcpgg-status")
  await expect(status.getByText("Online", { exact: true })).toBeVisible()
  await expect(status).toContainText(`Assistants reach PCP at ${NAME}`)

  // HTTPS is the pcp.gg card's to show while pcp.gg is on.
  await expect(page.getByTestId("https-pcpgg")).toContainText(NAME)
  await expect(page.getByRole("form", { name: "HTTPS" })).toHaveCount(0)

  // No Let's Encrypt answers here: the first try for the name fails, and the
  // card says why without blaming the router.
  const refused = page.getByTestId("pcpgg-https-turned-off")
  await expect(refused).toBeVisible({ timeout: 30_000 })
  await expect(refused.getByRole("alert")).toContainText(
    `Let's Encrypt did not issue a certificate for ${NAME}`,
  )
  await expect(refused.getByRole("alert")).not.toContainText("router")
  await expect(
    refused.getByRole("button", { name: "Try again now" }),
  ).toBeVisible()
})

test("disconnecting stops the connection and HTTPS for the name", async ({
  page,
}) => {
  await page.goto("/settings")
  await disconnect(page)

  await expect(page.getByTestId("pcpgg-status")).toHaveCount(0)
  await expect(page.getByRole("form", { name: "HTTPS" })).toBeVisible()
  // What Let's Encrypt said about the name went with it.
  await expect(page.getByTestId("https-turned-off")).toHaveCount(0)
  await expect.poll(() => relay.hostnames()).toEqual([])
})
