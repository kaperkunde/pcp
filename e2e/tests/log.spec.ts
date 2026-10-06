import { expect, test } from "@playwright/test"

import { callTool } from "../lib/mcp"
import { createToken } from "../lib/ui"

// The Log page and the cleanup. A token's calls show up on the Log page by
// token, tool and outcome (never what was sent), the filters narrow it, the
// token's page links to its own lines; Settings → Cleanup takes a schedule
// and how long the log is kept, refuses one that skips a day, and cleans up
// on demand.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const TOKEN_NAME = `Logged ${RUN}`

test("a token's calls are on the Log page, by tool and outcome, never what they sent", async ({
  page,
  baseURL,
}) => {
  const token = await createToken(page, TOKEN_NAME)
  const tokenUrl = page.url()

  await callTool(baseURL!, token, "search_tools", {
    query: `secret words ${RUN}`,
  })
  await callTool(baseURL!, token, "call_tool", {
    server: `missing-${RUN}`,
    tool: "anything",
    arguments: { note: `private ${RUN}` },
  })

  await page.goto(tokenUrl)
  await page.getByRole("link", { name: "Its log" }).click()
  await expect(page).toHaveURL(/\/log\?token=/)
  await expect(page.getByLabel("Token")).toHaveValue(/.+/)

  // The log is written just after the answer: look again until it is there.
  const lines = page.getByTestId("log-line")
  await expect(async () => {
    await page.reload()
    await expect(lines).toHaveCount(2, { timeout: 1_000 })
  }).toPass()
  await expect(lines.nth(0)).toContainText("call_tool")
  await expect(lines.nth(0)).toContainText(`missing-${RUN}/anything`)
  await expect(lines.nth(0)).toContainText("Failed")
  await expect(lines.nth(0)).toContainText(TOKEN_NAME)
  await expect(lines.nth(1)).toContainText("search_tools")
  await expect(lines.nth(1)).toContainText("Done")
  await expect(page.getByText(`secret words ${RUN}`)).toHaveCount(0)
  await expect(page.getByText(`private ${RUN}`)).toHaveCount(0)

  await page.getByLabel("Outcome").selectOption("error")
  await page.getByRole("button", { name: "Filter" }).click()
  await expect(page).toHaveURL(/outcome=error/)
  await expect(lines).toHaveCount(1)
  await expect(lines.first()).toContainText("call_tool")

  await page.getByRole("link", { name: "Clear" }).click()
  await expect(page).toHaveURL(/\/log$/)
  await page.getByLabel("Tool or server").fill(`missing-${RUN}`)
  await page.getByRole("button", { name: "Filter" }).click()
  await expect(lines).toHaveCount(1)
})

test("Settings → Cleanup saves a schedule, refuses one that skips a day, and cleans up now", async ({
  page,
}) => {
  await page.goto("/settings")
  const form = page.getByRole("form", { name: "Cleanup schedule" })

  await form.getByLabel("When").selectOption("custom")
  await form.getByLabel("Custom schedule").fill("0 3 * * 1-5")
  await form.getByRole("button", { name: "Save" }).click()
  await expect(form.getByRole("alert")).toContainText(
    "more than a day between two cleanups",
  )

  await form.getByLabel("When").selectOption("quarter-hour")
  await form.getByLabel("Keep the log for").fill("30")
  await form.getByRole("button", { name: "Save" }).click()
  await expect(form.getByRole("status")).toContainText("Saved")

  await page.reload()
  await expect(form.getByLabel("When")).toHaveValue("quarter-hour")
  await expect(form.getByLabel("Keep the log for")).toHaveValue("30")
  await expect(page.getByTestId("cleanup-status")).toContainText("Next cleanup")

  const now = page.getByRole("form", { name: "Clean up now" })
  await now.getByRole("button", { name: "Clean up now" }).click()
  await expect(now.getByRole("status")).toHaveText(
    /^(Removed .+|There was nothing to remove)\.$/,
  )
  await expect(page.getByTestId("cleanup-status")).toContainText(
    "because you asked",
  )

  // Back to the default, for whoever runs next.
  await form.getByLabel("When").selectOption("hourly")
  await form.getByLabel("Keep the log for").fill("90")
  await form.getByRole("button", { name: "Save" }).click()
  await expect(form.getByRole("status")).toContainText("Saved")
})
