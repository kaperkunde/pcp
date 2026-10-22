import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import { createBrowserServer } from "../browser/server"
import { MAX_CALLS_PER_RUN, RUN_TIMEOUT_MS } from "../code/limits"
import type { Executor } from "../code/types"
import { DEFAULT_TOOL_ACCESS } from "../constants"
import type { VaultContext } from "../context"
import { db } from "../db"
import { createEndpoint } from "../endpoints"
import {
  buildGatewayServer,
  buildInstructions,
  loadGatewayServers,
  type GatewayScope,
} from "../gateway"
import { json, startTestApi, type TestApi } from "../openapi/test-api"
import { decidePermission, getPermissionView } from "../permissions"
import { createSecret } from "../secrets"
import { scratchDatabase } from "../test-db"
import { catalogueHandle, withCallHandle } from "../test-handles"
import { writeToolAccess } from "../tool-access"
import { setupVault } from "../vault"
import { setPacingServer } from "../pacing/config"
import { resetPacing, setPacingClock } from "../pacing/pace"
import { EMPTY_CONFIG, saveResourceConfig } from "../resources/state"
import {
  browserServerIds,
  flowWrapperIds,
  isFlow,
  isFlowTool,
  readDefinition,
} from "./definition"
import { flowSites } from "./flow-sites"
import { FLOW_RUN_TIMEOUT_MS, WRAPPER_RUN_TIMEOUT_MS } from "./limits"
import { wrapperRunTimeout } from "./run"

/** The run limits as tests set them; the real ones unless a test says. */
const timeouts = vi.hoisted(() => ({
  wrapper: null as number | null,
  flow: null as number | null,
}))

vi.mock("./limits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./limits")>()

  return {
    ...actual,
    get WRAPPER_RUN_TIMEOUT_MS() {
      return timeouts.wrapper ?? actual.WRAPPER_RUN_TIMEOUT_MS
    },
    get FLOW_RUN_TIMEOUT_MS() {
      return timeouts.flow ?? actual.FLOW_RUN_TIMEOUT_MS
    },
  }
})

// Wrappers as an assistant meets them, through the gateway's MCP interface:
// proposed, approved by the owner, called (its program calling a real API
// endpoint on a throwaway server), and what it may and may not reach.

const PUBLIC_URL = "http://localhost:3000"
const KEY = "sk-live-0123456789abcdef"

let cleanup: () => Promise<void>
let ctx: VaultContext
let api: TestApi
let scope: GatewayScope
let endpointId: string
let client: Client | null = null

