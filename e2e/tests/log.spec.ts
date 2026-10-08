import { expect, test } from "@playwright/test"

import { callTool } from "../lib/mcp"
import { createToken } from "../lib/ui"

// The Log page: a token's calls show up by token, tool and outcome, never
// what was sent, and the filters narrow them.
const RUN = Date.now().toString(36)
const TOKEN_NAME = `Logged ${RUN}`

test("a token's calls are on the Log page, by tool and outcome, never what they sent", async ({
  page,
  baseURL,
}) => {
  const token = await createToken(page, TOKEN_NAME)

  await callTool(baseURL!, token, "search_tools", {
    query: `secret words ${RUN}`,
  })
  await callTool(baseURL!, token, "call_tool", {
    server: `missing-${RUN}`,
    tool: "anything",
    arguments: { note: `private ${RUN}` },
  })

  await page.goto("/log")
  await page.getByLabel("Token", { exact: true }).selectOption({
    label: TOKEN_NAME,
  })
  await page.getByRole("button", { name: "Filter" }).click()
  await expect(page).toHaveURL(/\/log\?token=/)

  // The gateway writes a call's line just after it answers: read the page
  // again until both are there.
  const lines = page.getByTestId("log-line")
  await expect
    .poll(
      async () => {
        await page.reload()
        return lines.count()
      },
      { timeout: 15_000 },
    )
    .toBe(2)
  await expect(lines.nth(0)).toContainText("call_tool")
  await expect(lines.nth(0)).toContainText(`missing-${RUN}/anything`)
  await expect(lines.nth(0)).toContainText("Failed")
  await expect(lines.nth(0)).toContainText(TOKEN_NAME)
  await expect(lines.nth(1)).toContainText("search_tools")
  await expect(lines.nth(1)).toContainText("Done")
  await expect(page.getByText(`secret words ${RUN}`)).toHaveCount(0)
  await expect(page.getByText(`private ${RUN}`)).toHaveCount(0)
})
