import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import {
  callTool,
  initialize,
  mcpRequest,
  mcpToolCall2026,
  toolText,
} from "../lib/mcp"
import { createToken, openToken } from "../lib/ui"

// The owner's say over what an assistant runs: tools ask first, the owner
// answers through a link while check_permission waits for them, and the
// answer can settle the tool for the token. Blocked tools vanish; access
// copies between tokens; an assistant can propose a server, which is added
// only once the owner agrees, and an OAuth one is connected from a link
// while check_server waits.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const SECRET_NAME = `Permissions key ${RUN}`
const SERVER_NAME = `Permission postcards ${RUN}`
const SLUG = `perm-${RUN}`
const TOKEN_NAME = `Careful assistant ${RUN}`
const SECOND_TOKEN_NAME = `Second assistant ${RUN}`

// What a client that shows prompts and MCP Apps panels declares. PCP uses
// neither: Claude's apps stalled on prompts and rebuilt panels stale.
const PROMPTS_AND_PANELS = {
  elicitation: { form: {}, url: {} },
  extensions: {
    "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
  },
}

let upstream: Upstream
let token: string
let tokenId: string

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

/** The permission link in a result's text, and the request's id. */
function linkIn(text: string): { path: string; id: string } {
  const id = text.match(/\/permissions\/([\w-]+)/)?.[1]
  expect(id, text).toBeTruthy()
  return { path: `/permissions/${id}`, id: id! }
}

function callsOf(tool: string): number {
  return upstream.calls.filter((call) => call.tool === tool).length
}

test("sets up a server, with its secret typed into the form, and a token", async ({
  page,
}) => {
  // No trip to the Secrets page: the key is entered with the server.
  await page.goto("/servers/new")
  await page.getByLabel("Name").fill(SERVER_NAME)
  await page.getByLabel("Server URL").fill(upstream.mcpUrl)
  await page.getByLabel("Description").fill("Postcards for permission tests.")
  await page.getByLabel("Authentication").selectOption("header")
  await page
    .getByLabel("Secret", { exact: true })
    .selectOption({ label: "A new secret, entered here" })
  await page.getByLabel("New secret's value").fill(upstream.expectedToken)
  await page.getByLabel("Save it as (optional)").fill(SECRET_NAME)
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByText("Tools (3)")).toBeVisible()
  await page.getByLabel("Short name").fill(SLUG)
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()

  token = await createToken(page, TOKEN_NAME)
  tokenId = await openToken(page, TOKEN_NAME)
  await expect(page.getByLabel(`Access to ${SLUG}/add_numbers`)).toHaveValue(
    "ask",
  )
})