function spec(origin: string) {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Things", version: "1" },
    servers: [{ url: origin }],
    paths: {
      "/echo": {
        get: {
          operationId: "echo",
          summary: "Says back what it was sent",
          parameters: [
            {
              name: "key",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
            { name: "q", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
      "/count": {
        get: {
          operationId: "count",
          summary: "Counts things",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  })
}

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  api = await startTestApi((req, res) => json(res, 200, { got: req.url }))
  ;({ id: endpointId } = await createEndpoint(ctx, {
    name: "Things",
    specSource: "upload",
    specText: spec(api.origin),
    readOnly: false,
    authType: "none",
  }))
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    serverIds: [],
    manageWrappers: true,
  })
  scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  await writeToolAccess(scope.tokenId, endpointId, "echo", "allowed")
  await writeToolAccess(scope.tokenId, endpointId, "count", "allowed")
})

afterEach(async () => {
  await client?.close()
  client = null
  await api.close()
  await cleanup()
  timeouts.wrapper = null
  timeouts.flow = null
  codeExecutor = undefined
  setPacingClock(null)
  resetPacing()
  vi.unstubAllEnvs()
})

/** What runs the programs, when a test replaces it. */
let codeExecutor: Executor | undefined

/** A gateway for the token as it is now, as each request builds one. */
async function connect(): Promise<Client> {
  await client?.close()
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(
    scope,
    await loadGatewayServers(scope),
    codeExecutor ? { codeExecutor } : {},
  ).connect(serverSide)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  return client
}

async function call(name: string, args: Record<string, unknown>) {
  const connected = await connect()
  const result = await connected.callTool({
    name,
    arguments:
      name === "call_tool" || name === "call_read_only_tool"
        ? await withCallHandle(connected, args)
        : args,
  })
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("")

  return { isError: result.isError === true, text }
}

const ECHO_TOOL = {
  name: "lookup",
  description: "Looks a word up, with the key filled in.",
  inputSchema: {
    type: "object",
    properties: { word: { type: "string" } },
    required: ["word"],
  },
  program:
    'const answer = await pcp.call("things", "echo", { key: { $secret: "Things key" }, q: args.word }); return answer',
  calls: ["things/echo"],
  replaces: ["things/echo"],
}

async function newestRequest() {
  return db().permissionRequest.findFirstOrThrow({
    orderBy: { createdAt: "desc" },
  })
}

/** Proposes the echo wrapper and has the owner agree, typing the key in. */
async function approvedWrapper(
  tool: typeof ECHO_TOOL & {
    annotations?: Record<string, boolean>
    outputSchema?: Record<string, unknown>
  } = ECHO_TOOL,
  extra: Record<string, unknown> = {},
) {
  const asked = await call("create_wrapper", {
    name: "Lookup",
    description: "Things, simpler.",
    tools: [tool],
    secrets: [{ secret: "Things key", tool: "things/echo", argument: "/key" }],
    ...extra,
  })
  expect(asked.text).toContain("Not done yet")
  const row = await newestRequest()
  const result = await decidePermission(ctx, row.id, "allow_once", {
    publicUrl: PUBLIC_URL,
    secretValue: KEY,
  })
  expect(result.isError).not.toBe(true)

  return db().mcpServer.findFirstOrThrow({ where: { kind: "wrapper" } })
}

describe("proposing a wrapper", () => {
  it("offers the wrapper tools only to a token allowed to propose them", async () => {
    const { tools } = await (await connect()).listTools()
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "get_wrapper",
        "create_wrapper",
        "update_wrapper",
        "delete_wrapper",
      ]),
    )

    scope = { ...scope, manageWrappers: false }
    const without = await (await connect()).listTools()
    expect(without.tools.map((tool) => tool.name)).not.toContain(
      "create_wrapper",
    )
    expect(buildInstructions([], { manageWrappers: true })).toContain(
      "create_wrapper",
    )
  })

  it("writes nothing until the owner agrees, and shows them every program and secret", async () => {
    const asked = await call("create_wrapper", {
      name: "Lookup",
      tools: [ECHO_TOOL],
      secrets: [
        { secret: "Things key", tool: "things/echo", argument: "/key" },
      ],
    })

    expect(asked.isError).toBe(false)
    expect(asked.text).toContain("Not done yet")
    expect(asked.text).toContain('type the value of the secret "Things key"')
    expect(await db().mcpServer.count({ where: { kind: "wrapper" } })).toBe(0)

    const row = await newestRequest()
    const view = await getPermissionView(ctx, row.id, {
      publicUrl: PUBLIC_URL,
    })

    expect(row.kind).toBe("wrapper_change")
    expect(view!.wrapper!.tools[0]).toMatchObject({
      name: "lookup",
      status: "new",
      program: ECHO_TOOL.program,
      calls: ["things/echo"],
      replaces: ["things/echo"],
    })
    expect(view!.wrapper!.secrets).toEqual([
      expect.objectContaining({
        secret: "Things key",
        tool: "things/echo",
        argument: "/key",
        url: api.origin,
        isNew: true,
      }),
    ])
    expect(view!.warning).toContain('"Things key"')
    expect(view!.secretToEnter).toMatchObject({ name: "Things key" })
  })

  it("refuses a program that does not compile, and a call it does not declare", async () => {
    const broken = await call("create_wrapper", {
      name: "Lookup",
      tools: [{ ...ECHO_TOOL, program: "return (" }],
    })
    expect(broken.isError).toBe(true)
    expect(broken.text).toContain("does not compile")

    const unknown = await call("create_wrapper", {
      name: "Lookup",
      tools: [{ ...ECHO_TOOL, calls: ["things/nope"], replaces: [] }],
    })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain("things has no tool called nope")
  })

  it("refuses a secret going to a tool no wrapper tool calls", async () => {
    const result = await call("create_wrapper", {
      name: "Lookup",
      tools: [{ ...ECHO_TOOL, calls: ["things/count"], replaces: [] }],
      secrets: [
        { secret: "Things key", tool: "things/echo", argument: "/key" },
      ],
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain("none of the wrapper's tools calls")
  })

  it("refuses a tool the token is blocked from", async () => {
    await writeToolAccess(scope.tokenId, endpointId, "echo", "blocked")
    const result = await call("create_wrapper", {
      name: "Lookup",
      tools: [ECHO_TOOL],
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain("not a tool this token may use")
  })

  it("never lets a wrapper call a wrapper", async () => {
    await approvedWrapper()
    const result = await call("create_wrapper", {
      name: "Again",
      tools: [
        {
          ...ECHO_TOOL,
          calls: ["lookup/lookup"],
          replaces: [],
          program: 'return pcp.call("lookup", "lookup", { word: "x" })',
        },
      ],
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain("never a wrapper's")
  })
})

describe("calling a wrapper's tool", () => {
  it("runs the program with the secret put in, and never shows it", async () => {
    const wrapper = await approvedWrapper()
    expect(wrapper.slug).toBe("lookup")

    // Its own level asks first, like any new tool.
    const asked = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: { word: "hello" },
    })
    expect(asked.text).toContain("Not done yet")

    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")
    const result = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: { word: "hello" },
    })

    expect(result.isError).toBe(false)
    expect(result.text).toContain("q=hello")
    expect(result.text).toContain("[redacted]")
    expect(result.text).not.toContain(KEY)
    // The API got the key itself.
    expect(api.requests.at(-1)!.url).toContain(`key=${KEY}`)
  })

  it("says, when it fails, the run, why, and the calls that change things that completed", async () => {
    const { id: notesId } = await createEndpoint(ctx, {
      name: "Notes",
      specSource: "upload",
      specText: JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Notes", version: "1" },
        servers: [{ url: api.origin }],
        paths: {
          "/notes": {
            post: {
              operationId: "add_note",
              summary: "Adds a note",
              responses: { "200": { description: "ok" } },
            },
          },
        },
      }),
      readOnly: false,
      authType: "none",
    })
    await writeToolAccess(scope.tokenId, notesId, "add_note", "allowed")
    const wrapper = await approvedWrapper({
      ...ECHO_TOOL,
      program: `
        await pcp.call("things", "echo", { key: { $secret: "Things key" }, q: args.word })
        await pcp.call("notes", "add_note", {})
        console.log("noted")
        throw new Error("then it broke")
      `,
      calls: ["things/echo", "notes/add_note"],
    })
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")

    const result = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: { word: "hello" },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain("lookup/lookup failed: Error: then it broke")
    expect(result.text).toContain("It printed:\nnoted")
    expect(result.text).toMatch(
      /Run run_[0-9a-f]{16}: failed\. Exit reason: uncaught error\./,
    )
    // The read is not listed; the note it added is.
    expect(result.text).toContain(
      "Calls that change things and completed:\n- notes/add_note: ok",
    )
    expect(result.text).not.toContain("things/echo")
    expect(result.text).toContain("Some of this run may have taken effect")
    expect(result.text).not.toContain(KEY)
  })

  it("checks the arguments against the tool's schema", async () => {
    const wrapper = await approvedWrapper()
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")

    const result = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('"word" is missing')
    expect(api.requests).toHaveLength(0)
  })

  it("refuses a secret in a place the owner did not allow, before anything is sent", async () => {
    const wrapper = await approvedWrapper({
      ...ECHO_TOOL,
      program:
        'return await pcp.call("things", "echo", { key: "x", q: { $secret: "Things key" } })',
    })
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")

    const result = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: { word: "hello" },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('has not allowed the secret "Things key"')
    expect(api.requests).toHaveLength(0)
  })

  it("refuses a call its tool does not list", async () => {
    const wrapper = await approvedWrapper({
      ...ECHO_TOOL,
      program: 'return await pcp.call("things", "count", {})',
    })
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")

    const result = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: { word: "hello" },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain("things/count is not one of them")
    expect(api.requests).toHaveLength(0)
  })

  it("never takes a secret placeholder from an assistant", async () => {
    await approvedWrapper()
    const result = await call("call_tool", {
      server: "things",
      tool: "echo",
      arguments: { key: { $secret: "Things key" } },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain("not taken from you")
    expect(api.requests).toHaveLength(0)
  })

  it("asks while a tool it calls asks, and runs it once the owner allows the call", async () => {
    const wrapper = await approvedWrapper(ECHO_TOOL, { callLevels: "token" })
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")
    await writeToolAccess(scope.tokenId, endpointId, "echo", "ask")

    const listed = await call("list_tools", { server: "lookup" })
    expect(listed.text).toMatch(/lookup.*ask/)

    const asked = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: { word: "hi" },
    })
    expect(asked.text).toContain("Not done yet")
    const row = await newestRequest()
    const view = await getPermissionView(ctx, row.id, {
      publicUrl: PUBLIC_URL,
    })
    expect(view!.lines.join("\n")).toContain("which may call: things/echo")
    // An approved run calls an asking tool as often as its program does.
    expect(view!.lines.join("\n")).toContain(
      `may call it as often as it does (at most ${MAX_CALLS_PER_RUN} calls in all)`,
    )

    const ran = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
    })
    expect(ran.isError).not.toBe(true)
    const outcome = await call("check_permission", { id: row.id })
    expect(outcome.text).toContain("q=hi")
    expect(outcome.text).not.toContain(KEY)
  })

  it("is blocked for a token wherever a tool it calls is", async () => {
    const wrapper = await approvedWrapper(ECHO_TOOL, { callLevels: "token" })
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")
    await writeToolAccess(scope.tokenId, endpointId, "echo", "blocked")

    // Described before, so its handle is genuine; blocked now all the same.
    const result = await call("call_tool", {
      call_handle: await catalogueHandle(scope, "lookup", "lookup"),
      arguments: { word: "hi" },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain("blocked")
  })
})

