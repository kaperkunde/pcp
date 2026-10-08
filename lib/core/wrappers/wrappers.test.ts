import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
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
import { writeToolAccess } from "../tool-access"
import { setupVault } from "../vault"

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
})

/** A gateway for the token as it is now, as each request builds one. */
async function connect(): Promise<Client> {
  await client?.close()
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
    serverSide,
  )
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  return client
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await (await connect()).callTool({ name, arguments: args })
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
  } = ECHO_TOOL,
) {
  const asked = await call("create_wrapper", {
    name: "Lookup",
    description: "Things, simpler.",
    tools: [tool],
    secrets: [{ secret: "Things key", tool: "things/echo", argument: "/key" }],
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

  it("checks the arguments against the tool's schema", async () => {
    const wrapper = await approvedWrapper()
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")

    const result = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('"word" is required')
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
    const wrapper = await approvedWrapper()
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

    const ran = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
    })
    expect(ran.isError).not.toBe(true)
    const outcome = await call("check_permission", { id: row.id })
    expect(outcome.text).toContain("q=hi")
    expect(outcome.text).not.toContain(KEY)
  })

  it("is blocked for a token wherever a tool it calls is", async () => {
    const wrapper = await approvedWrapper()
    await writeToolAccess(scope.tokenId, wrapper.id, "lookup", "allowed")
    await writeToolAccess(scope.tokenId, endpointId, "echo", "blocked")

    const result = await call("call_tool", {
      server: "lookup",
      tool: "lookup",
      arguments: { word: "hi" },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain("blocked")
  })
})

describe("what a wrapper replaces", () => {
  it("leaves the replaced tool out of search and lists, still callable", async () => {
    const before = await call("search_tools", { query: "says back" })
    expect(before.text).toContain("things/echo")

    await approvedWrapper()

    const search = await call("search_tools", { query: "says back" })
    expect(search.text).not.toContain("things/echo")
    const listed = await call("list_tools", { server: "things" })
    expect(listed.text).not.toContain("echo")
    expect(listed.text).toContain("count")
    const described = await call("describe_tool", {
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
    const search = await call("search_tools", { query: "says back" })
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
