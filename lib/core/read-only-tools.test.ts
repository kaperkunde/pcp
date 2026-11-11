import { randomUUID } from "node:crypto"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { MAY_HAVE_GONE_THROUGH } from "./code/runs"
import { db } from "./db"
import { PcpError } from "./errors"
import {
  buildGatewayServer,
  loadGatewayServers,
  type GatewayScope,
} from "./gateway"
import type { PermissionExecutor } from "./permissions"
import { appendRequestLog } from "./request-log"
import { createServer } from "./servers"
import { scratchDatabase } from "./test-db"
import {
  catalogueHandle,
  withCallHandle,
  entryCall,
  listEveryTool,
} from "./test-handles"
import { writeToolAccess } from "./tool-access"
import { setToolTier } from "./tool-tiers"
import { markedReadOnly } from "./read-only"
import { setupVault } from "./vault"

// The gateway's tools by tier, as a client that holds back everything but
// reads (Claude Code's plan mode), or asks before every destructive call
// (Claude's voice mode), meets them: search, describe, read_memory and
// execute_read say they only read; execute_write says it destroys
// nothing; each call_tool_<tier> runs tools at or below its tier only
// (tool-tiers.ts), at the token's own levels, and refuses a higher one by
// name before checking or asking anything.

vi.mock("./request-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./request-log")>()),
  appendRequestLog: vi.fn(async () => {}),
}))

let cleanup: () => Promise<void>
let ctx: VaultContext
let scope: GatewayScope
let client: Client
let ran: string[]
/** What the next upstream call throws, when set. */
let failWith: Error | null = null

const executor: PermissionExecutor = {
  callTool: async (_ctx, _server, tool) => {
    ran.push(tool)

    if (failWith) {
      throw failWith
    }

    return { content: [{ type: "text", text: `ran ${tool}` }] }
  },
  syncTools: async () => ({ status: "ok", message: "", toolCount: 0 }),
}

const TOOLS: Array<{ name: string; annotations?: unknown }> = [
  { name: "list_cards", annotations: { readOnlyHint: true } },
  { name: "peek_cards", annotations: { readOnlyHint: true } },
  { name: "hidden_cards", annotations: { readOnlyHint: true } },
  // Not read-only, and destructive as MCP's default has it.
  { name: "send_postcard", annotations: { readOnlyHint: false } },
  {
    name: "edit_card",
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  { name: "rewrite_card", annotations: { destructiveHint: false } },
  { name: "burn_cards" },
]

let serverId: string

async function connect() {
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
        plainName: tool.name,
        plainDescription: `${tool.name} does one thing.`,
        plainInputSchema: JSON.stringify({ type: "object" }),
        annotations: tool.annotations ? JSON.stringify(tool.annotations) : null,
      },
    })
  }

  const { id: tokenId, token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    keepMemories: true,
  })

  for (const name of [
    "list_cards",
    "send_postcard",
    "edit_card",
    "burn_cards",
  ]) {
    await writeToolAccess(tokenId, serverId, name, "allowed")
  }
  await writeToolAccess(tokenId, serverId, "hidden_cards", "blocked")

  scope = {
    ...(await resolveApiToken(token))!,
    publicUrl: "http://localhost:3000",
  }
  await reconnect()
}

/** The gateway built again, as the next request builds it. */
async function reconnect(
  options: Parameters<typeof buildGatewayServer>[2] = {},
) {
  await client?.close()
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, await loadGatewayServers(scope), {
    executor,
    ...options,
  }).connect(serverSide)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool(
    entryCall(
      name,
      name.startsWith("execute_") ? await withCallHandle(client, args) : args,
    ),
  )
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
  failWith = null
  vi.mocked(appendRequestLog).mockClear()
  await connect()
})

afterEach(async () => {
  await client?.close()
  await cleanup()
})