describe("what a wrapper replaces", () => {
  it("leaves the replaced tool out of search and lists, still callable", async () => {
    const before = await call("search", { query: "says back" })
    expect(before.text).toContain("things/echo")

    await approvedWrapper()

    const search = await call("search", { query: "says back" })
    expect(search.text).not.toContain("things/echo")
    const listed = await call("list_tools", { server: "things" })
    expect(listed.text).not.toContain("echo")
    expect(listed.text).toContain("count")
    const described = await call("describe", {
      server: "things",
      tool: "echo",
    })
    expect(described.text).toContain('"replacedBy": "lookup/lookup"')

    const direct = await call("call_tool", {
      server: "things",
      tool: "echo",
      arguments: { key: "mine", q: "x" },
    })
    expect(direct.isError).toBe(false)
  })
})

describe("changing a wrapper", () => {
  it("shows the change before and after, and makes it only as it was asked", async () => {
    await approvedWrapper()
    const read = await call("get_wrapper", { wrapper: "lookup" })
    expect(read.text).toContain('"program"')
    expect(read.text).not.toContain(KEY)

    const asked = await call("update_wrapper", {
      wrapper: "lookup",
      tools: [{ ...ECHO_TOOL, program: 'return "changed"' }],
    })
    expect(asked.text).toContain("Not done yet")
    const row = await newestRequest()
    const view = await getPermissionView(ctx, row.id, {
      publicUrl: PUBLIC_URL,
    })
    expect(view!.wrapper!.tools[0]).toMatchObject({
      status: "changed",
      program: 'return "changed"',
      previousProgram: ECHO_TOOL.program,
    })
    // The binding the owner approved keeps its secret: nothing to type in.
    expect(view!.secretToEnter).toBeNull()

    // A change the owner makes in between wins: the request no longer applies.
    await db().mcpServer.updateMany({
      where: { kind: "wrapper" },
      data: { description: "Changed by the owner." },
    })
    const stale = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
    })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.content)).toContain("has changed since")
  })

  it("deletes a wrapper only when the owner agrees, keeping the request", async () => {
    await approvedWrapper()
    await call("delete_wrapper", { wrapper: "lookup" })
    expect(await db().mcpServer.count({ where: { kind: "wrapper" } })).toBe(1)

    const row = await newestRequest()
    await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
    })

    expect(await db().mcpServer.count({ where: { kind: "wrapper" } })).toBe(0)
    expect(
      await db().permissionRequest.findUnique({ where: { id: row.id } }),
    ).toMatchObject({ status: "executed" })
  })

  it("uses a secret the owner holds by name, with nothing to type in", async () => {
    await createSecret(ctx, { name: "Things key", value: KEY })
    await call("create_wrapper", {
      name: "Lookup",
      tools: [ECHO_TOOL],
      secrets: [
        { secret: "Things key", tool: "things/echo", argument: "/key" },
      ],
    })
    const row = await newestRequest()
    const view = await getPermissionView(ctx, row.id, {
      publicUrl: PUBLIC_URL,
    })

    expect(view!.secretToEnter).toBeNull()
    expect(view!.wrapper!.secrets[0]!.isNew).toBe(false)
  })
})

