import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import { OWNER_PASSWORD } from "../lib/auth"
import { callTool, initialize, toolText } from "../lib/mcp"
import {
  addSecret,
  allowAllTools,
  confirmWithPassword,
  openAdvanced,
} from "../lib/ui"

// A wrapper, end to end: an assistant proposes simpler tools over a server
// whose tool wants an API key as an argument, the owner reads every program
// and types the key in, and the wrapper's tool then puts the key where it
// goes — the assistant never sees it — while the tool it replaces leaves
// search.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const UPSTREAM_SECRET = `Keyed upstream ${RUN}`
const SERVER_NAME = `Keyed ${RUN}`
const SLUG = `keyed-${RUN}`
const TOKEN_NAME = `Wrapper writer ${RUN}`
const KEY_NAME = `Lookup key ${RUN}`
const KEY = `lookup-${RUN}-0123456789`
const WRAPPER_NAME = `Lookup ${RUN}`
const WRAPPER_SLUG = `lookup-${RUN}`

let upstream: Upstream
let token: string

test.beforeAll(async () => {
  upstream = await startUpstream()
  upstream.lateTools.add("keyed_echo")
})

test.afterAll(async () => {
  await upstream?.close()
})

test("the owner adds a server and a token that may propose wrappers", async ({
  page,
  baseURL,
}) => {
  await addSecret(page, {
    name: UPSTREAM_SECRET,
    value: upstream.expectedToken,
  })
  await page.goto("/servers/new")
  await page.getByLabel("Name").fill(SERVER_NAME)
  await page.getByLabel("Server URL").fill(upstream.mcpUrl)
  await page.getByLabel("Authentication").selectOption("header")
  await page.getByLabel("Secret").selectOption({ label: UPSTREAM_SECRET })
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  await openAdvanced(page)
  await page.getByLabel("Short name").fill(SLUG)
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()

  await page.goto("/tokens")
  await page.getByLabel("Name").fill(TOKEN_NAME)
  await page
    .getByLabel("Let an assistant with this token propose wrappers")
    .check()
  await page.getByRole("button", { name: "Create token" }).click()
  await confirmWithPassword(page, OWNER_PASSWORD)
  await expect(page.getByText("Your new token")).toBeVisible()
  token = (await page.getByTestId("new-token").textContent())!

  await allowAllTools(page, TOKEN_NAME, SLUG)

  const { tools, instructions } = await initialize(baseURL!, token)
  expect(tools).toEqual(
    expect.arrayContaining([
      "get_wrapper",
      "create_wrapper",
      "update_wrapper",
      "delete_wrapper",
    ]),
  )
  expect(instructions).toContain("create_wrapper")
})

test("an assistant proposes a wrapper; the owner reads it and types the key in", async ({
  page,
  baseURL,
}) => {
  const asked = await callTool(baseURL!, token, "create_wrapper", {
    name: WRAPPER_NAME,
    description: "Look things up without a key.",
    tools: [
      {
        name: "lookup",
        description: "Looks a text up; the key is filled in.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        program: `return await pcp.call("${SLUG}", "keyed_echo", { api_key: { $secret: "${KEY_NAME}" }, text: args.text })`,
        calls: [`${SLUG}/keyed_echo`],
        replaces: [`${SLUG}/keyed_echo`],
      },
    ],
    secrets: [
      { secret: KEY_NAME, tool: `${SLUG}/keyed_echo`, argument: "/api_key" },
    ],
  })
  expect(toolText(asked)).toContain("Not done yet")
  const id = toolText(asked).match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, toolText(asked)).toBeTruthy()

  await page.goto(`/permissions/${id}`)
  await expect(page.getByText(`Add the wrapper ${WRAPPER_NAME}?`)).toBeVisible()
  // The program in full, and where the key goes, before anything is agreed.
  await expect(page.getByText(`api_key: { $secret:`)).toBeVisible()
  await expect(page.getByRole("note")).toContainText(
    `your secret "${KEY_NAME}"`,
  )
  const places = page.getByRole("region", { name: "Where your secrets go" })
  await expect(places.getByRole("row").nth(1)).toContainText(
    `${SLUG}/keyed_echo /api_key`,
  )
  await page.getByLabel(`Value of the secret "${KEY_NAME}"`).fill(KEY)
  await page.getByRole("button", { name: "Make the change" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `was added as ${WRAPPER_SLUG}`,
  )
})

test("the wrapper's tool puts the key in, and the assistant never sees it", async ({
  page,
  baseURL,
}) => {
  // The replaced tool has left search; the wrapper's is there instead.
  const search = await callTool(baseURL!, token, "search_tools", {
    query: "looks a text up",
  })
  expect(toolText(search)).toContain(`${WRAPPER_SLUG}/lookup`)
  expect(toolText(search)).not.toContain(`${SLUG}/keyed_echo`)

  // New tools ask first, a wrapper's too.
  await allowAllTools(page, TOKEN_NAME, WRAPPER_SLUG)
  const answer = await callTool(baseURL!, token, "call_tool", {
    server: WRAPPER_SLUG,
    tool: "lookup",
    arguments: { text: "hello" },
  })
  expect(answer.body.result?.isError ?? false, toolText(answer)).toBe(false)
  expect(toolText(answer)).toContain("hello (asked with [redacted])")
  expect(toolText(answer)).not.toContain(KEY)
  expect(upstream.calls.at(-1)).toMatchObject({
    tool: "keyed_echo",
    args: { api_key: KEY, text: "hello" },
  })

  // The assistant cannot put the secret in itself.
  const own = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "keyed_echo",
    arguments: { api_key: { $secret: KEY_NAME }, text: "x" },
  })
  expect(own.body.result?.isError).toBe(true)
  expect(toolText(own)).toContain("not taken from you")
})
