import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import {
  buildGatewayServer,
  loadGatewayServers,
  type GatewayScope,
} from "../gateway"
import { appendRequestLog } from "../request-log"
import { scratchDatabase } from "../test-db"
import { setServerToolAccess, setToolAccess } from "../tool-access"
import { setupVault } from "../vault"
import { ensureOwnStore } from "./roots"

// PCP's own store tools at /mcp: the default way to a store, PCP's own
// unless the call names another, at the token's levels for that store's
// tools as call_tool would have them.

vi.mock("../request-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../request-log")>()),
  appendRequestLog: vi.fn(async () => {}),
}))

let cleanup: () => Promise<void>
let ctx: VaultContext
let tokenId: string
let token: string
let client: Client | null

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  ;({ id: tokenId, token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  }))
  client = null
  vi.mocked(appendRequestLog).mockClear()
})

afterEach(async () => {
  await client?.close()
  await cleanup()
})

async function connect(): Promise<Client> {
  const scope: GatewayScope = {
    ...(await resolveApiToken(token))!,
    publicUrl: "http://localhost:3000",
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
    serverSide,
  )
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  return client
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("\n")
}

describe("the store tools", () => {
  it("make PCP's own store on first use, and ask the owner at its levels", async () => {
    const mcp = await connect()
    const asked = await mcp.callTool({
      name: "save_file",
      arguments: { path: "notes.txt", text: "kept" },
    })

    // Made for this vault, with its tools, which ask by default.
    const own = await ensureOwnStore(ctx)
    expect(await db().mcpTool.count({ where: { serverId: own } })).toBe(7)
    expect(textOf(asked)).toMatch(/Not done yet/)
    expect(await db().permissionRequest.count()).toBe(1)
    expect(await db().storageEntry.count()).toBe(0)
  })

  it("run at the level the owner set, and refuse a blocked tool", async () => {
    const own = await ensureOwnStore(ctx)
    await setServerToolAccess(ctx, tokenId, own, "allowed")
    await setToolAccess(ctx, tokenId, own, "delete", "blocked")
    const mcp = await connect()

    const saved = await mcp.callTool({
      name: "save_file",
      arguments: { path: "notes.txt", text: "kept" },
    })
    expect(saved.isError, textOf(saved)).toBeFalsy()
    expect(JSON.parse(textOf(saved))).toMatchObject({
      path: "notes.txt",
      saved: "created",
    })

    const read = await mcp.callTool({
      name: "get_file",
      arguments: { path: "notes.txt" },
    })
    expect(JSON.parse(textOf(read))).toMatchObject({ text: "kept" })

    const listed = await mcp.callTool({
      name: "list_folder",
      arguments: { store: "pcp-files" },
    })
    expect(JSON.parse(textOf(listed))).toMatchObject({
      entries: [expect.objectContaining({ name: "notes.txt" })],
    })

    const blocked = await mcp.callTool({
      name: "delete",
      arguments: { path: "notes.txt" },
    })
    expect(blocked.isError).toBe(true)
    expect(textOf(blocked)).toMatch(/blocked/)
    expect(await db().storageEntry.count()).toBe(1)

    // Each call is logged under the store and its tool.
    expect(vi.mocked(appendRequestLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "save_file",
        server: "pcp-files",
        upstreamTool: "save_file",
      }),
    )
  })

  it("check the arguments before anything runs, and name the stores there are", async () => {
    const own = await ensureOwnStore(ctx)
    await setServerToolAccess(ctx, tokenId, own, "allowed")
    const mcp = await connect()

    const both = await mcp.callTool({
      name: "save_file",
      arguments: { path: "a.txt" },
    })
    expect(both.isError).toBe(true)
    expect(textOf(both)).toMatch(/file or text/)

    const unknown = await mcp.callTool({
      name: "list_folder",
      arguments: { store: "scans" },
    })
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown)).toMatch(/no store called scans.*pcp-files/s)
    expect(await db().storageEntry.count()).toBe(0)
  })
})