describe("what an assistant can set", () => {
  it("takes a tool out and renames the wrapper, shown before it is made", async () => {
    await approvedWrapper()
    await call("update_wrapper", {
      wrapper: "lookup",
      tools: [
        {
          ...ECHO_TOOL,
          name: "count",
          description: "Counts things.",
          program: 'return pcp.call("things", "count", {})',
          calls: ["things/count"],
          replaces: [],
        },
      ],
    })
    const added = await newestRequest()
    await decidePermission(ctx, added.id, "allow_once", {
      publicUrl: PUBLIC_URL,
    })

    await call("update_wrapper", {
      wrapper: "lookup",
      name: "Counter",
      removeTools: ["lookup"],
      secrets: [],
    })
    const row = await newestRequest()
    const view = await getPermissionView(ctx, row.id, {
      publicUrl: PUBLIC_URL,
    })

    expect(view!.title).toBe("Change the wrapper Lookup?")
    expect(view!.lines).toContain("New name: Counter")
    expect(
      view!.wrapper!.tools.map((tool) => [tool.name, tool.status]),
    ).toEqual([
      ["count", "same"],
      ["lookup", "removed"],
    ])
    expect(view!.wrapper!.secrets).toEqual([])

    await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
    })
    const server = await db().mcpServer.findFirstOrThrow({
      where: { kind: "wrapper" },
      include: { tools: true },
    })
    expect(server.name).toBe("Counter")
    expect(server.tools.map((tool) => tool.name)).toEqual(["count"])

    // Nothing stands in for things/echo any more: it is back in search.
    const search = await call("search", { query: "says back" })
    expect(search.text).toContain("things/echo")
  })

  it("refuses a schema that is not an object's, and hints it does not know", async () => {
    const schema = await call("create_wrapper", {
      name: "Lookup",
      tools: [{ ...ECHO_TOOL, inputSchema: { type: "string" } }],
    })
    expect(schema.isError).toBe(true)
    expect(schema.text).toContain("JSON Schema for an object")

    const hidden = await call("create_wrapper", {
      name: "Lookup",
      tools: [{ ...ECHO_TOOL, description: "Looks‮ up" }],
    })
    expect(hidden.isError).toBe(true)
    expect(hidden.text).toContain("U+202E")
  })

  it("refuses what draws nothing where the owner reads a name, and drops emoji selectors from prose", async () => {
    const secrets = [
      { secret: "Things key", tool: "things/echo", argument: "/key" },
    ]
    // A Hangul filler is a letter, so "anㅤswer" is a name of its own
    // that reads as "answer".
    const program = await call("create_wrapper", {
      name: "Lookup",
      tools: [
        {
          ...ECHO_TOOL,
          program: `const anㅤswer = 1; ${ECHO_TOOL.program}`,
        },
      ],
      secrets,
    })
    expect(program.isError).toBe(true)
    expect(program.text).toContain("U+3164")
    expect(program.text).toContain("as an escape")

    const selector = await call("create_wrapper", {
      name: "Lookup",
      tools: [{ ...ECHO_TOOL, program: `// ✔️\n${ECHO_TOOL.program}` }],
      secrets,
    })
    expect(selector.text).toContain("U+FE0F")

    const name = await call("create_wrapper", {
      name: "Look͏up",
      tools: [ECHO_TOOL],
      secrets,
    })
    expect(name.isError).toBe(true)
    expect(name.text).toContain("U+034F")

    const argument = await call("create_wrapper", {
      name: "Lookup",
      tools: [ECHO_TOOL],
      secrets: [{ ...secrets[0], argument: "/k᠋ey" }],
    })
    expect(argument.isError).toBe(true)
    expect(argument.text).toContain("U+180B")

    const prose = await call("create_wrapper", {
      name: "Lookup ✔️",
      description: "Things, simpler ✔️",
      tools: [{ ...ECHO_TOOL, description: "Looks a word up ✔️" }],
      secrets,
    })
    expect(prose.text).toContain("Not done yet")
    const shown = JSON.stringify(
      await getPermissionView(ctx, (await newestRequest()).id, {
        publicUrl: PUBLIC_URL,
      }),
    )
    expect(shown).toContain("Lookup ✔")
    expect(shown).toContain("Looks a word up ✔")
    expect(shown).not.toContain("️")
  })

  it("refuses to change a tool it is not given, and a change that changes nothing", async () => {
    await approvedWrapper()
    const missing = await call("update_wrapper", {
      wrapper: "lookup",
      removeTools: ["nope"],
    })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain("no tool called nope")

    const same = await call("update_wrapper", {
      wrapper: "lookup",
      tools: [ECHO_TOOL],
    })
    expect(same.isError).toBe(true)
    expect(same.text).toContain("would not change")
  })
})

describe("calling a wrapper's tool as read-only", () => {
  it("counts only when every tool it calls only reads", async () => {
    const wrapper = await approvedWrapper({
      ...ECHO_TOOL,
      annotations: { readOnlyHint: true },
    })
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")
    const args = {
      server: "lookup",
      tool: "lookup",
      arguments: { word: "hi" },
    }

    // An API's GET only reads, so the wrapper's tool does too.
    const read = await call("call_read_only_tool", args)
    expect(read.isError, read.text).toBe(false)

    // Once the tool it calls is not marked so, its own word is not enough.
    await db().mcpTool.updateMany({
      where: { serverId: endpointId, name: "echo" },
      data: { annotations: JSON.stringify({ readOnlyHint: false }) },
    })
    const refused = await call("call_read_only_tool", args)
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain("not marked read-only")
  })
})

const SHAPE = {
  type: "object",
  properties: { got: { type: "string" } },
  required: ["got"],
  additionalProperties: false,
}

