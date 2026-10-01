import { randomUUID } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createApiToken,
  getApiToken,
  resolveApiToken,
  revokeApiToken,
  updateApiToken,
} from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import { buildInstructions, loadGatewayServers } from "./gateway"
import { createServer } from "./servers"
import { scratchDatabase } from "./test-db"
import {
  copyTokenAccess,
  listTokenToolAccess,
  setServerToolAccess,
  setToolAccess,
} from "./tool-access"
import { setupVault } from "./vault"

// Per-token tool levels against a scratch database: the default, the
// setters, copying between tokens, and what the gateway makes of them.

let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
})

afterEach(async () => {
  await cleanup()
})

const PASSWORD = "correct horse battery staple"
const PUBLIC_URL = "http://localhost:3000"

async function addTool(serverId: string, name: string) {
  await db().mcpTool.create({
    data: {
      id: randomUUID(),
      serverId,
      name,
      description: `${name} does one thing.`,
      inputSchema: JSON.stringify({ type: "object" }),
    },
  })
}

async function serverWithTools(
  ctx: VaultContext,
  name: string,
  tools: string[],
): Promise<string> {
  const { id } = await createServer(ctx, {
    name,
    url: `https://${name.toLowerCase()}.example.com/mcp`,
    description: `${name} things.`,
    authType: "none",
  })

  for (const tool of tools) {
    await addTool(id, tool)
  }

  return id
}

async function levels(ctx: VaultContext, tokenId: string) {
  return Object.fromEntries(
    (await listTokenToolAccess(ctx, tokenId)).flatMap((server) =>
      server.tools.map((tool) => [`${server.slug}/${tool.name}`, tool.access]),
    ),
  )
}

