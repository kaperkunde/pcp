import { randomUUID } from "node:crypto"

import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import { buildGatewayServer, loadGatewayServers } from "../gateway"
import { createServer } from "../servers"
import { scratchDatabase } from "../test-db"
import { withCallHandle } from "../test-handles"
import { setupVault } from "../vault"

// A call that asks the owner and fails on its way to the request: the
// duplicate guard's record of it goes, so the same call later is not held
// back by a call that never happened.

const failing = vi.hoisted(() => ({ ask: false }))

vi.mock("../permissions", async (importOriginal) => {
  const original = await importOriginal<typeof import("../permissions")>()

  return {
    ...original,
    withPermission: vi.fn(
      async (...args: Parameters<typeof original.withPermission>) => {
        if (failing.ask) {
          throw new Error("The database went away.")
        }

        return original.withPermission(...args)
      },
    ),
  }
})

let cleanup: () => Promise<void>
let ctx: VaultContext
let client: Client

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  const { id: serverId } = await createServer(ctx, {
    name: "Postcards",
    url: "https://postcards.example.com/mcp",
    authType: "none",
  })
  await db().mcpTool.create({
    data: {
      id: randomUUID(),
      serverId,
      name: "send_postcard",
      description: "Sends a postcard.",
      inputSchema: JSON.stringify({ type: "object" }),
    },
  })
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  })
  const scope = {
    ...(await resolveApiToken(token))!,
    publicUrl: "http://localhost:3000",
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
    serverSide,
  )
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
})

afterEach(async () => {
  failing.ask = false
  await client?.close()
  await cleanup()
})

describe("a call that asks and fails before the request is made", () => {
  it("leaves no record that would hold the same call back", async () => {
    const args = await withCallHandle(client, {
      server: "postcards",
      tool: "send_postcard",
      arguments: { to: "Ada" },
    })

    failing.ask = true
    const failed = await client.callTool({
      name: "call_tool_destructive",
      arguments: args,
    })
    expect(failed.isError).toBe(true)
    expect(await db().callRecord.count()).toBe(0)

    failing.ask = false
    const asked = await client.callTool({
      name: "call_tool_destructive",
      arguments: args,
    })
    expect(JSON.stringify(asked.content)).toContain("Not done yet")
  })
})