describe("a tool's output schema", () => {
  it("shows the owner the shape, outlines it for assistants and passes an answer that fits", async () => {
    await call("create_wrapper", {
      name: "Lookup",
      tools: [{ ...ECHO_TOOL, outputSchema: SHAPE }],
      secrets: [
        { secret: "Things key", tool: "things/echo", argument: "/key" },
      ],
    })
    const row = await newestRequest()
    const view = await getPermissionView(ctx, row.id, {
      publicUrl: PUBLIC_URL,
    })
    expect(view!.wrapper!.tools[0]!.outputSchema).toContain('"got"')
    await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
      secretValue: KEY,
    })

    const wrapper = await db().mcpServer.findFirstOrThrow({
      where: { kind: "wrapper" },
    })
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")

    const described = await call("describe", {
      server: "lookup",
      tool: "lookup",
    })
    expect(described.text).toContain('"returns": "{got: string}"')

    const read = await call("get_wrapper", { wrapper: "lookup" })
    expect(read.text).toContain('"outputSchema"')

    const result = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: { word: "hello" },
    })
    expect(result.isError).toBe(false)
    expect(result.text).toContain("q=hello")
  })

  it("makes an answer that does not fit an error, naming where", async () => {
    const wrapper = await approvedWrapper({
      ...ECHO_TOOL,
      outputSchema: {
        type: "object",
        properties: { got: { type: "number" } },
      },
    })
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")

    const result = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: { word: "hello" },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain("outputSchema does not allow")
    expect(result.text).toContain('"/got" is string')
    expect(result.text).not.toContain(KEY)
  })

  it("is an error when the program returns nothing but the tool declares an answer", async () => {
    const wrapper = await approvedWrapper({
      ...ECHO_TOOL,
      program: "await 1",
      outputSchema: SHAPE,
    })
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")

    const result = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: { word: "hello" },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain("returned nothing")
  })

  it("refuses a schema that is not a schema, or follows a reference", async () => {
    for (const outputSchema of [
      [],
      {},
      "object",
      { type: "object", properties: { a: { $ref: "#/$defs/a" } } },
    ]) {
      const result = await call("create_wrapper", {
        name: "Lookup",
        tools: [{ ...ECHO_TOOL, outputSchema }],
      })

      expect(result.isError, JSON.stringify(outputSchema)).toBe(true)
    }

    const ref = await call("create_wrapper", {
      name: "Lookup",
      tools: [
        {
          ...ECHO_TOOL,
          outputSchema: {
            type: "object",
            properties: { a: { $ref: "#/$defs/a" } },
          },
        },
      ],
    })
    expect(ref.text).toContain("$ref")
    expect(await db().mcpServer.count({ where: { kind: "wrapper" } })).toBe(0)
  })

  it("is stored only when a tool declares one, so older definitions read as they were", async () => {
    await approvedWrapper(ECHO_TOOL, { callLevels: "token" })
    const spec = await db().wrapperSpec.findFirstOrThrow()
    const stored = JSON.parse(spec.definition) as {
      tools: Array<Record<string, unknown>>
    } & Record<string, unknown>

    expect("outputSchema" in stored.tools[0]!).toBe(false)
    expect("callLevels" in stored).toBe(false)
  })
})

describe("whose levels a wrapper's calls follow", () => {
  it("runs on the owner's approval by default, whatever the token's levels for its calls", async () => {
    const wrapper = await approvedWrapper()
    expect(
      JSON.parse((await db().wrapperSpec.findFirstOrThrow()).definition),
    ).toMatchObject({ callLevels: "approved" })
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")

    // Asking and blocked for the token do not reach the wrapper's calls.
    for (const level of ["ask", "blocked"] as const) {
      await writeToolAccess(scope.tokenId, endpointId, "echo", level)
      const result = await call("call_tool", {
        server: "lookup",
        tool: "lookup",
        arguments: { word: level },
      })

      expect(result.isError, result.text).toBe(false)
      expect(result.text).toContain(`q=${level}`)
    }

    const described = await call("describe", {
      server: "lookup",
      tool: "lookup",
    })
    expect(described.text).toContain('"access": "allowed"')
  })

  it("needs the token to reach the wrapper only, not the server behind it", async () => {
    const wrapper = await approvedWrapper()
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")
    scope = { ...scope, serverIds: [wrapper.id] }

    const listed = await call("list_tools", { server: "things" })
    expect(listed.isError).toBe(true)

    const result = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: { word: "hidden" },
    })
    expect(result.isError, result.text).toBe(false)
    expect(result.text).toContain("q=hidden")
  })

  it("still allows only the calls a tool lists, and a server that is switched on", async () => {
    const wrapper = await approvedWrapper({
      ...ECHO_TOOL,
      program: 'return await pcp.call("things", "count", {})',
    })
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")

    const unlisted = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: { word: "x" },
    })
    expect(unlisted.isError).toBe(true)
    expect(unlisted.text).toContain("things/count is not one of them")

    await db().mcpServer.update({
      where: { id: endpointId },
      data: { enabled: false },
    })
    const off = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: { word: "x" },
    })
    expect(off.isError).toBe(true)
    expect(api.requests).toHaveLength(0)
  })

  it("tells the owner which calls a token can make through it, and says so on the request", async () => {
    await call("create_wrapper", { name: "Lookup", tools: [ECHO_TOOL] })
    const view = await getPermissionView(ctx, (await newestRequest()).id, {
      publicUrl: PUBLIC_URL,
    })

    expect(view!.wrapper!.callLevels).toBe("approved")
    expect(view!.warning).toContain(
      "whatever its own levels for things/echo are",
    )
    expect(view!.lines.join("\n")).toContain("approved here")

    const token = await call("create_wrapper", {
      name: "Narrow",
      callLevels: "token",
      tools: [ECHO_TOOL],
    })
    expect(token.text).toContain("Not done yet")
    const narrow = await getPermissionView(ctx, (await newestRequest()).id, {
      publicUrl: PUBLIC_URL,
    })
    expect(narrow!.wrapper!.callLevels).toBe("token")
    expect(narrow!.warning).toBeNull()
  })

  it("keeps the mode on a change, and shows a change of it", async () => {
    await approvedWrapper(ECHO_TOOL, { callLevels: "token" })

    await call("update_wrapper", {
      wrapper: "lookup",
      description: "Changed.",
    })
    const kept = await getPermissionView(ctx, (await newestRequest()).id, {
      publicUrl: PUBLIC_URL,
    })
    expect(kept!.wrapper!.callLevels).toBe("token")

    await call("update_wrapper", { wrapper: "lookup", callLevels: "approved" })
    const changed = await getPermissionView(ctx, (await newestRequest()).id, {
      publicUrl: PUBLIC_URL,
    })
    expect(changed!.wrapper!.callLevels).toBe("approved")
    expect(changed!.lines.join("\n")).toContain(
      "now follow your approval of the wrapper",
    )
    expect(changed!.warning).toContain("things/echo")

    const read = await call("get_wrapper", { wrapper: "lookup" })
    expect(read.text).toContain('"callLevels": "token"')
  })

  it("refuses a mode that is neither", async () => {
    const result = await call("create_wrapper", {
      name: "Lookup",
      callLevels: "anything",
      tools: [ECHO_TOOL],
    })

    expect(result.isError).toBe(true)
    expect(await db().mcpServer.count({ where: { kind: "wrapper" } })).toBe(0)
  })
})

