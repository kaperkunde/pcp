import { randomBytes, randomUUID } from "node:crypto"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import {
  base32,
  checkCallHandle,
  fromBase32,
  makeCallHandle,
  parseCallHandle,
} from "./call-handles"
import type { VaultContext } from "./context"
import { db } from "./db"
import {
  buildGatewayServer,
  loadGatewayServers,
  type GatewayScope,
} from "./gateway"
import type { PermissionExecutor } from "./permissions"
import { appendRequestLog } from "./request-log"
import { createServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { describedHandle } from "./test-handles"
import { writeToolAccess } from "./tool-access"
import { setupVault } from "./vault"
import { checkArguments } from "./wrappers/schema-check"

// call_tool takes the call_handle describe gives, never a server and a
// tool name: a tool is described before it is called, a handle goes stale
// with its schema, and arguments that cannot work never reach the owner.

vi.mock("./request-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./request-log")>()),
  appendRequestLog: vi.fn(async () => {}),
}))

let cleanup: () => Promise<void>
let ctx: VaultContext
let scope: GatewayScope
let serverId: string
let ran: Array<{ tool: string; args: unknown }>

const executor: PermissionExecutor = {
  callTool: async (_ctx, _server, tool, args) => {
    ran.push({ tool, args })
    return { content: [{ type: "text", text: `ran ${tool}` }] }
  },
  syncTools: async () => ({ status: "ok", message: "", toolCount: 0 }),
}

const SEND_SCHEMA = {
  type: "object",
  properties: {
    to: { type: "string" },
    copies: { type: "integer" },
    size: { enum: ["A6", "A5"] },
  },
  required: ["to"],
  additionalProperties: false,
}

const TOOLS: Array<{ name: string; schema: unknown; annotations?: unknown }> = [
  {
    name: "list_cards",
    schema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  { name: "send_postcard", schema: SEND_SCHEMA },
  { name: "ask_postcard", schema: SEND_SCHEMA },
]

async function tokenScope(name: string): Promise<GatewayScope> {
  const { token } = await createApiToken(ctx, { name, allowAllServers: true })
  const resolved = (await resolveApiToken(token))!

  for (const tool of ["list_cards", "send_postcard"]) {
    await writeToolAccess(resolved.tokenId, serverId, tool, "allowed")
  }

  return { ...resolved, publicUrl: "http://localhost:3000" }
}

/** A gateway for a token as it is now, as each request builds one. */
async function connect(as: GatewayScope = scope): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(as, await loadGatewayServers(as), {
    executor,
  }).connect(serverSide)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  return client
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("")

  return { isError: result.isError === true, text }
}

/** The handle in an answer that describes a tool. */
function handleIn(text: string): string {
  const match = /"call_handle": "(ch_[a-z0-9_]+)"/.exec(text)
  expect(match, text).not.toBeNull()
  return match![1]!
}

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  ran = []
  vi.mocked(appendRequestLog).mockClear()
  ;({ id: serverId } = await createServer(ctx, {
    name: "Postcards",
    url: "https://postcards.example.com/mcp",
    authType: "none",
  }))

  for (const tool of TOOLS) {
    await db().mcpTool.create({
      data: {
        id: randomUUID(),
        serverId,
        name: tool.name,
        description: `${tool.name} does one thing.`,
        inputSchema: JSON.stringify(tool.schema),
        annotations: tool.annotations ? JSON.stringify(tool.annotations) : null,
      },
    })
  }

  scope = await tokenScope("Claude")
})

afterEach(async () => {
  await cleanup()
})

describe("base32", () => {
  it("round-trips bytes, and refuses what it did not write", () => {
    for (const length of [0, 1, 5, 10, 16, 26]) {
      const bytes = randomBytes(length)
      expect(fromBase32(base32(bytes))).toEqual(bytes)
    }

    expect(base32(Buffer.from("foobar"))).toBe("mzxw6ytboi")
    expect(fromBase32("MZXW6")).toBeNull()
    expect(fromBase32("mzxw6ytbo1")).toBeNull()
    // Bits past the last byte must be zero.
    expect(fromBase32("mzxw6ytboj")).toBeNull()
  })
})