describe("tool access", () => {
  it("asks by default, stores allowed and blocked, and forgets back to ask", async () => {
    const ctx = await setupVault({ name: "Ada", password: PASSWORD })
    const postcards = await serverWithTools(ctx, "Postcards", [
      "add_numbers",
      "send_postcard",
    ])
    const { id: tokenId } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })

    expect(await levels(ctx, tokenId)).toEqual({
      "postcards/add_numbers": "ask",
      "postcards/send_postcard": "ask",
    })

    await setToolAccess(ctx, tokenId, postcards, "add_numbers", "allowed")
    await setToolAccess(ctx, tokenId, postcards, "send_postcard", "blocked")
    expect(await levels(ctx, tokenId)).toEqual({
      "postcards/add_numbers": "allowed",
      "postcards/send_postcard": "blocked",
    })

    // Ask is the absence of a row.
    await setToolAccess(ctx, tokenId, postcards, "send_postcard", "ask")
    expect(await db().apiTokenToolAccess.count({ where: { tokenId } })).toBe(1)

    await expect(
      setToolAccess(ctx, tokenId, postcards, "no_such_tool", "allowed"),
    ).rejects.toThrow(/tool was not found/)
  })

  it("keeps a level when the tool drops out of a refresh and comes back", async () => {
    const ctx = await setupVault({ name: "Ada", password: PASSWORD })
    const postcards = await serverWithTools(ctx, "Postcards", ["send_postcard"])
    const { id: tokenId } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })

    await setToolAccess(ctx, tokenId, postcards, "send_postcard", "blocked")
    await db().mcpTool.deleteMany({ where: { serverId: postcards } })
    await addTool(postcards, "send_postcard")

    expect(await levels(ctx, tokenId)).toEqual({
      "postcards/send_postcard": "blocked",
    })
  })

  it("hides blocked tools from the gateway and tags the rest", async () => {
    const ctx = await setupVault({ name: "Ada", password: PASSWORD })
    const postcards = await serverWithTools(ctx, "Postcards", [
      "add_numbers",
      "send_postcard",
    ])
    const { id: tokenId, token } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })

    await setToolAccess(ctx, tokenId, postcards, "add_numbers", "allowed")
    await setToolAccess(ctx, tokenId, postcards, "send_postcard", "blocked")

    const resolved = await resolveApiToken(token)
    const [server] = await loadGatewayServers({
      ...resolved!,
      publicUrl: PUBLIC_URL,
    })

    expect(server.tools.map((tool) => [tool.name, tool.access])).toEqual([
      ["add_numbers", "allowed"],
      ["send_postcard", "blocked"],
    ])
    expect(buildInstructions([server])).toContain(
      "postcards: Postcards things. (1 tool)",
    )
  })

  it("sets every tool on a server at once", async () => {
    const ctx = await setupVault({ name: "Ada", password: PASSWORD })
    const postcards = await serverWithTools(ctx, "Postcards", [
      "add_numbers",
      "send_postcard",
    ])
    const { id: tokenId } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })

    await setServerToolAccess(ctx, tokenId, postcards, "allowed")
    expect(await levels(ctx, tokenId)).toEqual({
      "postcards/add_numbers": "allowed",
      "postcards/send_postcard": "allowed",
    })

    await setServerToolAccess(ctx, tokenId, postcards, "ask")
    expect(await db().apiTokenToolAccess.count({ where: { tokenId } })).toBe(0)
  })

  it("copies servers and levels from another token, replacing what was there", async () => {
    const ctx = await setupVault({ name: "Ada", password: PASSWORD })
    const postcards = await serverWithTools(ctx, "Postcards", [
      "add_numbers",
      "send_postcard",
    ])
    const weather = await serverWithTools(ctx, "Weather", ["forecast"])

    const source = await createApiToken(ctx, {
      name: "Laptop",
      allowAllServers: false,
      serverIds: [postcards],
    })
    await setToolAccess(ctx, source.id, postcards, "add_numbers", "allowed")
    await setToolAccess(ctx, source.id, postcards, "send_postcard", "blocked")

    const target = await createApiToken(ctx, {
      name: "Phone",
      allowAllServers: true,
    })
    await setToolAccess(ctx, target.id, weather, "forecast", "allowed")

    await copyTokenAccess(ctx, target.id, source.id)

    const copied = await getApiToken(ctx, target.id)
    expect(copied.allowAllServers).toBe(false)
    expect(copied.servers.map((server) => server.id)).toEqual([postcards])
    expect(await levels(ctx, target.id)).toEqual({
      "postcards/add_numbers": "allowed",
      "postcards/send_postcard": "blocked",
    })
    // The weather level it had is gone, not merged.
    expect(
      await db().apiTokenToolAccess.count({
        where: { tokenId: target.id, serverId: weather },
      }),
    ).toBe(0)

    await expect(copyTokenAccess(ctx, source.id, source.id)).rejects.toThrow(
      /different token/,
    )
  })

  it("changes a token's name, servers and expiry after the fact", async () => {
    const ctx = await setupVault({ name: "Ada", password: PASSWORD })
    const postcards = await serverWithTools(ctx, "Postcards", ["send_postcard"])
    const { id, token } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })
    const inAWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    await updateApiToken(ctx, id, {
      name: "Claude at work",
      allowAllServers: false,
      serverIds: [postcards],
      expiresAt: inAWeek,
    })

    const updated = await getApiToken(ctx, id)
    expect(updated.name).toBe("Claude at work")
    expect(updated.servers.map((server) => server.id)).toEqual([postcards])
    expect(updated.expiresAt?.getTime()).toBe(inAWeek.getTime())
    // The same bearer token still works, now scoped.
    expect((await resolveApiToken(token))?.serverIds).toEqual([postcards])

    // Leaving the expiry out keeps it.
    await updateApiToken(ctx, id, { name: "Claude", allowAllServers: true })
    expect((await getApiToken(ctx, id)).expiresAt?.getTime()).toBe(
      inAWeek.getTime(),
    )

    await expect(
      updateApiToken(ctx, id, { name: "x", allowAllServers: false }),
    ).rejects.toThrow(/at least one server/)

    await revokeApiToken(ctx, id)
    await expect(
      updateApiToken(ctx, id, { name: "again", allowAllServers: true }),
    ).rejects.toThrow(/revoked/)
    await expect(
      setToolAccess(ctx, id, postcards, "send_postcard", "allowed"),
    ).rejects.toThrow(/revoked/)
  })
})