/** A browser flow's tool, as an assistant writes one after doing it once. */
const FLOW_TOOL = {
  name: "post_message",
  description: "Posts a message in a chat thread, unless it is there already.",
  inputSchema: {
    type: "object",
    properties: {
      thread: { type: "string" },
      text: { type: "string" },
      next: { type: "string" },
    },
    required: ["thread", "text"],
  },
  program: `
    const opened = await pcp.step("open the thread", () =>
      pcp.call("browser", "tabs", { action: "open", url: \`https://chat.example.com/t/\${args.thread}\` }))
    const tab = opened.match(/^Tab (\\S+):/m)[1]
    await pcp.step("write it", () =>
      pcp.call("browser", "type", { tab, target: { role: "textbox", name: "Message" }, text: args.text }))
    await pcp.step("send it", () =>
      pcp.call("browser", "click", { tab, target: { role: "button", name: "Send" } }))
    if (args.next) await pcp.call("browser", "navigate", { tab, url: args.next })
    return { ok: true, url: "https://chat.example.com/t/" + args.thread }
  `,
  calls: ["browser/tabs", "browser/type", "browser/click", "browser/navigate"],
}

const READ_FLOW_TOOL = {
  name: "read_thread",
  description: "Reads a chat thread.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  program:
    'const opened = await pcp.call("browser", "tabs", { action: "open", url: "https://chat.example.com/" }); return opened',
  calls: ["browser/tabs"],
}

const PLAIN_TOOL = {
  name: "lookup",
  description: "Looks a word up.",
  inputSchema: { type: "object", properties: { word: { type: "string" } } },
  program:
    'return await pcp.call("things", "echo", { key: "k", q: args.word })',
  calls: ["things/echo"],
}

/** Proposes a wrapper of these tools and has the owner agree. */
async function approved(
  tools: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) {
  const asked = await call("create_wrapper", {
    name: "Chat",
    description: "The chat, one call at a time.",
    tools,
    ...extra,
  })
  expect(asked.text).toContain("Not done yet")
  const row = await newestRequest()
  const view = await getPermissionView(ctx, row.id, { publicUrl: PUBLIC_URL })
  const result = await decidePermission(ctx, row.id, "allow_once", {
    publicUrl: PUBLIC_URL,
  })
  expect(result.isError).not.toBe(true)

  return {
    view: view!,
    wrapper: await db().mcpServer.findFirstOrThrow({
      where: { kind: "wrapper" },
    }),
  }
}

