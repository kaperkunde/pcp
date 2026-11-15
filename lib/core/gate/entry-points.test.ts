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
import { entryCall, withCallHandle } from "../test-handles"
import { writeToolAccess } from "../tool-access"
import { setupVault } from "../vault"
import { setFetchPrivate, setFetchSite } from "../web-fetch"
import { resetGate } from "./state"
import { writeServerLimits } from "./store"

// The gate holds whatever way a call comes in, as pacing does (it sits in
// upstream.ts callServerTool and web fetch's request path): execute_<tier>,
// run_<tier>'s pcp.call, a wrapper's call and a call the owner allowed each
// meet the same cool-down and time limit, with the same error shape: code
// "paced" (or "timeout") in _meta["gg.pcp/error"], and retryAfterMs.

const PUBLIC_URL = "http://localhost:3000"

let cleanup: () => Promise<void>
let ctx: VaultContext
let api: TestApi
let scope: GatewayScope
let endpointId: string
let client: Client | null = null
/** What /count answers: 200, or 429 asking for a minute. */
let throttling: boolean
/** How long /slow takes. */
let slowMs: number

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
      "/slow": {
        get: {
          operationId: "slow",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  })
}

beforeEach(async () => {
  resetGate()
  throttling = false
  slowMs = 0
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  api = await startTestApi((req, res) => {
    if (req.url === "/slow") {
      setTimeout(() => json(res, 200, { slow: true }), slowMs)
      return
    }

    if (throttling && (req.url === "/count" || req.url === "/page")) {
      res.statusCode = 429
      res.setHeader("retry-after", "60")
      res.setHeader("content-type", "application/json")
      res.end('{"error":"slow down"}')
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
  await writeToolAccess(scope.tokenId, endpointId, "slow", "allowed")
})

afterEach(async () => {
  await client?.close()
  client = null
  await api.close()
  await cleanup()
  resetGate()
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
  const result = await connected.callTool(
    entryCall(
      name,
      name.startsWith("execute_")
        ? await withCallHandle(connected, args)
        : args,
    ),
  )
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("")

  return {
    isError: result.isError === true,
    text,
    error: result._meta?.["gg.pcp/error"] as
      { code?: string; retryAfterMs?: number } | undefined,
  }
}

const COUNT = { server: "things", tool: "count", arguments: {} }

/** The endpoint asks to slow down once, and is left to cool down. */
async function throttled() {
  throttling = true
  const first = await call("execute_read", COUNT)
  expect(first.isError).toBe(true)
  expect(first.text).toContain("PCP lets Things cool down for 60 s")
  throttling = false
  expect(api.requests).toHaveLength(1)
}

describe("the call gate, whatever the way in", () => {
  it("refuses execute_read's call fast while the server cools down, as paced", async () => {
    await throttled()
    const second = await call("execute_read", COUNT)

    expect(second.isError).toBe(true)
    expect(second.text).toMatch(
      /^Things is cooling down: it answered HTTP 429 \(too many requests\)\. Nothing was sent; try again in \d+ s\./,
    )
    expect(second.error).toMatchObject({ code: "paced" })
    expect(second.error!.retryAfterMs).toBeGreaterThan(55_000)
    expect(api.requests).toHaveLength(1)
  })

  it("throws the same to a program's pcp.call", async () => {
    await throttled()
    const result = await call("run_read", {
      code: `try {
  await pcp.call("things", "count", {})
  return "sent"
} catch (error) {
  return { code: error.code, later: error.retryAfterMs > 55000 }
}`,
    })

    expect(result.text).toContain('"code":"paced"')
    expect(result.text).toContain('"later":true')
    expect(api.requests).toHaveLength(1)
  })

  it("refuses a wrapper's call the same way", async () => {
    const asked = await call("create_wrapper", {
      name: "Counter",
      description: "Counts.",
      tools: [
        {
          name: "count_once",
          description: "Counts once.",
          inputSchema: { type: "object" },
          program: `try { return await pcp.call("things", "count", {}) } catch (error) { return { code: error.code } }`,
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
    await writeToolAccess(scope.tokenId, wrapper.id, "count_once", "allowed")
    await throttled()

    const result = await call("execute_destructive", {
      server: "counter",
      tool: "count_once",
      arguments: {},
    })

    expect(result.text).toContain('"code":"paced"')
    expect(api.requests).toHaveLength(1)
  })

  it("refuses a call the owner allowed while the server cools down", async () => {
    const asked = await call("execute_read", {
      server: "things",
      tool: "echo",
      arguments: { q: "hi" },
    })
    expect(asked.text).toContain("Not done yet")
    const row = await db().permissionRequest.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    })
    await throttled()

    const answer = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
    })

    expect(answer.isError).toBe(true)
    expect(JSON.stringify(answer.content)).toContain("is cooling down")
    expect(api.requests.map((request) => request.url)).toEqual(["/count"])
  })

  it("answers timeout naming the server and its limit, not after the run's minutes", async () => {
    await writeServerLimits(ctx, endpointId, { timeoutMs: 1_000 })
    slowMs = 3_000
    const started = Date.now()
    const result = await call("execute_read", {
      server: "things",
      tool: "slow",
      arguments: {},
    })

    expect(Date.now() - started).toBeLessThan(2_500)
    expect(result.error).toMatchObject({ code: "timeout" })
    expect(result.text).toContain(
      "Things did not answer within 1 s, its time limit for a call",
    )
  })

  it("cools a site down on web_fetch's 429, and refuses it fast", async () => {
    const host = new URL(api.origin).host
    await setFetchSite(ctx, scope.tokenId, host, "allowed")
    await setFetchPrivate(ctx, scope.tokenId, "allowed")
    throttling = true

    const first = await call("web_fetch", { url: `${api.origin}/page` })
    expect(first.text).toContain(`PCP lets ${host} cool down until`)
    const second = await call("web_fetch", { url: `${api.origin}/page` })

    expect(second.error).toMatchObject({ code: "paced" })
    expect(second.text).toMatch(/is cooling down: it answered HTTP 429/)
    expect(api.requests).toHaveLength(1)
  })
})
