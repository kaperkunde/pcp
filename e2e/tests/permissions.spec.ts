import { expect, test } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import {
  callTool,
  initialize,
  mcpRequest,
  mcpToolCall2026,
  toolText,
} from "../lib/mcp"
import { addSecret, createToken, openToken } from "../lib/ui"

// The owner's say over what an assistant runs: tools ask first, the owner
// answers through a link, the client's own prompt or PCP's panel, and the
// answer can settle the tool for the token. Blocked tools vanish; access
// copies between tokens; an assistant can propose a server, which is added
// only once the owner agrees, and an OAuth one is connected from a link.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const SECRET_NAME = `Permissions key ${RUN}`
const SERVER_NAME = `Permission postcards ${RUN}`
const SLUG = `perm-${RUN}`
const TOKEN_NAME = `Careful assistant ${RUN}`
const SECOND_TOKEN_NAME = `Second assistant ${RUN}`

// What a client that shows MCP Apps panels declares.
const PANELS = {
  extensions: {
    "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
  },
}
const FORM = { elicitation: { form: {} } }
const ALLOW_ONCE = {
  decision: { action: "accept", content: { decision: "allow_once" } },
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

test("sets up a server and a token", async ({ page }) => {
  await addSecret(page, { name: SECRET_NAME, value: upstream.expectedToken })

  await page.goto("/servers/new")
  await page.getByLabel("Name").fill(SERVER_NAME)
  await page.getByLabel("Server URL").fill(upstream.mcpUrl)
  await page.getByLabel("Description").fill("Postcards for permission tests.")
  await page.getByLabel("Authentication").selectOption("header")
  await page.getByLabel("Secret").selectOption({ label: SECRET_NAME })
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
  const waiting = await callTool(baseURL!, token, "check_permission", { id })
  expect(toolText(waiting)).toContain("Still waiting")

  await page.goto(path)
  await expect(page.getByText(`Allow ${SLUG}/add_numbers?`)).toBeVisible()
  await expect(page.getByText("a: 19")).toBeVisible()
  await page.getByRole("button", { name: "Always allow" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText("42")
  expect(callsOf("add_numbers")).toBe(1)

  const outcome = await callTool(baseURL!, token, "check_permission", { id })
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

test("a client's own prompt asks, and runs the answer once", async ({
  baseURL,
}) => {
  const args = { server: SLUG, tool: "echo_auth", arguments: {} }

  const prompt = await mcpToolCall2026(baseURL!, token, "call_tool", args, {
    capabilities: FORM,
  })
  expect(prompt.body.result?.resultType, JSON.stringify(prompt.body)).toBe(
    "input_required",
  )
  expect(prompt.body.result?.inputRequests?.decision?.method).toBe(
    "elicitation/create",
  )
  const requestState = prompt.body.result?.requestState

  // The answer is bound to the call it was asked for.
  const mismatched = await mcpToolCall2026(
    baseURL!,
    token,
    "call_tool",
    { ...args, arguments: { extra: 1 } },
    { capabilities: FORM, requestState, inputResponses: ALLOW_ONCE },
  )
  expect(mismatched.body.result?.isError).toBe(true)
  expect(callsOf("echo_auth")).toBe(0)

  const ran = await mcpToolCall2026(baseURL!, token, "call_tool", args, {
    capabilities: FORM,
    requestState,
    inputResponses: ALLOW_ONCE,
  })
  expect(toolText(ran)).toBe(`Bearer ${upstream.expectedToken}`)
  expect(callsOf("echo_auth")).toBe(1)

  // Allow once decides this call only; saying no runs nothing.
  const next = await mcpToolCall2026(baseURL!, token, "call_tool", args, {
    capabilities: FORM,
  })
  expect(next.body.result?.resultType).toBe("input_required")
  const declined = await mcpToolCall2026(baseURL!, token, "call_tool", args, {
    capabilities: FORM,
    requestState: next.body.result?.requestState,
    inputResponses: { decision: { action: "decline" } },
  })
  expect(toolText(declined)).toContain("said no")
  expect(callsOf("echo_auth")).toBe(1)
})

test("a way of asking turned off on the token falls back to the link", async ({
  page,
  baseURL,
}) => {
  const prompt = () => page.getByLabel("The app's own prompt")
  const panel = () => page.getByLabel("PCP's panel")
  const save = async () => {
    await page.getByRole("button", { name: "Save settings" }).click()
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible()
  }

  await page.goto(`/tokens/${tokenId}`)
  await expect(prompt()).toBeChecked()
  await expect(page.getByLabel("A link")).toBeDisabled()
  await prompt().uncheck()
  await panel().uncheck()
  await save()

  // A client that declares a prompt is not sent one it might never show.
  const args = { server: SLUG, tool: "echo_auth", arguments: {} }
  const asked = await mcpToolCall2026(baseURL!, token, "call_tool", args, {
    capabilities: { ...FORM, ...PANELS },
  })
  expect(asked.body.result?.resultType).not.toBe("input_required")
  expect(toolText(asked)).toContain("Not done yet")
  const { id } = linkIn(toolText(asked))

  // With the panel off, a panel host gets no buttons and cannot answer.
  const checked = await mcpToolCall2026(
    baseURL!,
    token,
    "check_permission",
    { id },
    { capabilities: PANELS },
  )
  expect(checked.body.result?.structuredContent?.kind).toBe("done")
  const clicked = await mcpToolCall2026(
    baseURL!,
    token,
    "answer_permission",
    { id, decision: "always" },
    { capabilities: PANELS },
  )
  expect(clicked.body.result?.isError).toBe(true)
  expect(callsOf("echo_auth")).toBe(1)

  // Back on, for the tests after this one.
  await page.reload()
  await expect(prompt()).not.toBeChecked()
  await prompt().check()
  await panel().check()
  await save()
})

test("a client that shows panels gets PCP's panel, which only the owner answers", async ({
  baseURL,
}) => {
  const listed = await mcpRequest(baseURL!, token, "tools/list")
  const tools = listed.body.result?.tools ?? []
  expect(
    tools.find((tool) => tool.name === "answer_permission")?._meta?.ui
      ?.visibility,
  ).toEqual(["app"])
  expect(
    tools.find((tool) => tool.name === "check_permission")?._meta?.ui
      ?.resourceUri,
  ).toBe("ui://pcp/panel")

  const panelHtml = await mcpRequest(baseURL!, token, "resources/read", {
    uri: "ui://pcp/panel",
  })
  expect(panelHtml.body.result?.contents?.[0]?.mimeType).toBe(
    "text/html;profile=mcp-app",
  )

  const args = { server: SLUG, tool: "echo_auth", arguments: {} }
  const asked = await mcpToolCall2026(baseURL!, token, "call_tool", args, {
    capabilities: PANELS,
  })
  expect(toolText(asked)).toContain("check_permission")
  const { id } = linkIn(toolText(asked))

  const panel = await mcpToolCall2026(
    baseURL!,
    token,
    "check_permission",
    { id },
    { capabilities: PANELS },
  )
  expect(panel.body.result?.structuredContent?.kind).toBe("permission")
  expect(
    panel.body.result?.structuredContent?.permission?.decisions.map(
      (decision) => decision.label,
    ),
  ).toEqual(["Allow once", "Always allow", "Block", "Not now"])

  // An assistant on a client without panels cannot answer for the owner.
  const selfApproved = await callTool(baseURL!, token, "answer_permission", {
    id,
    decision: "always",
  })
  expect(selfApproved.body.result?.isError).toBe(true)
  expect(callsOf("echo_auth")).toBe(1)

  const clicked = await mcpToolCall2026(
    baseURL!,
    token,
    "answer_permission",
    { id, decision: "always" },
    { capabilities: PANELS },
  )
  expect(toolText(clicked)).toBe(`Bearer ${upstream.expectedToken}`)
  expect(callsOf("echo_auth")).toBe(2)

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

  const unknown = await callTool(baseURL!, token, "register_server", {
    name,
    url: upstream.mcpUrl,
    auth_type: "header",
    secret: `No such secret ${RUN}`,
  })
  expect(unknown.body.result?.isError).toBe(true)
  expect(toolText(unknown)).toContain("No secret called")

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

test("an OAuth server an assistant proposes is connected through a link", async ({
  page,
  baseURL,
}) => {
  const asked = await mcpToolCall2026(
    baseURL!,
    token,
    "register_server",
    {
      name: `Proposed OAuth ${RUN}`,
      url: upstream.oauthMcpUrl,
      auth_type: "oauth",
    },
    { capabilities: PANELS },
  )
  expect(asked.body.result?.structuredContent?.kind).toBe("permission")
  const id = asked.body.result?.structuredContent?.permission?.id

  const added = await mcpToolCall2026(
    baseURL!,
    token,
    "answer_permission",
    { id, decision: "allow_once" },
    { capabilities: PANELS },
  )
  expect(added.body.result?.structuredContent?.kind).toBe("connect")
  const connect = added.body.result!.structuredContent!.connect!
  expect(connect.startUrl).toContain(
    `/api/servers/${connect.serverId}/oauth/start`,
  )

  const before = await callTool(baseURL!, token, "check_server", {
    server: connect.slug,
  })
  expect(before.body.result?.structuredContent?.server?.connected).toBe(false)

  // What the panel's Connect button opens in the owner's browser.
  await page.goto(connect.startUrl)
  await expect(page).toHaveURL(
    new RegExp(`/servers/${connect.serverId}\\?connected=1$`),
  )

  const after = await callTool(baseURL!, token, "check_server", {
    server: connect.slug,
  })
  expect(after.body.result?.structuredContent?.server).toMatchObject({
    connected: true,
    toolCount: 3,
  })

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
