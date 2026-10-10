import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, initialize, toolText } from "../lib/mcp"
import {
  chooseLevel,
  createFetchingToken,
  createToken,
  expectLevel,
  openTokenAdvanced,
  setPrivateAddresses,
} from "../lib/ui"

// Web fetch through the gateway: a token the owner lets fetch gets the
// web_fetch tool and is told how; the first request to a site asks the
// owner and puts the site on the token's Advanced page. The fake upstream
// is on 127.0.0.1, which web_fetch refuses until the owner allows private
// addresses for the token, so every request stops at PCP's address check,
// and the page sees none, until the last test allows them. Method and site
// levels and All tokens are lib/core/web-fetch.test.ts's.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const TOKEN_NAME = `Web reader ${RUN}`

let upstream: Upstream
let site: string
let token: string
let tokenId: string

test.beforeAll(async () => {
  upstream = await startUpstream()
  site = new URL(upstream.pageUrl).host
})

test.afterAll(async () => {
  await upstream?.close()
})

test("a token made to fetch gets the tool and is told how; others get neither", async ({
  page,
  baseURL,
}) => {
  ;({ token, id: tokenId } = await createFetchingToken(page, TOKEN_NAME))
  await expect(
    page.getByRole("switch", { name: /^Read web pages/ }),
  ).toBeChecked()

  const { tools, instructions } = await initialize(baseURL!, token)
  expect(tools).toContain("web_fetch")
  expect(instructions).toContain("web_fetch")
  expect(instructions).toContain("public addresses only")

  const plain = await createToken(page, `No web ${RUN}`)
  await expect(
    page.getByRole("switch", { name: /^Read web pages/ }),
  ).not.toBeChecked()
  const without = await initialize(baseURL!, plain)
  expect(without.tools).not.toContain("web_fetch")
  expect(without.instructions).not.toContain("web_fetch")
})

test("the first request to a site asks the owner and lists the site", async ({
  page,
  baseURL,
}) => {
  const asked = await callTool(baseURL!, token, "web_fetch", {
    url: upstream.pageUrl,
  })
  expect(toolText(asked)).toContain("Not done yet")
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id).toBeTruthy()

  await openTokenAdvanced(page, tokenId)
  const row = page.getByRole("listitem", { name: site, exact: true })
  await expect(row.getByText("Added by an assistant")).toBeVisible()
  await expectLevel(page, `Web fetch ${site}`, "default")

  await page.goto(`/permissions/${id}`)
  await expect(page.getByText(`Fetch a page from ${site}?`)).toBeVisible()
  await expect(page.getByText(`Address: ${upstream.pageUrl}`)).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Always allow this site" }),
  ).toBeVisible()
  await page.getByRole("button", { name: "Allow once" }).click()

  // Allowed, it still reaches public addresses only.
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "which the owner has not allowed",
  )
  expect(upstream.pageHits).toEqual([])
})

test("allowing private addresses reaches the fake upstream's page, never PCP's own", async ({
  page,
  baseURL,
}) => {
  await openTokenAdvanced(page, tokenId)
  await chooseLevel(page, `Web fetch ${site}`, "allowed")

  // Allowed as a site, it is still on a private address.
  const stopped = await callTool(baseURL!, token, "web_fetch", {
    url: upstream.pageUrl,
  })
  expect(toolText(stopped)).toContain("which the owner has not allowed")
  expect(upstream.pageHits).toEqual([])

  const toggle = page.getByRole("switch", { name: /^Private addresses/ })
  await expect(toggle).not.toBeChecked()
  await setPrivateAddresses(page, true)
  await page.reload()
  await expect(toggle).toBeChecked()

  const read = await callTool(baseURL!, token, "web_fetch", {
    url: upstream.pageUrl,
  })
  expect(read.body.result?.isError).toBeUndefined()
  expect(toolText(read)).toContain("# Only for the owner's network")
  expect(upstream.pageHits).toEqual(["GET"])

  // PCP itself stays out of reach, allowed or not.
  const own = await callTool(baseURL!, token, "web_fetch", {
    url: `${baseURL}/api/health`,
  })
  expect(own.body.result?.isError).toBe(true)
  expect(toolText(own)).toContain("PCP's own address")

  await setPrivateAddresses(page, false)
  const refused = await callTool(baseURL!, token, "web_fetch", {
    url: upstream.pageUrl,
  })
  expect(toolText(refused)).toContain("which the owner has not allowed")
  expect(upstream.pageHits).toEqual(["GET"])
})