test("a tool nobody decided on asks first, through a link", async ({
  page,
  baseURL,
}) => {
  const args = {
    server: SLUG,
    tool: "add_numbers",
    arguments: { a: 19, b: 23 },
  }

  const asked = await callTool(baseURL!, token, "call_tool", args)
  expect(asked.body.result?.isError ?? false, toolText(asked)).toBe(false)
  expect(toolText(asked)).toContain("Not done yet")
  const { path, id } = linkIn(toolText(asked))
  expect(callsOf("add_numbers")).toBe(0)

  // Asking again waits on the same request.
  const again = await callTool(baseURL!, token, "call_tool", args)
  expect(linkIn(toolText(again)).id).toBe(id)

  // The assistant waits on check_permission while the owner answers.
  const waited = callTool(baseURL!, token, "check_permission", { id })
  await page.goto(path)
  await expect(page.getByText(`Allow ${SLUG}/add_numbers?`)).toBeVisible()
  await expect(page.getByText("a: 19")).toBeVisible()
  await page.getByRole("button", { name: "Always allow" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText("42")
  expect(callsOf("add_numbers")).toBe(1)

  const outcome = await waited
  expect(toolText(outcome)).toContain("allowed it and it ran")
  expect(toolText(outcome)).toContain("42")

  // "Always allow" settled it: the next call runs at once.
  const direct = await callTool(baseURL!, token, "call_tool", {
    ...args,
    arguments: { a: 1, b: 1 },
  })
  expect(toolText(direct)).toBe("2")

  await page.goto(`/tokens/${tokenId}`)
  await expect(page.getByLabel(`Access to ${SLUG}/add_numbers`)).toHaveValue(
    "allowed",
  )
})

test("a blocked tool is hidden from the assistant and refused", async ({
  page,
  baseURL,
}) => {
  await page.goto(`/tokens/${tokenId}`)
  await page
    .getByLabel(`Access to ${SLUG}/send_postcard`)
    .selectOption("blocked")
  await expect(page.getByLabel(`Access to ${SLUG}/send_postcard`)).toBeEnabled()
  await page.reload()
  await expect(page.getByLabel(`Access to ${SLUG}/send_postcard`)).toHaveValue(
    "blocked",
  )

  const search = await callTool(baseURL!, token, "search_tools", {
    query: "postcard",
    server: SLUG,
  })
  expect(toolText(search)).not.toContain(`${SLUG}/send_postcard`)

  const described = await callTool(baseURL!, token, "describe_tool", {
    server: SLUG,
    tool: "send_postcard",
  })
  expect(described.body.result?.isError).toBe(true)

  const refused = await callTool(baseURL!, token, "call_tool", {
    server: SLUG,
    tool: "send_postcard",
    arguments: { to: "Ada", message: "Hi" },
  })
  expect(refused.body.result?.isError).toBe(true)
  expect(toolText(refused)).toContain("blocked")

  const { instructions } = await initialize(baseURL!, token)
  expect(instructions).toContain(
    `${SLUG}: Postcards for permission tests. (2 tools)`,
  )
  expect(callsOf("send_postcard")).toBe(0)
})

test("a client that shows prompts and panels gets the link all the same", async ({
  page,
  baseURL,
}) => {
  // No panel to mount, and no tool only a panel calls.
  const listed = await mcpRequest(baseURL!, token, "tools/list")
  const tools = listed.body.result?.tools ?? []
  expect(tools.map((tool) => tool.name)).not.toContain("answer_permission")
  expect(tools.filter((tool) => tool._meta?.ui)).toEqual([])
  const panel = await mcpRequest(baseURL!, token, "resources/read", {
    uri: "ui://pcp/panel",
  })
  expect(panel.body.result?.contents ?? []).toEqual([])

  const args = { server: SLUG, tool: "echo_auth", arguments: {} }
  const asked = await mcpToolCall2026(baseURL!, token, "call_tool", args, {
    capabilities: PROMPTS_AND_PANELS,
  })
  expect(asked.body.result?.resultType).not.toBe("input_required")
  expect(toolText(asked)).toContain("Not done yet")
  const { path, id } = linkIn(toolText(asked))

  const waited = mcpToolCall2026(
    baseURL!,
    token,
    "check_permission",
    { id },
    { capabilities: PROMPTS_AND_PANELS },
  )
  await page.goto(path)
  await page.getByRole("button", { name: "Always allow" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `Bearer ${upstream.expectedToken}`,
  )
  await expect(page.getByText("carries on by itself")).toBeVisible()
  expect(toolText(await waited)).toContain(`Bearer ${upstream.expectedToken}`)
  expect(callsOf("echo_auth")).toBe(1)

  const direct = await callTool(baseURL!, token, "call_tool", args)
  expect(toolText(direct)).toBe(`Bearer ${upstream.expectedToken}`)
})

test("copying access gives a second token the same tools", async ({
  page,
  baseURL,
}) => {
  const second = await createToken(page, SECOND_TOKEN_NAME)
  await openToken(page, SECOND_TOKEN_NAME)

  await page
    .getByLabel("Token to copy from")
    .selectOption({ label: TOKEN_NAME })
  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Copy access" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Copied." }),
  ).toBeVisible()

  await page.reload()
  await expect(page.getByLabel(`Access to ${SLUG}/add_numbers`)).toHaveValue(
    "allowed",
  )
  await expect(page.getByLabel(`Access to ${SLUG}/echo_auth`)).toHaveValue(
    "allowed",
  )
  await expect(page.getByLabel(`Access to ${SLUG}/send_postcard`)).toHaveValue(
    "blocked",
  )

  const echoed = await callTool(baseURL!, second, "call_tool", {
    server: SLUG,
    tool: "echo_auth",
    arguments: {},
  })
  expect(toolText(echoed)).toBe(`Bearer ${upstream.expectedToken}`)

  const refused = await callTool(baseURL!, second, "call_tool", {
    server: SLUG,
    tool: "send_postcard",
    arguments: { to: "Ada", message: "Hi" },
  })
  expect(refused.body.result?.isError).toBe(true)
})