describe("the read-only tools", () => {
  it("say they only read, and the tools that write do not", async () => {
    const { tools } = await listEveryTool(client)
    const readOnly = (name: string) =>
      tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint

    expect(readOnly("read_memory")).toBe(true)
    expect(readOnly("execute_read")).toBe(true)
    // Finding and reading tools, skills and memories.
    for (const name of ["search", "list_tools", "read_result"]) {
      expect(readOnly(name), name).toBe(true)
    }
    expect(readOnly("memory")).toBe(false)
    expect(readOnly("execute_write")).toBe(false)
    expect(readOnly("execute_destructive")).toBe(false)
    expect(readOnly("list_secrets")).toBeUndefined()
    // The old names are gone (docs/breaking-changes.md), and describe is
    // search's ref (#113).
    expect(tools.map((tool) => tool.name)).not.toContain("search_tools")
    expect(tools.map((tool) => tool.name)).not.toContain("describe_tool")
    expect(tools.map((tool) => tool.name)).not.toContain("describe")
  })

  it("include list_secrets and get_endpoint for a token that manages endpoints", async () => {
    const { token } = await createApiToken(ctx, {
      name: "Manager",
      allowAllServers: true,
      manageEndpoints: true,
    })
    const manager = {
      ...(await resolveApiToken(token))!,
      publicUrl: "http://localhost:3000",
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildGatewayServer(manager, await loadGatewayServers(manager), {
      executor,
    }).connect(serverSide)
    const managing = new Client({ name: "test", version: "1.0.0" })
    await managing.connect(clientSide)

    const { tools } = await listEveryTool(managing)
    const readOnly = (name: string) =>
      tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint
    await managing.close()

    expect(readOnly("list_secrets")).toBe(true)
    expect(readOnly("get_endpoint")).toBe(true)
    expect(readOnly("update_endpoint")).toBe(false)
  })

  it("include check_run and run_read for a token that runs code, and not the other run_code entries", async () => {
    const { token } = await createApiToken(ctx, {
      name: "Coder",
      allowAllServers: true,
      runCode: true,
    })
    const coder = {
      ...(await resolveApiToken(token))!,
      publicUrl: "http://localhost:3000",
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildGatewayServer(coder, await loadGatewayServers(coder), {
      executor,
    }).connect(serverSide)
    const coding = new Client({ name: "test", version: "1.0.0" })
    await coding.connect(clientSide)

    const { tools } = await listEveryTool(coding)
    const readOnly = (name: string) =>
      tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint
    await coding.close()

    expect(readOnly("check_run")).toBe(true)
    expect(readOnly("run_read")).toBe(true)
    expect(readOnly("run_write")).toBe(false)
    expect(readOnly("run_destructive")).toBe(false)
  })
})

describe("a call that failed on its way", () => {
  it("says a call that changes things may have gone through, and not a read or a refusal", async () => {
    failWith = new PcpError("upstream", "Postcards could not be reached.")

    const sent = await call("execute_destructive", {
      server: "postcards",
      tool: "send_postcard",
    })
    expect(sent.isError).toBe(true)
    expect(sent.text).toBe(
      `Postcards could not be reached.\n\n${MAY_HAVE_GONE_THROUGH}`,
    )

    const read = await call("execute_read", {
      server: "postcards",
      tool: "list_cards",
    })
    expect(read.isError).toBe(true)
    expect(read.text).toBe("Postcards could not be reached.")

    // The same call again is held back as a repeat (#115) unless the
    // assistant says why it repeats it.
    failWith = new PcpError("validation", "That is not a postcard.")
    const refused = await call("execute_destructive", {
      server: "postcards",
      tool: "send_postcard",
      rerun: true,
      reason: "Postcards was unreachable the first time.",
    })
    expect(refused.text).toBe("That is not a postcard.")
  })
})

describe("the execute entries", () => {
  it("say their tier in their annotations, and the old names are gone", async () => {
    const { tools } = await listEveryTool(client)
    const hints = (name: string) =>
      tools.find((tool) => tool.name === name)?.annotations

    expect(hints("execute_read")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    })
    expect(hints("execute_write")).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
    expect(hints("execute_destructive")).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    })
    const names = tools.map((tool) => tool.name)
    expect(names).not.toContain("call_tool")
    expect(names).not.toContain("call_read_only_tool")
  })

  it("run a Read tool through execute_read, and log it under that name", async () => {
    expect(
      await call("execute_read", {
        server: "postcards",
        tool: "list_cards",
      }),
    ).toEqual({ isError: false, text: "ran list_cards" })
    expect(ran).toEqual(["list_cards"])
    expect(vi.mocked(appendRequestLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "execute_read",
        server: "postcards",
        upstreamTool: "list_cards",
        ok: true,
      }),
    )
  })

  it("run each tool only at or below their tier, naming the entry for one above", async () => {
    const runs = async (entry: string, tool: string) =>
      call(entry, { server: "postcards", tool })

    // Write: not read-only and destructiveHint false, the default for
    // readOnlyHint included; Destructive: no hints, or only readOnlyHint false.
    expect((await runs("execute_write", "edit_card")).isError).toBe(false)
    expect((await runs("execute_write", "list_cards")).isError).toBe(false)

    for (const [entry, tool, named] of [
      ["execute_read", "edit_card", "execute_write"],
      ["execute_read", "send_postcard", "execute_destructive"],
      ["execute_read", "burn_cards", "execute_destructive"],
      ["execute_write", "send_postcard", "execute_destructive"],
      ["execute_write", "burn_cards", "execute_destructive"],
    ] as const) {
      const result = await runs(entry, tool)
      expect(result.isError, `${entry} ${tool}`).toBe(true)
      expect(result.text).toContain(`postcards/${tool} is a`)
      expect(result.text).toContain(`run it with ${named}`)
    }

    expect((await runs("execute_destructive", "burn_cards")).isError).toBe(
      false,
    )
    expect(ran).toEqual(["edit_card", "list_cards", "burn_cards"])
  })

  it("refuse a tool above their tier before its arguments are checked or the owner asked", async () => {
    // rewrite_card asks the owner (no level), and is Write.
    const result = await call("execute_read", {
      server: "postcards",
      tool: "rewrite_card",
      arguments: { not_an_argument: 1 },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain("run it with execute_write")
    expect(await db().permissionRequest.count()).toBe(0)
    expect(ran).toEqual([])
  })

  it("keep the owner's levels: a blocked tool is refused, an ask asks", async () => {
    // A handle for it from before the owner blocked it.
    const blocked = await call("execute_read", {
      call_handle: await catalogueHandle(scope, "postcards", "hidden_cards"),
    })
    expect(blocked.isError).toBe(true)
    expect(blocked.text).toContain("blocked")

    const asked = await call("execute_read", {
      server: "postcards",
      tool: "peek_cards",
    })
    expect(asked.text).toContain("Not done yet")
    expect(ran).toEqual([])
  })

  it("follow the owner's tier over the annotations, in the gate, describe and list_tools", async () => {
    await setToolTier(ctx, serverId, "burn_cards", "write")
    await setToolTier(ctx, serverId, "list_cards", "destructive")
    await reconnect()

    expect(
      (
        await call("execute_write", {
          server: "postcards",
          tool: "burn_cards",
        })
      ).isError,
    ).toBe(false)
    const refused = await call("execute_read", {
      server: "postcards",
      tool: "list_cards",
    })
    expect(refused.text).toContain("run it with execute_destructive")

    const described = JSON.parse(
      (await call("describe", { ref: "postcards/burn_cards" })).text,
    ) as Record<string, unknown>
    expect(described).toMatchObject({
      tier: "write",
      run_with: "execute_write",
    })
    expect((await call("list_tools", { server: "postcards" })).text).toContain(
      "postcards/burn_cards [allowed, write: execute_write]",
    )
    expect((await call("search", { query: "burn cards" })).text).toContain(
      "tool postcards/burn_cards [write: execute_write]",
    )
    // Pacing and a run's trace ask the same.
    expect(await markedReadOnly(ctx, serverId, "list_cards")).toBe(false)
    expect(await markedReadOnly(ctx, serverId, "peek_cards")).toBe(true)
  })

  it("advertise the owner's tier for PCP's own tools, and run them by it; the entries keep theirs", async () => {
    await reconnect({
      ownTiers: {
        execute_destructive: "write",
        search: "destructive",
        memory: "write",
        check_permission: "destructive",
      },
    })
    const { tools } = await listEveryTool(client)
    const hints = (name: string) =>
      tools.find((tool) => tool.name === name)?.annotations

    // An entry's tier is its name (#113).
    expect(hints("execute_destructive")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    })
    expect(hints("search")).toMatchObject({ readOnlyHint: true })
    expect(hints("memory")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    })
    expect(hints("check_permission")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    })
    expect(
      JSON.parse((await call("search", { ref: "memory" })).text),
    ).toMatchObject({ tier: "write", run_with: "execute_write" })

    // Run through the execute entry of the owner's tier for them.
    const viaWrite = await client.callTool({
      name: "execute_write",
      arguments: {
        tool: "memory",
        arguments: { command: "view", path: "/memories" },
      },
    })
    expect(viaWrite.isError).toBeFalsy()
    const refused = await client.callTool({
      name: "execute_read",
      arguments: { tool: "check_permission" },
    })
    expect(refused.isError).toBe(true)
    expect((refused.content as Array<{ text: string }>)[0]!.text).toContain(
      "run it with execute_destructive",
    )
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
