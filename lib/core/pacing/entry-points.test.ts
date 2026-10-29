import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import { createEndpoint } from "../endpoints"
import {
  buildGatewayServer,
  loadGatewayServers,
  type GatewayScope,
} from "../gateway"
import { json, startTestApi, type TestApi } from "../openapi/test-api"
import { decidePermission } from "../permissions"
import { scratchDatabase } from "../test-db"
import { withCallHandle } from "../test-handles"
import { writeToolAccess } from "../tool-access"
import { setupVault } from "../vault"
import { setFetchPrivate, setFetchSite } from "../web-fetch"
import { setPacingClass, setPacingServer, setPacingSite } from "./config"
import { PACING_CALL_WAIT_MS } from "./limits"
import { resetPacing, setPacingClock } from "./pace"

// Pacing holds whatever way a call comes in, because it sits where every
// real call passes (upstream.ts callServerTool, web fetch's request path):
// call_tool, run_code's pcp.call, a wrapper's call, a call the owner
// allowed, and web_fetch, each against a real endpoint on a throwaway
// server. The clock is PCP's own pretend one: a wait is noted and time
// moves on at once.

const PUBLIC_URL = "http://localhost:3000"
const PAUSE = { minIntervalMs: 5_000, jitterMs: 0, burst: null }

let cleanup: () => Promise<void>
let ctx: VaultContext
let api: TestApi
let scope: GatewayScope
let endpointId: string
let client: Client | null = null
/** Every wait pacing asked for, in milliseconds. */
let waits: number[]
let now: number

function spec(origin: string) {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Things", version: "1" },
    servers: [{ url: origin }],
    paths: {
      "/echo": {
        get: {
          operationId: "echo",
          parameters: [{ name: "q", in: "query", schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
      "/count": {
        get: {
          operationId: "count",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  })
}

beforeEach(async () => {
  vi.stubEnv("PCP_PACING", "")
  resetPacing()
  waits = []
  // From the real time: a run's deadline is the real clock's (code/run.ts).
  now = Date.now()
  setPacingClock({
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms)
      now += ms
    },
    random: () => 0,
  })
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  api = await startTestApi((req, res) => {
    if (req.url === "/moved") {
      res.statusCode = 302
      res.setHeader("location", "/count")
      res.end()
      return
    }

    json(res, 200, { got: req.url })
  })
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
    runCode: true,
    webFetch: true,
  })
  scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  await writeToolAccess(scope.tokenId, endpointId, "count", "allowed")
  await setPacingServer(ctx, endpointId, PAUSE)
})

afterEach(async () => {
  await client?.close()
  client = null
  await api.close()
  await cleanup()
  setPacingClock(null)
  resetPacing()
  vi.unstubAllEnvs()
})

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
  const connected = await connect()
  const result = await connected.callTool({
    name,
    arguments:
      name === "call_tool" ? await withCallHandle(connected, args) : args,
  })
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("")

  return {
    isError: result.isError === true,
    text,
    structured: result.structuredContent,
  }
}

const COUNT = { server: "things", tool: "count", arguments: {} }

