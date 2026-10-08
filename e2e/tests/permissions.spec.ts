import { expect, test, type Page } from "@playwright/test"

import { startUpstream, type Upstream } from "../fixtures/upstream"
import {
  callTool,
  initialize,
  mcpRequest,
  mcpToolCall2026,
  toolText,
} from "../lib/mcp"
import {
  acceptNextDialog,
  chooseProposedLevel,
  createToken,
  expectLevel,
  openRequestFromBell,
  openToken,
  permissionFrom,
  proposedLevel,
  showServerSettings,
  showTools,
} from "../lib/ui"

// The owner's say over what an assistant runs: tools ask first, the owner
// answers through a link (or the bell) and check_permission gives the
// assistant the outcome, waiting while they are still on it, and the answer
// can settle the tool for the token. Blocked tools vanish; access copies
// between tokens; an assistant can propose tool levels, which change only
// once the owner saves them on PCP's page, and a server, which is added
// only once the owner agrees, and an OAuth one is connected from a link
// while check_server waits. A server an assistant proposes reaches public
// addresses only, and the fake upstream is on loopback: the owner is told so
// when asked, and allows private addresses on the server's page.
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

test.beforeAll(async () => {
  upstream = await startUpstream()
})

test.afterAll(async () => {
  await upstream?.close()
})

/**
 * An assistant's server reaches public addresses only. The fake upstream is
 * on loopback, so the owner allows private addresses on its page.
 */
async function allowPrivateAddresses(page: Page, slug: string) {
  await page.goto("/servers")
  await page
    .getByRole("link")
    .filter({ has: page.getByText(slug, { exact: true }) })
    .click()
  await expect(page).toHaveURL(/\/servers\/[0-9a-f-]+$/)
  await showServerSettings(page)
  await expect(page.getByLabel("Public addresses only")).toBeChecked()
  await page.getByLabel("Public addresses only").uncheck()
  await page.getByRole("button", { name: "Save changes" }).click()
}

const PRIVATE_FLAG =
  /127\.0\.0\.1 is, or resolves to, a private or local address\. A server an assistant proposes reaches public addresses only/

function callsOf(tool: string): number {
  return upstream.calls.filter((call) => call.tool === tool).length
}

/** What a tool's level is for a token, as the assistant is told. */
async function levelOf(
  baseURL: string,
  assistant: string,
  tool: string,
): Promise<string | undefined> {
  const described = await callTool(baseURL, assistant, "describe_tool", {
    server: SLUG,
    tool,
  })

  return toolText(described).match(/"access": "(\w+)"/)?.[1]
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
  await showServerSettings(page)
  await page.getByLabel("Short name").fill(SLUG)
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()

  token = await createToken(page, TOKEN_NAME)
})