describe("a browser flow", () => {
  beforeEach(async () => {
    await createBrowserServer(ctx)
  })

  it("is a wrapper with a tool that calls the browser, told apart without being stored", async () => {
    const { view, wrapper } = await approved([FLOW_TOOL, PLAIN_TOOL])
    const definition = readDefinition(
      (await db().wrapperSpec.findFirstOrThrow()).definition,
    )
    const browsers = await browserServerIds(ctx)

    expect(isFlow(definition, browsers)).toBe(true)
    expect(
      definition.tools.map((tool) => [tool.name, isFlowTool(tool, browsers)]),
    ).toEqual([
      ["post_message", true],
      ["lookup", false],
    ])
    expect(isFlow(definition, new Set())).toBe(false)
    expect(Object.keys(definition)).not.toContain("flow")
    expect(await flowWrapperIds(ctx)).toEqual(new Set([wrapper.id]))

    // The owner's review says so, and lists what the program opens.
    expect(view.wrapper!.flow).toBe(true)
    expect(view.lines.join("\n")).toContain("A browser flow")
    const [flowTool, plainTool] = view.wrapper!.tools
    expect(flowTool).toMatchObject({
      flow: true,
      sites: {
        sites: ["chat.example.com"],
        fromArguments: true,
        computed: false,
      },
    })
    expect(plainTool!.flow).toBe(false)
    expect(plainTool!.sites).toBeUndefined()

    const read = await call("get_wrapper", { wrapper: "chat" })
    expect(read.text).toContain('"flow": true')
  })

  it("may type a secret with the browser's type, as its text and nowhere else", async () => {
    const { id } = await createSecret(ctx, {
      name: "Chat password",
      value: "hunter2-chat",
    })
    await createSecret(ctx, {
      name: "Chat codes",
      value: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      kind: "totp",
    })
    const flow = {
      ...FLOW_TOOL,
      program: FLOW_TOOL.program.replace(
        "text: args.text",
        'text: { $secret: "Chat password" }',
      ),
    }
    const propose = (binding: Record<string, unknown>) =>
      call("create_wrapper", {
        name: "Chat",
        description: "The chat, one call at a time.",
        tools: [flow],
        secrets: [{ secret: "Chat password", ...binding }],
      })

    for (const binding of [
      { tool: "browser/click", argument: "/target" },
      { tool: "browser/type", argument: "/tab" },
      {
        tool: "browser/type",
        argument: "/text",
        template: "Bearer {{secret}}",
      },
    ]) {
      const refused = await propose(binding)
      expect(refused.isError, JSON.stringify(binding)).toBe(true)
      expect(refused.text).toContain("only as type's text")
    }

    // A one-time codes secret goes to the browser only, never to an API.
    const toApi = await call("create_wrapper", {
      name: "Lookup",
      description: "Things, simpler.",
      tools: [ECHO_TOOL],
      secrets: [
        { secret: "Chat codes", tool: "things/echo", argument: "/key" },
      ],
    })
    expect(toApi.isError).toBe(true)
    expect(toApi.text).toContain('"Chat codes" is not one PCP sends')

    await approved([flow], {
      secrets: [
        { secret: "Chat password", tool: "browser/type", argument: "/text" },
      ],
    })
    const definition = readDefinition(
      (await db().wrapperSpec.findFirstOrThrow()).definition,
    )
    expect(definition.secrets).toEqual([
      expect.objectContaining({
        secret: "Chat password",
        secretId: id,
        tool: "type",
        argument: "/text",
        template: "{{secret}}",
      }),
    ])
  })

  it("takes a secret from an assistant only as the browser's type text", async () => {
    const browser = await db().mcpServer.findFirstOrThrow({
      where: { kind: "browser" },
    })
    await writeToolAccess(scope.tokenId, browser.id, "type", "allowed")
    await writeToolAccess(scope.tokenId, browser.id, "press_key", "allowed")

    const pressed = await call("call_tool", {
      server: "browser",
      tool: "press_key",
      arguments: { tab: "t1", key: { $secret: "Chat password" } },
    })
    expect(pressed.isError).toBe(true)
    expect(pressed.text).toContain("not taken from you here")

    // Through to the browser, which has no such tab: nothing was refused
    // for the secret on the way.
    const typed = await call("call_tool", {
      server: "browser",
      tool: "type",
      arguments: { tab: "t1", ref: "e1", text: { $secret: "Chat password" } },
    })
    expect(typed.text).not.toContain("not taken from you")
    expect(typed.text).toContain("There is no tab t1")
  })

  it("is not one without a browser call", async () => {
    const { view } = await approved([PLAIN_TOOL])

    expect(view.wrapper!.flow).toBe(false)
    expect(view.lines.join("\n")).not.toContain("browser flow")
    expect(await flowWrapperIds(ctx)).toEqual(new Set())
  })

  it("asks first by default, read-only or not, and keeps every level the owner set", async () => {
    const { wrapper } = await approved([FLOW_TOOL, READ_FLOW_TOOL])
    const levels = async () =>
      (await loadGatewayServers(scope))
        .find((server) => server.id === wrapper.id)!
        .tools.map((tool) => [tool.name, tool.access])

    // Nothing the owner set: a flow that acts asks; one that only reads
    // has every tool's default, which asks too.
    expect(DEFAULT_TOOL_ACCESS).toBe("ask")
    expect(await levels()).toEqual([
      ["post_message", "ask"],
      ["read_thread", DEFAULT_TOOL_ACCESS],
    ])
    const asked = await call("call_tool", {
      server: "chat",
      tool: "post_message",
      arguments: { thread: "1", text: "hi" },
    })
    expect(asked.text).toContain("Not done yet")

    // What the owner set stays as they set it.
    await writeToolAccess(scope.tokenId, wrapper.id, "post_message", "allowed")
    await writeToolAccess(scope.tokenId, wrapper.id, "read_thread", "blocked")
    expect(await levels()).toEqual([
      ["post_message", "allowed"],
      ["read_thread", "blocked"],
    ])
  })

  it("runs longer than other wrappers, and still ends before a program that calls it", async () => {
    const actual = await vi.importActual<typeof import("./limits")>("./limits")

    expect(actual.FLOW_RUN_TIMEOUT_MS).toBeGreaterThan(
      actual.WRAPPER_RUN_TIMEOUT_MS,
    )
    expect(actual.FLOW_RUN_TIMEOUT_MS).toBeLessThan(RUN_TIMEOUT_MS)
    expect(wrapperRunTimeout(true)).toBe(FLOW_RUN_TIMEOUT_MS)
    expect(wrapperRunTimeout(false)).toBe(WRAPPER_RUN_TIMEOUT_MS)

    // Each run gets its own: a program that waits until it is stopped.
    timeouts.wrapper = 1_000
    timeouts.flow = 2_000
    codeExecutor = ({ signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", () =>
          resolve({
            kind: "error",
            message: String(signal.reason),
            output: "",
            dropped: 0,
          }),
        ),
      )
    const { wrapper } = await approved([FLOW_TOOL, PLAIN_TOOL])
    await writeToolAccess(scope.tokenId, wrapper.id, "post_message", "allowed")
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")

    const plain = await call("call_tool", {
      server: "chat",
      tool: "lookup",
      arguments: { word: "x" },
    })
    expect(plain.text).toContain("took longer than 1 seconds")

    const flow = await call("call_tool", {
      server: "chat",
      tool: "post_message",
      arguments: { thread: "1", text: "hi" },
    })
    expect(flow.text).toContain("took longer than 2 seconds")
  })
})

