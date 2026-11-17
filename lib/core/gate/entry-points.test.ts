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
import { decidePermission, getPermissionView } from "../permissions"
import { scratchDatabase } from "../test-db"
import { entryCall, withCallHandle } from "../test-handles"
import { writeToolAccess } from "../tool-access"
import { setupVault } from "../vault"
import { setFetchPrivate, setFetchSite } from "../web-fetch"
import { serverCooling } from "./index"
import { resetGate } from "./places"
import { createMailAccount } from "../mail/accounts"
import { clearMailDiagnostics, recordMailCall } from "../mail/diagnostics"
import { createSecret } from "../secrets"
import { serverLimitsView } from "./proposals"
import { readServerLimits, writeServerLimits } from "./store"

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
/** /count says its rate limit has nothing left for a second. */
let spent: boolean

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
  spent = false
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

    if (spent && req.url === "/count") {
      res.setHeader("x-ratelimit-remaining", "0")
      res.setHeader("x-ratelimit-reset", "1")
      json(res, 200, { got: req.url })
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
  await writeToolAccess(ctx, scope.tokenId, endpointId, "count", "allowed")
  await writeToolAccess(ctx, scope.tokenId, endpointId, "slow", "allowed")
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
      /^Things is cooling down: The API answered HTTP 429: it asks PCP to slow down\. Nothing was sent; try again in \d+ s\./,
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
    await writeToolAccess(
      ctx,
      scope.tokenId,
      wrapper.id,
      "count_once",
      "allowed",
    )
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

  it("holds the next call until a spent rate limit resets, and cools nothing down", async () => {
    spent = true
    expect((await call("execute_read", COUNT)).isError).toBe(false)
    spent = false

    const started = Date.now()
    const second = await call("execute_read", COUNT)

    expect(second.isError).toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(serverCooling(ctx, endpointId)).toBeNull()
    expect(api.requests).toHaveLength(2)
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
    expect(second.text).toMatch(
      /is cooling down: .* answered HTTP 429: it asks PCP to slow down/,
    )
    expect(api.requests).toHaveLength(1)
  })
})

describe("the limits tools", () => {
  async function own(name: string, args: Record<string, unknown>) {
    const connected = await connect()
    const result = await connected.callTool(
      entryCall(name.startsWith("get_") ? "execute_read" : "execute_write", {
        tool: name,
        arguments: args,
      }),
    )
    return {
      isError: result.isError === true,
      text: (result.content as Array<{ text?: string }>)
        .map((part) => part.text ?? "")
        .join(""),
      structured: result.structuredContent as Record<string, unknown>,
    }
  }

  it("read a server's limits, which are its own, and its load", async () => {
    await writeServerLimits(ctx, endpointId, { maxConcurrent: 3 })
    await call("execute_read", COUNT)

    const read = await own("get_server_limits", { server: "things" })

    expect(read.isError).toBe(false)
    expect(read.structured).toMatchObject({
      server: "things",
      own: { max_concurrent: 3 },
      limits: {
        max_concurrent: 3,
        timeout_ms: 60_000,
        calls_per_minute: "none",
      },
      cooling: null,
      last_hour: { calls: 1, errors: 0 },
    })
    expect(read.text).toContain("calls at once 3, ")
    expect((await own("get_server_limits", { server: "nope" })).isError).toBe(
      true,
    )
  })

  it("propose limits the owner sees now against proposed, edits and saves over what they saw", async () => {
    await writeServerLimits(ctx, endpointId, { timeoutMs: 30_000 })
    const asked = await own("propose_server_limits", {
      server: "things",
      limits: { max_concurrent: 1, timeout_ms: "default" },
      note: "Its documentation allows one connection at a time.",
    })
    expect(asked.text).toContain("Not done yet")

    const row = await db().permissionRequest.findFirstOrThrow({
      where: { kind: "limits_change" },
    })
    const view = await getPermissionView(ctx, row.id, {
      publicUrl: PUBLIC_URL,
    })
    expect(view!.title).toBe("Change the limits of Things?")
    expect(view!.lines).toEqual(
      expect.arrayContaining([
        "Calls at once: 8 (PCP's default) → 1",
        "Time limit per call: 30 s → 1 minute (PCP's default)",
        "Why, in the assistant's words: Its documentation allows one connection at a time.",
      ]),
    )
    expect(
      view!.proposedLimits!.fields.find((f) => f.field === "maxConcurrent"),
    ).toMatchObject({ value: 1 })

    // The owner makes it two, and saves.
    const answer = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
      limits: { maxConcurrent: 2 },
    })
    expect(answer.isError).not.toBe(true)
    expect(await readServerLimits(ctx, endpointId)).toEqual({
      maxConcurrent: 2,
    })
  })

  it("save nothing over limits that changed since the owner was asked", async () => {
    await own("propose_server_limits", {
      server: "things",
      limits: { calls_per_minute: 20 },
      note: "It allows 20 a minute.",
    })
    const row = await db().permissionRequest.findFirstOrThrow({
      where: { kind: "limits_change" },
    })
    await writeServerLimits(ctx, endpointId, { maxConcurrent: 4 })

    const answer = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
    })

    expect(answer.isError).toBe(true)
    expect(JSON.stringify(answer.content)).toContain("have changed since")
    expect(await readServerLimits(ctx, endpointId)).toEqual({
      maxConcurrent: 4,
    })
  })

  it("say how a mail account's last calls went, phase by phase, on its page and in the tool", async () => {
    const { id: secretId } = await createSecret(ctx, {
      name: "Mail password",
      value: "hunter22",
    })
    const { id: mailId } = await createMailAccount(ctx, {
      protocol: "imap",
      name: "Mail",
      url: "imaps://mail.example.com:993",
      readOnly: false,
      authType: "basic",
      authUsername: "ada@example.com",
      authSecretId: secretId,
    })
    recordMailCall(mailId, {
      tool: "search_emails",
      phases: {
        connect: 120,
        login: 300,
        select: 40,
        command: 900,
        logout: 20,
      },
      notices: ["[ALERT] Your account is over quota"],
      reused: false,
      outcome: "ok",
    })

    const read = await own("get_server_limits", { server: "mail" })
    expect(read.structured).toMatchObject({
      limits: { max_concurrent: 2, timeout_ms: 45_000 },
      mail_calls: [
        {
          tool: "search_emails",
          outcome: "ok",
          reused_connection: false,
          phases_ms: { connect: 120, login: 300, command: 900 },
          notices: ["[ALERT] Your account is over quota"],
        },
      ],
    })
    // Not for any other kind.
    expect(
      (await own("get_server_limits", { server: "things" })).structured,
    ).not.toHaveProperty("mail_calls")

    const view = await serverLimitsView(ctx, { id: mailId, kind: "imap" })
    expect(view!.mailCalls).toHaveLength(1)
    expect(
      (await serverLimitsView(ctx, { id: endpointId, kind: "openapi" }))!
        .mailCalls,
    ).toEqual([])
    clearMailDiagnostics(mailId)
  })

  it("ask nothing when nothing changes, and want a note", async () => {
    await writeServerLimits(ctx, endpointId, { maxConcurrent: 1 })
    const same = await own("propose_server_limits", {
      server: "things",
      limits: { max_concurrent: 1 },
      note: "Already so.",
    })
    expect(same.text).toContain("Nothing to propose")

    const bare = await own("propose_server_limits", {
      server: "things",
      limits: { max_concurrent: 2 },
      note: " ",
    })
    expect(bare.isError).toBe(true)
    expect(await db().permissionRequest.count()).toBe(0)
  })
})