describe("pacing, whatever the way in", () => {
  it("holds call_tool to the server's pace", async () => {
    expect((await call("call_tool", COUNT)).isError).toBe(false)
    expect(waits).toEqual([])
    expect((await call("call_tool", COUNT)).isError).toBe(false)
    expect(waits).toEqual([5_000])
    expect(api.requests).toHaveLength(2)
  })

  it("answers past the longest wait with when to try again, and sends nothing", async () => {
    await setPacingServer(ctx, endpointId, {
      minIntervalMs: 90_000,
      jitterMs: 0,
      burst: null,
    })
    await call("call_tool", COUNT)
    const second = await call("call_tool", COUNT)

    expect(second.isError).toBe(true)
    expect(second.text).toContain(
      "Paced: Things takes its next action in 90 s, longer than this call can wait (45 s). Nothing was sent and no turn was kept for it; try again in 90 s.",
    )
    expect(second.structured).toEqual({
      code: "paced",
      retry_after_ms: 90_000,
    })
    expect(waits).toEqual([])
    expect(api.requests).toHaveLength(1)
  })

  it("lets call_tool wait its whole budget, past the default longest wait", async () => {
    await setPacingServer(ctx, endpointId, {
      minIntervalMs: PACING_CALL_WAIT_MS,
      jitterMs: 0,
      burst: null,
    })
    await call("call_tool", COUNT)
    const second = await call("call_tool", COUNT)

    expect(second.isError).toBe(false)
    expect(waits).toEqual([PACING_CALL_WAIT_MS])
    expect(api.requests).toHaveLength(2)
  })

  it("lets run_code's pcp.call wait for its turn within the run, rather than fail half done", async () => {
    await setPacingServer(ctx, endpointId, {
      minIntervalMs: 90_000,
      jitterMs: 0,
      burst: null,
    })
    const result = await call("run_code", {
      code: `await pcp.call("things", "count", {}); await pcp.call("things", "count", {}); return "done"`,
    })

    expect(result.text).toContain("done")
    expect(waits).toEqual([90_000])
    expect(api.requests).toHaveLength(2)
  })

  it("tells run_code's program a call past the run's end was paced, with when to try again", async () => {
    await setPacingServer(ctx, endpointId, {
      minIntervalMs: 10 * 60_000,
      jitterMs: 0,
      burst: null,
    })
    const result = await call("run_code", {
      code: `await pcp.call("things", "count", {})
try {
  await pcp.call("things", "count", {})
  return "sent"
} catch (error) {
  return { code: error.code, retryAfterMs: error.retryAfterMs, message: error.message }
}`,
    })

    expect(result.text).toContain('"code":"paced"')
    expect(result.text).toContain(`"retryAfterMs":${10 * 60_000}`)
    expect(result.text).toContain("Nothing was sent")
    expect(waits).toEqual([])
    expect(api.requests).toHaveLength(1)
  })

  it("holds run_code's pcp.call to it", async () => {
    const result = await call("run_code", {
      code: `await pcp.call("things", "count", {}); await pcp.call("things", "count", {}); return "done"`,
    })

    expect(result.text).toContain("done")
    expect(waits).toEqual([5_000])
    expect(api.requests).toHaveLength(2)
  })

  it("holds a wrapper's calls to it", async () => {
    const asked = await call("create_wrapper", {
      name: "Twice",
      description: "Counts twice.",
      tools: [
        {
          name: "count_twice",
          description: "Counts, twice.",
          inputSchema: { type: "object" },
          program:
            'await pcp.call("things", "count", {}); return await pcp.call("things", "count", {})',
          calls: ["things/count"],
        },
      ],
    })
    expect(asked.text).toContain("Not done yet")
    const row = await db().permissionRequest.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    })
    await decidePermission(ctx, row.id, "allow_once", { publicUrl: PUBLIC_URL })
    const wrapper = await db().mcpServer.findFirstOrThrow({
      where: { kind: "wrapper" },
    })
    await writeToolAccess(scope.tokenId, wrapper.id, "count_twice", "allowed")

    const result = await call("call_tool", {
      server: "twice",
      tool: "count_twice",
      arguments: {},
    })

    expect(result.isError).toBe(false)
    expect(waits).toEqual([5_000])
    expect(api.requests).toHaveLength(2)
  })

  it("holds a call the owner allowed to it", async () => {
    await call("call_tool", COUNT)
    const asked = await call("call_tool", {
      server: "things",
      tool: "echo",
      arguments: { q: "hi" },
    })
    expect(asked.text).toContain("Not done yet")
    const row = await db().permissionRequest.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    })

    const answer = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
    })

    expect(answer.isError).not.toBe(true)
    expect(waits).toEqual([5_000])
    expect(api.requests.map((request) => request.url)).toEqual([
      "/count",
      "/echo?q=hi",
    ])
  })

  it("holds web_fetch to the site's pace, each redirect on the site included", async () => {
    const host = new URL(api.origin).host
    await setFetchSite(ctx, scope.tokenId, host, "allowed")
    await setFetchPrivate(ctx, scope.tokenId, "allowed")
    await setPacingSite(ctx, {
      site: host,
      subdomains: false,
      pace: { minIntervalMs: 4_000, jitterMs: 0, burst: null },
    })

    const first = await call("web_fetch", { url: `${api.origin}/count` })
    expect(first.isError).toBe(false)
    expect(waits).toEqual([])

    const moved = await call("web_fetch", { url: `${api.origin}/moved` })
    expect(moved.text).toContain("/count")
    // Once for the request, once for the redirect it followed.
    expect(waits).toEqual([4_000, 4_000])
    expect(api.requests.map((request) => request.url)).toEqual([
      "/count",
      "/moved",
      "/count",
    ])
  })

  it("answers web_fetch past its budget with when to try again, and sends nothing", async () => {
    const host = new URL(api.origin).host
    await setFetchSite(ctx, scope.tokenId, host, "allowed")
    await setFetchPrivate(ctx, scope.tokenId, "allowed")
    await setPacingSite(ctx, {
      site: host,
      subdomains: false,
      pace: { minIntervalMs: 60_000, jitterMs: 0, burst: null },
    })

    await call("web_fetch", { url: `${api.origin}/count` })
    const second = await call("web_fetch", { url: `${api.origin}/count` })

    expect(second.isError).toBe(true)
    expect(second.text).toContain(
      `Paced: ${host} takes its next action in 60 s, longer than this call can wait (45 s).`,
    )
    expect(second.structured).toEqual({
      code: "paced",
      retry_after_ms: 60_000,
    })
    expect(api.requests).toHaveLength(1)
  })

  it("lets a class the owner left unpaced go at once", async () => {
    await setPacingServer(ctx, endpointId, null)
    await setPacingClass(ctx, "server_read", "unpaced")
    await setPacingClass(ctx, "server_change", "unpaced")

    await call("call_tool", COUNT)
    await call("call_tool", COUNT)
    expect(waits).toEqual([])
  })
})