test("an assistant can propose a server with a stored secret; it is added once you agree", async ({
  page,
  baseURL,
}) => {
  const name = `Proposed ${RUN}`

  const asked = await callTool(baseURL!, token, "register_server", {
    name,
    url: upstream.mcpUrl,
    description: "Proposed by an assistant.",
    auth_type: "header",
    secret: SECRET_NAME,
  })
  expect(toolText(asked)).toContain("Not done yet")
  const { path } = linkIn(toolText(asked))

  const before = await initialize(baseURL!, token)
  expect(before.instructions).not.toContain(`proposed-${RUN}`)

  await page.goto(path)
  await expect(page.getByText(`Add the server ${name}?`)).toBeVisible()
  await expect(
    page.getByText(`sends your secret "${SECRET_NAME}"`),
  ).toBeVisible()
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText("3 tools")

  const after = await initialize(baseURL!, token)
  expect(after.instructions).toContain(
    `proposed-${RUN}: Proposed by an assistant. (3 tools)`,
  )
})

test("an assistant can propose a server with a secret you do not have yet; you type it in PCP", async ({
  page,
  baseURL,
}) => {
  const name = `Proposed new key ${RUN}`
  const secretName = `Proposed key ${RUN}`

  const asked = await callTool(baseURL!, token, "register_server", {
    name,
    url: upstream.mcpUrl,
    auth_type: "header",
    secret: secretName,
  })
  const text = toolText(asked)
  expect(text).toContain(`sends a new secret, saved as "${secretName}"`)
  expect(text).toContain("do not ask them for it here")
  const { path, id } = linkIn(text)

  await page.goto(path)
  await expect(page.getByText(`Add the server ${name}?`)).toBeVisible()
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(
    page.getByText(`Enter the value of the secret "${secretName}" first.`),
  ).toBeVisible()
  await page
    .getByLabel(`Value of the secret "${secretName}"`)
    .fill(upstream.expectedToken)
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText("3 tools")
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `saved in PCP as "${secretName}"`,
  )

  // The assistant learns the outcome, never the value.
  const outcome = await callTool(baseURL!, token, "check_permission", { id })
  expect(toolText(outcome)).toContain("3 tools")
  expect(toolText(outcome)).not.toContain(upstream.expectedToken)

  await page.goto("/secrets")
  await expect(page.getByText(secretName, { exact: true })).toBeVisible()
})

test("an OAuth server an assistant proposes is connected through a link", async ({
  page,
  baseURL,
}) => {
  const asked = await callTool(baseURL!, token, "register_server", {
    name: `Proposed OAuth ${RUN}`,
    url: upstream.oauthMcpUrl,
    auth_type: "oauth",
  })
  const { path, id } = linkIn(toolText(asked))

  const agreed = callTool(baseURL!, token, "check_permission", { id })
  await page.goto(path)
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText("Added")

  // Added, and the assistant is told how to get it connected.
  const added = await agreed
  expect(toolText(added)).toContain("needs connecting")
  expect(added.body.result?.structuredContent?.kind).toBe("connect")
  const connect = added.body.result!.structuredContent!.connect!
  expect(toolText(added)).toContain(`/servers/${connect.serverId}`)
  expect(connect.startUrl).toContain(
    `/api/servers/${connect.serverId}/oauth/start`,
  )

  // check_server waits while the owner signs in, and answers once they have.
  const connected = callTool(baseURL!, token, "check_server", {
    server: connect.slug,
  })
  await page.goto(connect.startUrl)
  await expect(page).toHaveURL(
    new RegExp(`/servers/${connect.serverId}\\?connected=1$`),
  )
  await expect(page.getByText("carries on by itself")).toBeVisible()
  expect(
    (await connected).body.result?.structuredContent?.server,
  ).toMatchObject({ connected: true, toolCount: 3 })

  // Its tools ask first, like any other.
  const call = await callTool(baseURL!, token, "call_tool", {
    server: connect.slug,
    tool: "echo_auth",
    arguments: {},
  })
  await page.goto(linkIn(toolText(call)).path)
  await page.getByRole("button", { name: "Allow once" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "Bearer access-",
  )
})
