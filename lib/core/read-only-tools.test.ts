import { randomUUID } from "node:crypto"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
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
import { writeToolAccess } from "./tool-access"
import { setupVault } from "./vault"

// The gateway's read-only tools, as a client that holds back everything else
// (Claude Code's plan mode) meets them: read_memory and call_read_only_tool
// say they only read, and call_read_only_tool runs nothing its server does
// not mark read-only, at the token's own levels.

vi.mock("./request-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./request-log")>()),
  appendRequestLog: vi.fn(async () => {}),
}))

let cleanup: () => Promise<void>
let ctx: VaultContext
let scope: GatewayScope
let client: Client
let ran: string[]

const executor: PermissionExecutor = {
  callTool: async (_ctx, _server, tool) => {
    ran.push(tool)
    return { content: [{ type: "text", text: `ran ${tool}` }] }
  },
  syncTools: async () => ({ status: "ok", message: "", toolCount: 0 }),
}

const TOOLS: Array<{ name: string; annotations?: unknown }> = [
  { name: "list_cards", annotations: { readOnlyHint: true } },
  { name: "peek_cards", annotations: { readOnlyHint: true } },
  { name: "hidden_cards", annotations: { readOnlyHint: true } },
  { name: "send_postcard", annotations: { readOnlyHint: false } },
  { name: "burn_cards" },
]

async function connect() {
  const { id: serverId } = await createServer(ctx, {
    name: "Postcards",
    url: "https://postcards.example.com/mcp",
    authType: "none",
  })

  for (const tool of TOOLS) {
    await db().mcpTool.create({
      data: {
        id: randomUUID(),
        serverId,
        name: tool.name,
        description: `${tool.name} does one thing.`,
        inputSchema: JSON.stringify({ type: "object" }),
        annotations: tool.annotations ? JSON.stringify(tool.annotations) : null,
      },
    })
  }

  const { id: tokenId, token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    keepMemories: true,
  })

  for (const name of ["list_cards", "send_postcard", "burn_cards"]) {
    await writeToolAccess(tokenId, serverId, name, "allowed")
  }
  await writeToolAccess(tokenId, serverId, "hidden_cards", "blocked")

  scope = {
    ...(await resolveApiToken(token))!,
    publicUrl: "http://localhost:3000",
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, await loadGatewayServers(scope), {
    executor,
  }).connect(serverSide)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("")

  return { isError: result.isError === true, text }
}

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  ran = []
  vi.mocked(appendRequestLog).mockClear()
  await connect()
})

afterEach(async () => {
  await client?.close()
  await cleanup()
})

describe("the read-only tools", () => {
  it("say they only read, and the tools that write do not", async () => {
    const { tools } = await client.listTools()
    const readOnly = (name: string) =>
      tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint

    expect(readOnly("read_memory")).toBe(true)
    expect(readOnly("call_read_only_tool")).toBe(true)
    expect(readOnly("memory")).toBe(false)
    expect(readOnly("call_tool")).not.toBe(true)
  })
})

describe("call_read_only_tool", () => {
  it("runs a tool its server marks read-only, and logs it like call_tool", async () => {
    expect(
      await call("call_read_only_tool", {
        server: "postcards",
        tool: "list_cards",
      }),
    ).toEqual({ isError: false, text: "ran list_cards" })
    expect(ran).toEqual(["list_cards"])
    expect(vi.mocked(appendRequestLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "call_read_only_tool",
        server: "postcards",
        upstreamTool: "list_cards",
        ok: true,
      }),
    )
  })

  it("refuses a tool not marked read-only, even one the owner allowed", async () => {
    for (const tool of ["send_postcard", "burn_cards"]) {
      const result = await call("call_read_only_tool", {
        server: "postcards",
        tool,
      })

      expect(result.isError).toBe(true)
      expect(result.text).toContain("not marked read-only")
      expect(result.text).toContain("call_tool")
    }

    expect(ran).toEqual([])
  })

  it("keeps the owner's levels: a blocked tool is refused, an ask asks", async () => {
    const blocked = await call("call_read_only_tool", {
      server: "postcards",
      tool: "hidden_cards",
    })
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toContain("blocked")

    const asked = await call("call_read_only_tool", {
      server: "postcards",
      tool: "peek_cards",
    })
    expect(asked.text).toContain("Not done yet")
    expect(ran).toEqual([])
  })
})

describe("read_memory", () => {
  it("reads what memory wrote, and takes no command that writes", async () => {
    await call("memory", {
      command: "create",
      path: "/memories/notes.md",
      file_text: "Prefers tea.",
    })

    expect((await call("read_memory", { command: "every" })).text).toContain(
      "/memories/notes.md",
    )
    expect(
      (
        await call("read_memory", {
          command: "view",
          path: "/memories/notes.md",
        })
      ).text,
    ).toContain("Prefers tea.")
    expect(
      (await call("read_memory", { command: "search", query: "tea" })).text,
    ).toContain("/memories/notes.md")

    const write = await call("read_memory", {
      command: "create",
      path: "/memories/other.md",
      file_text: "No.",
    })
    expect(write.isError).toBe(true)
    expect(
      (await call("read_memory", { command: "every" })).text,
    ).not.toContain("/memories/other.md")
  })
})