describe("a wrapper's steps", () => {
  it("names the step that failed in the answer, and the step of each call", async () => {
    const { wrapper } = await approved([
      {
        ...PLAIN_TOOL,
        program: `
          await pcp.step("look it up", () => pcp.call("things", "echo", { key: "k", q: args.word }))
          await pcp.step("check the answer", async () => { throw new Error("not what was asked") })
        `,
        calls: ["things/echo"],
      },
    ])
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")

    const result = await call("call_tool", {
      server: "chat",
      tool: "lookup",
      arguments: { word: "hello" },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain(
      "chat/lookup failed: Error: failed at step 'check the answer': not what was asked",
    )
    expect(api.requests).toHaveLength(1)
  })
})

describe("a wrapper called from run_code", () => {
  beforeEach(async () => {
    const { token } = await createApiToken(ctx, {
      name: "Coder",
      allowAllServers: true,
      serverIds: [],
      manageWrappers: true,
      runCode: true,
    })
    scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  })

  it("runs in a run of its own, paced, linked both ways, with one program at a time", async () => {
    vi.stubEnv("PCP_PACING", "on")
    const waits: number[] = []
    let now = 1_000_000
    setPacingClock({
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms)
        now += ms
      },
      random: () => 0,
    })
    await setPacingServer(ctx, endpointId, {
      minIntervalMs: 5_000,
      jitterMs: 0,
      burst: null,
    })
    // One program at a time, of each: a wrapper's run is not run_code's.
    await saveResourceConfig({ ...EMPTY_CONFIG, programsAtOnce: 1 })
    const { wrapper } = await approved([
      PLAIN_TOOL,
      {
        ...PLAIN_TOOL,
        name: "broken",
        description: "Breaks.",
        program: 'throw new Error("it broke")',
      },
    ])
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")
    await writeToolAccess(scope.tokenId, wrapper.id, "broken", "allowed")

    const result = await call("run_code", {
      code: `
        const one = await pcp.call("chat", "lookup", { word: "one" })
        const two = await pcp.call("chat", "lookup", { word: "two" })
        try { await pcp.call("chat", "broken", {}) } catch (error) { console.log(error.message) }
        throw new Error(JSON.stringify([one, two]))
      `,
    })

    // Both ran, the second after the server's pause.
    expect(result.text).toContain("q=one")
    expect(result.text).toContain("q=two")
    expect(waits).toEqual([5_000])
    expect(api.requests).toHaveLength(2)

    // The outer run names each run it started, and the inner names it back.
    const outer = /Run (run_[0-9a-f]{16}): failed/.exec(result.text)![1]!
    const inner = [
      ...result.text.matchAll(/- chat\/lookup \(run (run_[0-9a-f]{16})\): ok/g),
    ].map((match) => match[1])
    expect(inner).toHaveLength(2)
    expect(inner).not.toContain(outer)
    expect(result.text).toContain("chat/broken failed: Error: it broke")
    expect(result.text).toMatch(
      new RegExp(`Run run_[0-9a-f]{16} \\(called from run ${outer}\\): failed`),
    )
  })
})

describe("the sites a flow opens", () => {
  it("reads literals and fixed starts, and says when an address comes from elsewhere", () => {
    expect(
      flowSites(
        `await pcp.call("browser", "tabs", { action: "open", url: "https://mail.example.com/inbox" })
         await pcp.call('browser', 'navigate', { tab, url: 'https://mail.example.com/compose' })
         await pcp.call("browser", "navigate", { tab, "url": \`https://shop.example.com:8443/\${args.item}\` })
         await pcp.call("other", "navigate", { url: "https://elsewhere.example.com" })
         await pcp.call("browser", "click", { url: "https://not-opened.example.com" })`,
        ["browser"],
      ),
    ).toEqual({
      sites: ["mail.example.com", "shop.example.com:8443"],
      fromArguments: false,
      computed: false,
    })

    expect(
      flowSites(
        'await pcp.call("browser", "navigate", { tab, url: args.address })',
        ["browser"],
      ),
    ).toMatchObject({ sites: [], fromArguments: true, computed: false })

    // A host that is not ended yet is not one.
    expect(
      flowSites(
        'await pcp.call("browser", "navigate", { tab, url: `https://ex${args.tld}` })',
        ["browser"],
      ),
    ).toMatchObject({ sites: [], fromArguments: true })

    for (const program of [
      'await pcp.call("browser", "navigate", { tab, url })',
      'await pcp.call("browser", "navigate", { tab, url: links[0] })',
      'await pcp.call(server, "navigate", { tab, url: "https://a.example.com" })',
      'await pcp.call("browser", "navigate", options)',
    ]) {
      expect(flowSites(program, ["browser"]).computed, program).toBe(true)
    }

    // Commas and brackets inside strings and comments do not confuse it.
    expect(
      flowSites(
        `await pcp.call("browser", /* "tabs", */ "navigate", { tab, note: "a, b)", url: "https://x.example.com/?q=(1,2)" })`,
        ["browser"],
      ).sites,
    ).toEqual(["x.example.com"])
  })
})

describe("what an assistant is told about flows", () => {
  it("tells a token with the browser and wrappers how to write one, and no other", async () => {
    await createBrowserServer(ctx)
    const servers = await loadGatewayServers(scope)
    const told = buildInstructions(servers, { manageWrappers: true })

    expect(told).toContain("Browser flows:")
    expect(told).toContain("never by ref")
    expect(told).toContain("{already: true}")
    expect(told).toContain("browser/hand_over")
    expect(buildInstructions(servers, {})).not.toContain("Browser flows:")
    expect(
      buildInstructions(
        servers.filter((server) => server.kind !== "browser"),
        { manageWrappers: true },
      ),
    ).not.toContain("Browser flows:")

    const listed = await connect()
    const { tools } = await listed.listTools()
    const create = tools.find((tool) => tool.name === "create_wrapper")!
    expect(create.description).toContain("browser flow")
  })
})
