import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { callTool, initialize, toolText } from "../lib/mcp"
import { createFetchingToken, createToken } from "../lib/ui"

// Web fetch through the gateway: a token the owner lets fetch gets the
// web_fetch tool and is told how; the first request to a site asks the
// owner and puts the site on the token's page; the owner decides per method
// and per site, for one token or for all of them. The fake upstream is on
// 127.0.0.1, which web_fetch refuses until the owner allows private
// addresses for the token, so every request stops at PCP's address check,
// and the page sees none, until the last test allows them.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const TOKEN_NAME = `Web reader ${RUN}`
const SECOND_TOKEN_NAME = `Second web reader ${RUN}`

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

/** Picks a level in a select on the token page and waits for it to save. */
async function choose(
  page: import("@playwright/test").Page,
  label: string,
  value: string,
) {
  const select = page.getByLabel(label, { exact: true })
  await select.selectOption(value)
  await expect(select).toBeEnabled()
  await page.reload()
  await expect(page.getByLabel(label, { exact: true })).toHaveValue(value)
}

test("a token made to fetch gets the tool and is told how; others get neither", async ({
  page,
  baseURL,
}) => {
  ;({ token, id: tokenId } = await createFetchingToken(page, TOKEN_NAME))

  const { tools, instructions } = await initialize(baseURL!, token)
  expect(tools).toContain("web_fetch")
  expect(instructions).toContain("web_fetch")
  expect(instructions).toContain("public addresses only")

  await expect(page.getByRole("heading", { name: "Web fetch" })).toBeVisible()
  await expect(page.getByLabel("Web fetch GET", { exact: true })).toHaveValue(
    "ask",
  )

  await page.goto("/tokens")
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: TOKEN_NAME })
      .getByText("Fetches the web"),
  ).toBeVisible()

  const plain = await createToken(page, `No web ${RUN}`)
  const without = await initialize(baseURL!, plain)
  expect(without.tools).not.toContain("web_fetch")
  expect(without.instructions).not.toContain("web_fetch")
  await expect(page.getByRole("heading", { name: "Web fetch" })).toHaveCount(0)
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

  await page.goto(`/tokens/${tokenId}`)
  const row = page.getByRole("listitem", { name: site, exact: true })
  await expect(row.getByText("Added by an assistant")).toBeVisible()
  await expect(
    page.getByLabel(`Web fetch ${site}`, { exact: true }),
  ).toHaveValue("default")

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

test("a blocked method refuses at once, and a site's own level decides every method", async ({
  page,
  baseURL,
}) => {
  await page.goto(`/tokens/${tokenId}`)
  await choose(page, "Web fetch POST", "blocked")

  const refused = await callTool(baseURL!, token, "web_fetch", {
    url: upstream.pageUrl,
    method: "POST",
    body: '{"pet":"Rex"}',
  })
  expect(refused.body.result?.isError).toBe(true)
  expect(toolText(refused)).toContain("blocked POST requests")

  // Allowing the site runs any method there without asking.
  await choose(page, `Web fetch ${site}`, "allowed")
  const ran = await callTool(baseURL!, token, "web_fetch", {
    url: upstream.pageUrl,
    method: "POST",
    body: '{"pet":"Rex"}',
  })
  expect(toolText(ran)).not.toContain("Not done yet")
  expect(toolText(ran)).toContain("which the owner has not allowed")
  expect(upstream.pageHits).toEqual([])
})

test("All tokens on a site's line reaches another token, until a line of its own hides it", async ({
  page,
  baseURL,
}) => {
  const allTokens = () =>
    page.getByLabel(`All tokens for ${site}`, { exact: true })

  await page.goto(`/tokens/${tokenId}`)
  await allTokens().check()
  await expect(allTokens()).toBeEnabled()

  const second = await createFetchingToken(page, SECOND_TOKEN_NAME)
  await page.reload()
  await expect(allTokens()).toBeChecked()
  await expect(
    page.getByLabel(`Web fetch ${site}`, { exact: true }),
  ).toHaveValue("allowed")
  const direct = await callTool(baseURL!, second.token, "web_fetch", {
    url: upstream.pageUrl,
  })
  expect(toolText(direct)).toContain("which the owner has not allowed")

  // Its own line wins: blocked for this token, still allowed for the first.
  await choose(page, `Web fetch ${site}`, "blocked")
  await expect(allTokens()).not.toBeChecked()
  await expect(page.getByText("(all tokens: Allowed)")).toBeVisible()
  const blocked = await callTool(baseURL!, second.token, "web_fetch", {
    url: upstream.pageUrl,
  })
  expect(toolText(blocked)).toContain(`blocked ${site} for this token`)

  // Unticked on the first token, the line is its own again.
  await page.goto(`/tokens/${tokenId}`)
  await allTokens().uncheck()
  await expect(allTokens()).toBeEnabled()
  await page.reload()
  await expect(allTokens()).not.toBeChecked()
  await expect(
    page.getByLabel(`Web fetch ${site}`, { exact: true }),
  ).toHaveValue("allowed")
  expect(upstream.pageHits).toEqual([])
})

test("the owner adds a site before any assistant asks, and removes it", async ({
  page,
  baseURL,
}) => {
  const host = `blocked-${RUN}.example.com`

  await page.goto(`/tokens/${tokenId}`)
  await page.getByLabel("Add a site").fill(`https://${host}/news`)
  await page.getByLabel("Level", { exact: true }).selectOption("blocked")
  await page.getByRole("button", { name: "Add site" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: `Saved ${host}.` }),
  ).toBeVisible()

  const row = page.getByRole("listitem", { name: host, exact: true })
  await expect(row.getByText("Added by you")).toBeVisible()
  await expect(
    page.getByLabel(`Web fetch ${host}`, { exact: true }),
  ).toHaveValue("blocked")

  const refused = await callTool(baseURL!, token, "web_fetch", {
    url: `https://${host}/news`,
  })
  expect(toolText(refused)).toContain(`blocked ${host} for this token`)

  await page.getByRole("button", { name: `Remove ${host}` }).click()
  await expect(row).toHaveCount(0)
})

test("allowing private addresses reaches the fake upstream's page, never PCP's own", async ({
  page,
  baseURL,
}) => {
  await page.goto(`/tokens/${tokenId}`)
  await expect(
    page.getByLabel("Web fetch private addresses", { exact: true }),
  ).toHaveValue("blocked")
  await choose(page, "Web fetch private addresses", "allowed")

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

  await choose(page, "Web fetch private addresses", "blocked")
  const refused = await callTool(baseURL!, token, "web_fetch", {
    url: upstream.pageUrl,
  })
  expect(toolText(refused)).toContain("which the owner has not allowed")
  expect(upstream.pageHits).toEqual(["GET"])
})