test("a tool nobody decided on asks first, through a link, even for a client that shows prompts", async ({
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

  const args = {
    server: SLUG,
    tool: "add_numbers",
    arguments: { a: 19, b: 23 },
  }

  const asked = await callTool(baseURL!, token, "call_tool", args)
  expect(asked.body.result?.isError ?? false, toolText(asked)).toBe(false)
  expect(toolText(asked)).toContain("Not done yet")
  const { path, id } = permissionFrom(toolText(asked))
  expect(callsOf("add_numbers")).toBe(0)

  // Asking again waits on the same request.
  const again = await callTool(baseURL!, token, "call_tool", args)
  expect(permissionFrom(toolText(again)).id).toBe(id)

  // The link comes last, on a line of its own: some apps hide what an
  // assistant writes before its next tool call.
  expect(toolText(asked)).toContain("End your reply with this link")
  expect(toolText(asked).trim().split("\n").at(-1)).toMatch(
    new RegExp(`${path}$`),
  )

  // The owner sees it waiting from any page: the bell has a count, and its
  // list leads to the request. Nothing ran before they answer.
  await page.goto("/servers")
  await openRequestFromBell(page, new RegExp(`Allow ${SLUG}/add_numbers\\?`))
  await expect(page).toHaveURL(new RegExp(`${path}$`))
  await expect(page.getByText(`Allow ${SLUG}/add_numbers?`)).toBeVisible()
  await expect(
    page.getByTestId("permission-lines").getByText("19", { exact: true }),
  ).toBeVisible()
  expect(callsOf("add_numbers")).toBe(0)
  await page.getByRole("button", { name: "Always allow" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText("42")
  expect(callsOf("add_numbers")).toBe(1)

  // Told they answered, the assistant checks, and has the result at once.
  const outcome = await callTool(baseURL!, token, "check_permission", { id })
  expect(toolText(outcome)).toContain("allowed it and it ran")
  expect(toolText(outcome)).toContain("42")

  // "Always allow" settled it: the next call runs at once.
  const direct = await callTool(baseURL!, token, "call_tool", {
    ...args,
    arguments: { a: 1, b: 1 },
  })
  expect(toolText(direct)).toBe("2")
  expect(await levelOf(baseURL!, token, "add_numbers")).toBe("allowed")

  // A client that declares prompts and panels gets the same link, and
  // check_permission started before the owner answers waits for them.
  const echo = { server: SLUG, tool: "echo_auth", arguments: {} }
  const prompted = await mcpToolCall2026(baseURL!, token, "call_tool", echo, {
    capabilities: PROMPTS_AND_PANELS,
  })
  expect(prompted.body.result?.resultType).not.toBe("input_required")
  expect(toolText(prompted)).toContain("Not done yet")
  const waited = mcpToolCall2026(
    baseURL!,
    token,
    "check_permission",
    { id: permissionFrom(toolText(prompted)).id },
    { capabilities: PROMPTS_AND_PANELS },
  )
  await page.goto(permissionFrom(toolText(prompted)).path)
  await page.getByRole("button", { name: "Always allow" }).click()
  // The server repeats its secret back; PCP takes it out of the answer.
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "[redacted]",
  )
  await expect(page.getByText("Tell the assistant that asked")).toBeVisible()
  const answer = toolText(await waited)
  expect(answer).toContain("[redacted]")
  expect(answer).not.toContain(upstream.expectedToken)
  expect(callsOf("echo_auth")).toBe(1)
})

test("a blocked tool is hidden from the assistant and refused; a copy of the access keeps it blocked", async ({
  page,
  baseURL,
}) => {
  const postcard = {
    server: SLUG,
    tool: "send_postcard",
    arguments: { to: "Ada", message: "Hi" },
  }
  const asked = await callTool(baseURL!, token, "call_tool", postcard)
  await page.goto(permissionFrom(toolText(asked)).path)
  await page.getByRole("button", { name: "Block", exact: true }).click()
  await expect(page.getByTestId("permission-outcome")).toBeVisible()

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

  const refused = await callTool(baseURL!, token, "call_tool", postcard)
  expect(refused.body.result?.isError).toBe(true)
  expect(toolText(refused)).toContain("blocked")

  const { instructions } = await initialize(baseURL!, token)
  expect(instructions).toContain(
    `${SLUG}: Postcards for permission tests. (2 tools)`,
  )
  expect(callsOf("send_postcard")).toBe(0)

  // Copying the access gives a second token the same tools, blocked ones
  // included.
  const second = await createToken(page, SECOND_TOKEN_NAME)
  await openToken(page, SECOND_TOKEN_NAME)
  await page
    .getByLabel("Token to copy from")
    .selectOption({ label: TOKEN_NAME })
  acceptNextDialog(page)
  await page.getByRole("button", { name: "Copy access" }).click()
  await expect(
    page.getByRole("status").filter({ hasText: "Copied." }),
  ).toBeVisible()

  const echoed = await callTool(baseURL!, second, "call_tool", {
    server: SLUG,
    tool: "echo_auth",
    arguments: {},
  })
  expect(toolText(echoed)).toContain("[redacted]")
  expect(toolText(echoed)).not.toContain(upstream.expectedToken)
  const secondRefused = await callTool(baseURL!, second, "call_tool", postcard)
  expect(secondRefused.body.result?.isError).toBe(true)
})

test("an assistant proposes tool levels; nothing changes until you save them", async ({
  page,
  baseURL,
}) => {
  const proposer = await createToken(page, `Proposing assistant ${RUN}`)

  const proposed = await callTool(baseURL!, proposer, "propose_tool_access", {
    changes: [
      { server: SLUG, access: "allowed" },
      { server: SLUG, tools: ["send_*"], access: "blocked" },
    ],
  })
  expect(proposed.body.result?.isError ?? false, toolText(proposed)).toBe(false)
  expect(toolText(proposed)).toContain("3 tools would change")
  const { path, id } = permissionFrom(toolText(proposed))

  // Asking changed nothing: the tool still asks first.
  expect(await levelOf(baseURL!, proposer, "add_numbers")).toBe("ask")

  await page.goto(path)
  await expect(
    page.getByText("Change which tools an assistant may run?"),
  ).toBeVisible()

  // The proposal is filled in and each change marked.
  await expect(
    proposedLevel(page, SLUG, "add_numbers").getByRole("radio", {
      name: "Allowed",
    }),
  ).toBeChecked()
  await expect(
    proposedLevel(page, SLUG, "send_postcard").getByRole("radio", {
      name: "Blocked",
    }),
  ).toBeChecked()
  await expect(page.locator("li[data-changed]")).toHaveCount(3)

  // The owner takes one back before saving, while the assistant waits.
  const waited = callTool(baseURL!, proposer, "check_permission", { id })
  await chooseProposedLevel(page, SLUG, "echo_auth", "Ask you first")
  await expect(page.locator("li[data-changed]")).toHaveCount(2)
  await page.getByRole("button", { name: "Save changes" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "You saved these levels.",
  )

  expect(toolText(await waited)).toContain(
    "They did not take 1 of the 3 levels",
  )

  expect(await levelOf(baseURL!, proposer, "add_numbers")).toBe("allowed")
  expect(await levelOf(baseURL!, proposer, "echo_auth")).toBe("ask")
  const ran = await callTool(baseURL!, proposer, "call_tool", {
    server: SLUG,
    tool: "add_numbers",
    arguments: { a: 2, b: 3 },
  })
  expect(toolText(ran)).toBe("5")
  const refused = await callTool(baseURL!, proposer, "call_tool", {
    server: SLUG,
    tool: "send_postcard",
    arguments: { to: "Ada", message: "Hi" },
  })
  expect(refused.body.result?.isError).toBe(true)
})

test("Allow for lets a tool run without asking until the time is up or you end it", async ({
  page,
  baseURL,
}) => {
  const name = `Allowed for a while ${RUN}`
  const assistant = await createToken(page, name)
  const add = (a: number, b: number) => ({
    server: SLUG,
    tool: "add_numbers",
    arguments: { a, b },
  })

  const asked = await callTool(baseURL!, assistant, "call_tool", add(4, 5))
  expect(toolText(asked)).toContain("Not done yet")
  await page.goto(permissionFrom(toolText(asked)).path)
  await page.getByLabel("How long").selectOption({ label: "15 minutes" })
  await page.getByRole("button", { name: "Allow for 15 minutes" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText("9")

  // For now it runs at once, and the tool's level is as it was.
  expect(
    toolText(await callTool(baseURL!, assistant, "call_tool", add(1, 2))),
  ).toBe("3")

  // The owner sees it on the token's page, with the tool's level as it was,
  // and ends it early: it asks again.
  await openToken(page, name)
  await expect(page.getByText("Allowed for now")).toBeVisible()
  await expect(page.getByText(`${SERVER_NAME} · add_numbers`)).toBeVisible()
  await showTools(page, SLUG)
  await expectLevel(page, `Access to ${SLUG}/add_numbers`, "ask")
  await page.getByRole("button", { name: "End now" }).click()
  await expect(page.getByText("Allowed for now")).toHaveCount(0)
  expect(
    toolText(await callTool(baseURL!, assistant, "call_tool", add(6, 7))),
  ).toContain("Not done yet")
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
  const { path } = permissionFrom(toolText(asked))

  const before = await initialize(baseURL!, token)
  expect(before.instructions).not.toContain(`proposed-${RUN}`)

  await page.goto(path)
  await expect(page.getByText(`Add the server ${name}?`)).toBeVisible()
  await expect(
    page.getByText(`sends your secret "${SECRET_NAME}"`),
  ).toBeVisible()
  // The owner is told the address is on their own network; the assistant
  // is not.
  await expect(page.getByText(PRIVATE_FLAG)).toBeVisible()
  expect(toolText(asked)).not.toContain("private or local")
  await page.getByRole("button", { name: "Add server" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "only reaches public ones",
  )

  await allowPrivateAddresses(page, `proposed-${RUN}`)
  await expect(
    page.getByRole("status").filter({ hasText: "Saved. Found 3 tools." }),
  ).toBeVisible()

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
  const { path, id } = permissionFrom(text)

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
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "only reaches public ones",
  )
  await expect(page.getByTestId("permission-outcome")).toContainText(
    `saved in PCP as "${secretName}"`,
  )

  // The assistant learns the outcome, never the value.
  const outcome = await callTool(baseURL!, token, "check_permission", { id })
  expect(toolText(outcome)).toContain(`Added ${name}`)
  expect(toolText(outcome)).not.toContain(upstream.expectedToken)

  // Once the owner allows private addresses, the key typed in reaches it.
  await allowPrivateAddresses(page, `proposed-new-key-${RUN}`)
  await expect(
    page.getByRole("status").filter({ hasText: "Saved. Found 3 tools." }),
  ).toBeVisible()

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
  const { path, id } = permissionFrom(toolText(asked))

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

  // Its sign-in is under the same rule as its requests: the owner allows
  // the fake upstream's loopback address first.
  await allowPrivateAddresses(page, connect.slug)
  await expect(
    page.getByRole("status").filter({ hasText: "Saved." }),
  ).toBeVisible()

  // check_server waits while the owner signs in, and answers once they have.
  const connected = callTool(baseURL!, token, "check_server", {
    server: connect.slug,
  })
  await page.goto(connect.startUrl)
  await expect(page).toHaveURL(
    new RegExp(`/servers/${connect.serverId}\\?connected=1$`),
  )
  await expect(page.getByText("Tell the assistant that asked")).toBeVisible()
  expect(
    (await connected).body.result?.structuredContent?.server,
  ).toMatchObject({ connected: true, toolCount: 3 })

  // Its tools ask first, like any other.
  const call = await callTool(baseURL!, token, "call_tool", {
    server: connect.slug,
    tool: "echo_auth",
    arguments: {},
  })
  await page.goto(permissionFrom(toolText(call)).path)
  await page.getByRole("button", { name: "Allow once" }).click()
  await expect(page.getByTestId("permission-outcome")).toContainText(
    "[redacted]",
  )
  expect(upstream.calls.at(-1)?.authorization).toMatch(/^Bearer access-/)
})
