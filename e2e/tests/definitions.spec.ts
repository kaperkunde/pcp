import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { initialize } from "../lib/mcp"
import { acceptNextDialog, clickHydrated, createToken } from "../lib/ui"

// Definitions and instances on an endpoint's page: the About card says what
// it is and which definition, the owner writes a private note in place,
// clones it with an address of its own, and an assistant reads the note as
// the owner's. Detach gives the clone a definition of its own again.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const NAME = `Pets ${RUN}`
const SLUG = `pets-${RUN}`
const CLONE = `Pets copy ${RUN}`
const CLONE_SLUG = `pets-copy-${RUN}`
const NOTE = `the shop's own pets, ${RUN}`

let upstream: Upstream
let sourceId: string
let cloneId: string

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

test("an endpoint's About card says what it is, and takes a private note", async ({
  page,
}) => {
  await page.goto("/servers/endpoints/new")
  await page.getByLabel("Schema URL").fill(upstream.openapiUrl)
  await page.getByLabel("Name", { exact: true }).fill(NAME)
  await page.getByLabel("Description").fill("Pets for sale.")
  await page.getByRole("button", { name: "Add endpoint" }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  sourceId = page.url().split("/").pop()!

  await expect(
    page.getByText(`API endpoint · definition ${SLUG}`),
  ).toBeVisible()
  await expect(page.getByText("Local only")).toBeVisible()
  await expect(page.getByText("Private", { exact: true })).toBeVisible()

  await clickHydrated(page.getByRole("button", { name: "Edit note" }))
  await page.getByLabel("Your note").fill(NOTE)
  await page.getByRole("button", { name: "Save note" }).click()
  await expect(page.getByText(NOTE)).toBeVisible()
  await expect(
    page.getByText("Private: never synced or shared.", { exact: false }),
  ).toBeVisible()
})

test("a clone shares the definition, with its own address and note", async ({
  page,
}) => {
  await page.goto(`/servers/${sourceId}`)
  await page.getByRole("link", { name: "Clone" }).click()
  await expect(
    page.getByRole("heading", { name: `Clone ${NAME}` }),
  ).toBeVisible()

  await page.getByLabel("Name", { exact: true }).fill(CLONE)
  await page.getByLabel("Base URL").fill(`${upstream.origin}/api`)
  await page.getByLabel("Your note (optional)").fill("a second shop")
  await page.getByRole("button", { name: "Clone", exact: true }).click()

  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  cloneId = page.url().split("/").pop()!
  expect(cloneId).not.toBe(sourceId)
  await expect(page.getByRole("heading", { name: CLONE })).toBeVisible()
  await expect(
    page.getByText(`API endpoint · definition ${SLUG}`),
  ).toBeVisible()
  await expect(page.getByText(/^Used by/)).toContainText(
    `${SLUG}, ${CLONE_SLUG}`,
  )
  await expect(page.getByText("a second shop")).toBeVisible()
})

test("an assistant reads each server's note as the owner's", async ({
  page,
  baseURL,
}) => {
  const token = await createToken(page, `Definitions reader ${RUN}`)
  const { instructions } = await initialize(baseURL!, token)

  expect(instructions).toContain(`- ${SLUG}: Pets for sale.`)
  expect(instructions).toContain(`Owner's note: ${NOTE}`)
  expect(instructions).toContain(`- ${CLONE_SLUG}: Pets for sale.`)
  expect(instructions).toContain("Owner's note: a second shop")
})

test("Detach gives the clone a definition of its own", async ({ page }) => {
  await page.goto(`/servers/${cloneId}`)
  acceptNextDialog(page)
  await clickHydrated(page.getByRole("button", { name: "Detach" }))
  await expect(page.getByText(/^Detached:/)).toBeVisible()
  await page.reload()
  await expect(
    page.getByText(`API endpoint · definition ${CLONE_SLUG}`),
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Detach" })).toHaveCount(0)
})