describe("a call handle", () => {
  const target = {
    tokenId: "token-1",
    serverId: "server-1",
    toolId: randomUUID(),
    tool: "send_postcard",
    inputSchema: JSON.stringify(SEND_SCHEMA),
  }
  const dek = randomBytes(32)

  it("names no tool, and checks out for its target alone", () => {
    const handle = makeCallHandle(dek, target)

    expect(handle).toMatch(/^ch_[a-z2-7]+_[a-z2-7]+$/)
    expect(handle).not.toContain("send")
    const parsed = parseCallHandle(handle)!
    expect(parsed.toolId).toBe(target.toolId)
    expect(checkCallHandle(dek, parsed, target)).toBe("current")
    expect(
      checkCallHandle(dek, parsed, { ...target, tokenId: "token-2" }),
    ).toBe("invalid")
    expect(checkCallHandle(randomBytes(32), parsed, target)).toBe("invalid")
    // The same schema with its keys in another order is the same schema.
    expect(
      checkCallHandle(dek, parsed, {
        ...target,
        inputSchema: JSON.stringify({
          additionalProperties: false,
          required: ["to"],
          properties: SEND_SCHEMA.properties,
          type: "object",
        }),
      }),
    ).toBe("current")
    expect(
      checkCallHandle(dek, parsed, {
        ...target,
        inputSchema: JSON.stringify({ type: "object" }),
      }),
    ).toBe("stale")
  })

  it("is not parsed from a name or a broken text", () => {
    for (const text of [
      "postcards/send_postcard",
      "send_postcard",
      "ch_",
      "ch_abc",
      "ch_abc_def_ghi",
      `${makeCallHandle(dek, target)}x`,
    ]) {
      expect(parseCallHandle(text)).toBeNull()
    }
  })
})

