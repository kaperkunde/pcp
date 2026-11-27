import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import { createEndpoint } from "./endpoints"
import { buildGatewayServer, loadGatewayServers } from "./gateway"
import { startTestApi, type TestApi } from "./openapi/test-api"
import { scratchDatabase } from "./test-db"
import { entryCall } from "./test-handles"
import { writeToolAccess } from "./tool-access"
import {
  REFRESH_MIN_INTERVAL_MS,
  claimRefresh,
  diffToolNames,
  refreshBlockedReason,
  resetRefreshes,
} from "./tool-refresh"
import { setupVault } from "./vault"

// check_server's refresh (#171): the rules, and the whole path through the
// gateway against a schema at an address that changes.

describe("refreshBlockedReason", () => {
  const base = { kind: "mcp", specSource: null, status: "ok" }

  it("lets an MCP server and a downloaded schema be read again", () => {
    expect(refreshBlockedReason(base)).toBeNull()
    expect(
      refreshBlockedReason({ ...base, kind: "openapi", specSource: "url" }),
    ).toBeNull()
  })

  it("leaves a server that waits for the owner, and one that cannot change", () => {
    expect(refreshBlockedReason({ ...base, status: "auth_required" })).toMatch(
      /owner/,
    )
    expect(
      refreshBlockedReason({ ...base, status: "client_required" }),
    ).toMatch(/owner/)
    expect(refreshBlockedReason({ ...base, kind: "ssh" })).toMatch(/pinned/)
    expect(
      refreshBlockedReason({
        ...base,
        kind: "ssh",
        sshHostKey: "ssh-ed25519 A",
      }),
    ).toMatch(/do not change/)
    expect(refreshBlockedReason({ ...base, kind: "wrapper" })).toMatch(
      /do not change/,
    )
    expect(
      refreshBlockedReason({ ...base, kind: "openapi", specSource: "upload" }),
    ).toMatch(/do not change/)
  })
})

describe("claimRefresh", () => {
  beforeEach(resetRefreshes)

  it("gives a server one turn a minute, each server its own", () => {
    expect(claimRefresh("a", 1_000)).toBe(0)
    expect(claimRefresh("a", 11_000)).toBe(REFRESH_MIN_INTERVAL_MS - 10_000)
    expect(claimRefresh("b", 11_000)).toBe(0)
    expect(claimRefresh("a", 1_000 + REFRESH_MIN_INTERVAL_MS)).toBe(0)
  })
})

describe("diffToolNames", () => {
  it("names what appeared and what went away, sorted", () => {
    expect(diffToolNames(["a", "b", "c"], ["c", "e", "d"])).toEqual({
      added: ["d", "e"],
      removed: ["a", "b"],
    })
    expect(diffToolNames(["a"], ["a"])).toEqual({ added: [], removed: [] })
  })
})

describe("check_server with refresh", () => {
  let cleanup: () => Promise<void>
  let docs: TestApi
  let client: Client
  let operations: string[]

  const schema = () =>
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Pets" },
      servers: [{ url: "http://127.0.0.1:9/api" }],
      paths: Object.fromEntries(
        operations.map((id) => [
          `/${id}`,
          { get: { operationId: id, summary: id } },
        ]),
      ),
    })

  beforeEach(async () => {
    resetRefreshes()
    operations = ["listPets"]
    ;({ cleanup } = await scratchDatabase())
    docs = await startTestApi((_, res) => {
      res.setHeader("content-type", "application/json")
      res.end(schema())
    })
    const ctx = await setupVault({
      name: "Ada",
      password: "correct horse battery staple",
    })
    await createEndpoint(ctx, {
      name: "Pets",
      specSource: "url",
      specUrl: `${docs.origin}/openapi.json`,
      readOnly: false,
      authType: "none",
    })
    const { token } = await createApiToken(ctx, {
      name: "Reader",
      allowAllServers: true,
    })
    const scope = {
      ...(await resolveApiToken(token))!,
      publicUrl: "http://localhost:3000",
    }
    const gateway = buildGatewayServer(scope, await loadGatewayServers(scope))
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await gateway.connect(serverSide)
    client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientSide)
  })

  afterEach(async () => {
    await client.close()
    await docs.close()
    await cleanup()
  })

  const check = (args: Record<string, unknown> = {}) =>
    client.callTool(entryCall("check_server", { server: "pets", ...args }))

  it("reads the tools again now and names what appeared and went away", async () => {
    const before = await check()
    expect(before.structuredContent).toMatchObject({
      server: { toolCount: 1 },
    })
    expect(before.structuredContent).not.toHaveProperty("refresh")

    operations = ["getPet", "addPet"]
    const after = await check({ refresh: true })

    expect(after.structuredContent).toMatchObject({
      kind: "done",
      server: { toolCount: 2 },
      refresh: {
        read: true,
        added: ["addPet", "getPet"],
        removed: ["listPets"],
      },
    })
    expect(JSON.stringify(after.content)).toContain("appeared: addPet, getPet")
    expect(JSON.stringify(after.content)).toContain("went away: listPets")
  })

  it("reads a server once a minute, and says when it may be read again", async () => {
    await check({ refresh: true })
    const requests = docs.requests.length
    operations = ["other"]
    const again = await check({ refresh: true })

    expect(docs.requests).toHaveLength(requests)
    expect(again.structuredContent).toMatchObject({
      server: { toolCount: 1 },
      refresh: { read: false, added: [], removed: [] },
    })
    expect(
      (again.structuredContent as { refresh: { retryAfterMs: number } }).refresh
        .retryAfterMs,
    ).toBeGreaterThan(0)
  })
})

describe("check_server's refresh and a blocked tool", () => {
  it("never names a tool the token cannot see", async () => {
    const { cleanup } = await scratchDatabase()
    resetRefreshes()
    let operations = ["listPets", "hiddenOp"]
    const docs = await startTestApi((_, res) => {
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Pets" },
          servers: [{ url: "http://127.0.0.1:9/api" }],
          paths: Object.fromEntries(
            operations.map((id) => [
              `/${id}`,
              { get: { operationId: id, summary: id } },
            ]),
          ),
        }),
      )
    })

    try {
      const ctx = await setupVault({
        name: "Ada",
        password: "correct horse battery staple",
      })
      const { id: serverId } = await createEndpoint(ctx, {
        name: "Pets",
        specSource: "url",
        specUrl: `${docs.origin}/openapi.json`,
        readOnly: false,
        authType: "none",
      })
      const { token, id } = await createApiToken(ctx, {
        name: "Reader",
        allowAllServers: true,
      })
      await writeToolAccess(ctx, id, serverId, "hiddenOp", "blocked")
      const scope = {
        ...(await resolveApiToken(token))!,
        publicUrl: "http://localhost:3000",
      }
      const gateway = buildGatewayServer(scope, await loadGatewayServers(scope))
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await gateway.connect(serverSide)
      const client = new Client({ name: "test", version: "1.0.0" })
      await client.connect(clientSide)

      operations = ["listPets", "newOp"]
      const answer = await client.callTool(
        entryCall("check_server", { server: "pets", refresh: true }),
      )
      const said = JSON.stringify(answer)

      expect(answer.structuredContent).toMatchObject({
        refresh: { read: true, added: ["newOp"], removed: [] },
      })
      expect(said).not.toContain("hiddenOp")
      await client.close()
    } finally {
      await docs.close()
      await cleanup()
    }
  })
})
