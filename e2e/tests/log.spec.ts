import { expect, test } from "@playwright/test"

import { startUpstream } from "../fixtures/upstream"
import { callTool, toolText } from "../lib/mcp"
import {
  allowAllTools,
  clickHydrated,
  createToken,
  openTokenAdvanced,
  setPrivateAddresses,
} from "../lib/ui"

// The Log page: a token's calls show up by token, tool and outcome, never
// what was sent, and the filters narrow them. A call made again on purpose
// (rerun) is marked, and says nothing of why.
const RUN = Date.now().toString(36)
const TOKEN_NAME = `Logged ${RUN}`

test("a token's calls are on the Log page, by tool and outcome, never what they sent", async ({
  page,
  baseURL,
}) => {
  const token = await createToken(page, TOKEN_NAME)

  await callTool(baseURL!, token, "search", {
    query: `secret words ${RUN}`,
  })
  await callTool(baseURL!, token, "search", {
    ref: `missing-${RUN}/anything`,
  })
  await callTool(baseURL!, token, "execute_destructive", {
    call_handle: `not a handle ${RUN}`,
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
    .toBe(3)
  await expect(lines.nth(0)).toContainText("execute_destructive")
  await expect(lines.nth(0)).toContainText("Failed")
  await expect(lines.nth(0)).toContainText(TOKEN_NAME)
  await expect(lines.nth(1)).toContainText("search")
  await expect(lines.nth(1)).toContainText(`missing-${RUN}/anything`)
  await expect(lines.nth(1)).toContainText("Failed")
  await expect(lines.nth(2)).toContainText("search")
  await expect(lines.nth(2)).toContainText("Done")
  await expect(page.getByText(`secret words ${RUN}`)).toHaveCount(0)
  await expect(page.getByText(`private ${RUN}`)).toHaveCount(0)
  await expect(page.getByText(`not a handle ${RUN}`)).toHaveCount(0)
})

test("a call made again on purpose is marked on the Log page, without its reason", async ({
  page,
  baseURL,
}) => {
  const name = `Repeats ${RUN}`
  const token = await createToken(page, name)
  const register = {
    tool: "register_server",
    arguments: {
      name: `Postcards ${RUN}`,
      url: "https://postcards.example.com/mcp",
    },
  }

  // The same Write call twice is held back; with a reason it is made again.
  await callTool(baseURL!, token, "execute_write", register)
  await callTool(baseURL!, token, "execute_write", register)
  await callTool(baseURL!, token, "execute_write", {
    ...register,
    rerun: true,
    reason: `reason nobody should see ${RUN}`,
  })

  await page.goto("/log")
  await page.getByLabel("Token", { exact: true }).selectOption({ label: name })
  await page.getByRole("button", { name: "Filter" }).click()
  await expect(page).toHaveURL(/\/log\?token=/)

  const lines = page.getByTestId("log-line")
  const again = lines.filter({ hasText: "Made again on purpose" })
  await expect
    .poll(
      async () => {
        await page.reload()
        return again.count()
      },
      { timeout: 15_000 },
    )
    .toBe(1)
  await expect(again).toContainText("register_server")
  await expect(again).toContainText(name)
  await expect(page.getByText(`reason nobody should see ${RUN}`)).toHaveCount(0)
  await expect(lines).toHaveCount(3)
})

test("a secret the browser typed is on the Log page by its name and the site, never its value", async ({
  page,
  baseURL,
}) => {
  const upstream = await startUpstream()

  try {
    const name = `Typist ${RUN}`
    const secret = `Secret ${RUN}`
    const value = `hunter2-${RUN}`
    const origin = new URL(upstream.browserUrl).origin

    await page.goto("/browser")
    const add = page.getByRole("button", { name: "Add the browser" })
    if (await add.isVisible()) {
      await add.click()
    }
    await expect(
      page.getByRole("heading", { name: "For assistants" }),
    ).toBeVisible()

    const token = await createToken(page, name)
    const tokenId = page.url().split("/").pop()!
    await allowAllTools(page, name, "browser")
    await openTokenAdvanced(page, tokenId)
    await setPrivateAddresses(page, true)

    const browse = (tool: string, args: Record<string, unknown>) =>
      callTool(baseURL!, token, "execute_destructive", {
        server: "browser",
        tool,
        arguments: args,
      })
    const requestOf = (text: string) =>
      text.match(/\/permissions\/([\w-]+)/)?.[1]

    // The owner types the secret in, for the fake site only.
    const asked = toolText(
      await browse("request_secret", {
        name: secret,
        purpose: "To sign in to the fake site.",
        origins: [origin],
      }),
    )
    await page.goto(`/permissions/${requestOf(asked)}`)
    await page.getByLabel(`Value of the secret "${secret}"`).fill(value)
    await clickHydrated(
      page.getByRole("button", { name: "Save, allow one use" }),
    )
    await expect(page.getByTestId("permission-outcome")).toBeVisible()

    // The tab opens once the owner allows the site.
    const opening = toolText(
      await browse("tabs", {
        action: "open",
        url: `${upstream.browserUrl}/form`,
      }),
    )
    await page.goto(`/permissions/${requestOf(opening)}`)
    await page.getByRole("button", { name: "Always allow this site" }).click()
    await expect(page.getByTestId("permission-outcome")).toContainText(
      "Opened a new tab:",
      { timeout: 30_000 },
    )
    const tab = (await page
      .getByTestId("permission-outcome")
      .textContent())!.match(/Opened a new tab: ([^\s.]+)[ .]/)![1]!
    const snapshot = toolText(await browse("snapshot", { tab }))
    const ref = snapshot
      .split("\n")
      .find((line) => /textbox "Name"/.test(line))
      ?.match(/\[ref=((?:f\d+)?e\d+)\]/)?.[1]
    expect(ref, snapshot).toBeTruthy()

    // Typed through the gate: with the one use the owner gave, or asking.
    let typed = toolText(
      await browse("type", { tab, ref, text: { $secret: secret } }),
    )
    if (typed.includes("Not done yet")) {
      await page.goto(`/permissions/${requestOf(typed)}`)
      await page.getByRole("button", { name: "Allow once" }).click()
      await expect(page.getByTestId("permission-outcome")).toBeVisible()
      typed = toolText(
        await browse("type", { tab, ref, text: { $secret: secret } }),
      )
    }
    expect(typed).not.toContain(value)

    await page.goto("/log")
    await page
      .getByLabel("Token", { exact: true })
      .selectOption({ label: name })
    await page.getByRole("button", { name: "Filter" }).click()
    await expect(page).toHaveURL(/\/log\?token=/)

    const line = page
      .getByTestId("log-line")
      .filter({ hasText: "Typed the secret" })
    await expect
      .poll(
        async () => {
          await page.reload()
          return line.count()
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0)
    await expect(line.first()).toContainText(`“${secret}” at ${origin}`)
    await expect(page.getByText(value)).toHaveCount(0)
  } finally {
    await upstream.close()
  }
})