describe("call_tool with a call handle", () => {
  it("runs the tool describe gave it for, and logs it by name", async () => {
    const client = await connect()
    const described = await call(client, "describe", {
      server: "postcards",
      tool: "send_postcard",
    })
    const handle = handleIn(described.text)
    expect(described.text.indexOf('"call_handle"')).toBeLessThan(
      described.text.indexOf('"inputSchema"'),
    )

    // Another request, as /mcp builds one each time: nothing is stored.
    const later = await connect()
    const result = await call(later, "call_tool", {
      call_handle: handle,
      arguments: { to: "Grace", copies: 2 },
    })

    expect(result).toEqual({ isError: false, text: "ran send_postcard" })
    expect(ran).toEqual([
      { tool: "send_postcard", args: { to: "Grace", copies: 2 } },
    ])
    expect(vi.mocked(appendRequestLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "call_tool",
        server: "postcards",
        upstreamTool: "send_postcard",
        ok: true,
      }),
    )
  })

  it("takes no server or tool name", async () => {
    const client = await connect()
    const { tools } = await client.listTools()

    for (const name of ["call_tool", "call_read_only_tool"]) {
      const schema = tools.find((tool) => tool.name === name)!.inputSchema
      expect(Object.keys(schema.properties ?? {})).not.toContain("server")
      expect(Object.keys(schema.properties ?? {})).not.toContain("tool")
      expect(schema.required).toContain("call_handle")
    }
  })

  it("answers a stale handle with the schema as it is now and a fresh handle", async () => {
    const client = await connect()
    const old = await describedHandle(client, "postcards", "send_postcard")
    await db().mcpTool.update({
      where: { serverId_name: { serverId, name: "send_postcard" } },
      data: {
        inputSchema: JSON.stringify({
          ...SEND_SCHEMA,
          properties: { ...SEND_SCHEMA.properties, from: { type: "string" } },
          required: ["to", "from"],
        }),
      },
    })

    const later = await connect()
    const stale = await call(later, "call_tool", {
      call_handle: old,
      arguments: { to: "Grace" },
    })

    expect(stale.isError).toBe(true)
    expect(stale.text).toContain("The tool changed since you described it")
    expect(stale.text).toContain('"from"')
    const fresh = handleIn(stale.text)
    expect(fresh).not.toBe(old)
    expect(ran).toEqual([])

    const result = await call(later, "call_tool", {
      call_handle: fresh,
      arguments: { to: "Grace", from: "Ada" },
    })
    expect(result.isError, result.text).toBe(false)
    expect(ran).toHaveLength(1)
  })

  it("refuses a handle whose MAC was changed or made up", async () => {
    const client = await connect()
    const handle = await describedHandle(client, "postcards", "send_postcard")
    // One character of the MAC changed (not the last, whose low bits pad).
    const at = handle.length - 5
    const tampered = `${handle.slice(0, at)}${handle[at] === "a" ? "b" : "a"}${handle.slice(at + 1)}`
    const ref = handle.split("_")[1]!

    for (const forged of [
      tampered,
      `ch_${ref}_${"a".repeat(52)}`,
      makeCallHandle(randomBytes(32), {
        tokenId: scope.tokenId,
        serverId,
        toolId: parseCallHandle(handle)!.toolId,
        tool: "send_postcard",
        inputSchema: JSON.stringify(SEND_SCHEMA),
      }),
    ]) {
      const result = await call(client, "call_tool", {
        call_handle: forged,
        arguments: { to: "Grace" },
      })

      expect(result.isError).toBe(true)
      expect(result.text).toContain("not one describe gave this token")
      expect(result.text).not.toContain('"inputSchema"')
    }

    expect(ran).toEqual([])
  })

  it("refuses another token's handle", async () => {
    const other = await tokenScope("Other")
    const theirs = await describedHandle(
      await connect(other),
      "postcards",
      "send_postcard",
    )

    const result = await call(await connect(), "call_tool", {
      call_handle: theirs,
      arguments: { to: "Grace" },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain("not one describe gave this token")
    expect(ran).toEqual([])
  })

  it("answers a name passed as a handle with the tool described, ready to call", async () => {
    const client = await connect()

    for (const name of ["postcards/send_postcard", "send_postcard"]) {
      const result = await call(client, "call_tool", {
        call_handle: name,
        arguments: { to: "Grace" },
      })

      expect(result.isError).toBe(true)
      expect(result.text).toContain("not a tool's name")
      expect(result.text).toContain('"inputSchema"')
      expect(ran).toEqual([])

      const retried = await call(client, "call_tool", {
        call_handle: handleIn(result.text),
        arguments: { to: "Grace" },
      })
      expect(retried.isError, retried.text).toBe(false)
      ran = []
    }

    const unknown = await call(client, "call_tool", {
      call_handle: "postcards/burn_cards",
    })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain("describe")
    expect(unknown.text).not.toContain('call_handle":')
  })

  it("refuses a handle for a tool the token can no longer reach", async () => {
    const client = await connect()
    const handle = await describedHandle(client, "postcards", "send_postcard")

    await db().mcpTool.delete({
      where: { serverId_name: { serverId, name: "send_postcard" } },
    })
    const gone = await call(await connect(), "call_tool", {
      call_handle: handle,
      arguments: { to: "Grace" },
    })
    expect(gone.isError).toBe(true)
    expect(gone.text).toContain("can no longer reach")

    const list = await describedHandle(client, "postcards", "list_cards")
    await db().mcpServer.update({
      where: { id: serverId },
      data: { enabled: false },
    })
    const off = await call(await connect(), "call_tool", {
      call_handle: list,
    })
    expect(off.text).toContain("can no longer reach")

    await db().mcpServer.update({
      where: { id: serverId },
      data: { enabled: true },
    })
    await writeToolAccess(scope.tokenId, serverId, "list_cards", "blocked")
    const blocked = await call(await connect(), "call_tool", {
      call_handle: list,
    })
    expect(blocked.text).toContain("blocked")
    expect(ran).toEqual([])
  })

  it("checks the arguments before asking the owner, and asks nothing for ones that cannot work", async () => {
    const client = await connect()
    const handle = await describedHandle(client, "postcards", "ask_postcard")

    const wrong = await call(client, "call_tool", {
      call_handle: handle,
      arguments: { recipient: "Grace", copies: "two", size: "A4" },
    })

    expect(wrong.isError).toBe(true)
    expect(wrong.text).toContain("nothing was run or asked")
    expect(wrong.text).toContain('"to" is missing')
    expect(wrong.text).toContain('"copies" is string')
    expect(wrong.text).toContain('"size" is not one of')
    expect(wrong.text).toContain('"recipient" is not an argument')
    expect(wrong.text).toContain('"required"')
    expect(await db().permissionRequest.count()).toBe(0)

    const asked = await call(client, "call_tool", {
      call_handle: handle,
      arguments: { to: "Grace" },
    })
    expect(asked.text).toContain("Not done yet")
    expect(await db().permissionRequest.count()).toBe(1)
    expect(ran).toEqual([])
  })

  it("runs a read-only tool through call_read_only_tool, and nothing else", async () => {
    const client = await connect()
    const list = await describedHandle(client, "postcards", "list_cards")
    const send = await describedHandle(client, "postcards", "send_postcard")

    expect(
      await call(client, "call_read_only_tool", { call_handle: list }),
    ).toEqual({ isError: false, text: "ran list_cards" })

    const refused = await call(client, "call_read_only_tool", {
      call_handle: send,
      arguments: { to: "Grace" },
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain("not marked read-only")
    expect(ran).toEqual([{ tool: "list_cards", args: {} }])
  })
})

describe("checkArguments", () => {
  it("passes what it cannot evaluate rather than refusing", () => {
    expect(
      checkArguments(
        {
          type: "object",
          properties: {
            pet: { $ref: "#/$defs/pet" },
            note: { type: "string", nullable: true },
            either: {
              oneOf: [
                { type: "string", pattern: "^a" },
                { type: "string", pattern: "^b" },
              ],
            },
          },
          patternProperties: { "^x-": { type: "string" } },
          additionalProperties: false,
        },
        { pet: 3, note: null, either: "a1", "x-extra": "y" },
      ),
    ).toEqual([])
    expect(checkArguments({ $ref: "#/x" }, { anything: 1 })).toEqual([])
  })

  it("lets a kept result's handle stand for a string or a file", () => {
    expect(
      checkArguments(
        {
          type: "object",
          properties: { body: { type: "string" } },
          required: ["body"],
        },
        { body: { $result: "abc" } },
      ),
    ).toEqual([])
  })
})
