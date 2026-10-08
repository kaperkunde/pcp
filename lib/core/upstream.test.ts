import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { NEW_SECRET } from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { createMailAccount } from "./mail/accounts"
import { createFakeJmap, type FakeJmap } from "./mail/fake-jmap"
import { oauthRedirectUrl } from "./oauth-client"
import { json, startTestApi, type TestApi } from "./openapi/test-api"
import { createServer, getServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { callServerTool, PcpOAuthProvider, syncServerTools } from "./upstream"
import { setupVault } from "./vault"

// The bearer token PCP sends to a server it calls itself (a JMAP mail
// account that signs in with OAuth): renewed before it runs out, renewed
// when refused, and "needs connecting" when it cannot be.

const PUBLIC = { publicUrl: "http://localhost:3000" }

let cleanup: () => Promise<void>
let ctx: VaultContext
let api: TestApi
let fake: FakeJmap
/** What the token endpoint received, and what it answers next. */
let tokenRequests: URLSearchParams[]
let tokenAnswer: { status: number; body: Record<string, unknown> }
/** The access token the mail server takes. */
let valid: string

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  tokenRequests = []
  tokenAnswer = {
    status: 200,
    body: { access_token: "at-2", token_type: "Bearer", expires_in: 3600 },
  }
  valid = "at-1"
  fake = createFakeJmap({ authorize: (header) => header === `Bearer ${valid}` })
  api = await startTestApi((request, res) => {
    const path = request.url.split("?")[0]!

    if (path === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: api.origin,
        authorization_endpoint: `${api.origin}/authorize`,
        token_endpoint: `${api.origin}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      })
    }

    if (path === "/token") {
      tokenRequests.push(new URLSearchParams(request.body))
      return json(res, tokenAnswer.status, tokenAnswer.body)
    }

    const answer = fake.handle(request)
    res.statusCode = answer?.status ?? 404
    res.setHeader("content-type", answer?.type ?? "application/json")
    res.end(answer?.body ?? "{}")
  })
})

afterEach(async () => {
  await api.close()
  await cleanup()
})

async function connected(tokens: Record<string, unknown> | null) {
  const { id } = await createMailAccount(ctx, {
    protocol: "jmap",
    name: "Mail",
    url: `${api.origin}/jmap/session`,
    readOnly: false,
    authType: "oauth",
  })
  const server = await getServer(ctx, id)
  const provider = new PcpOAuthProvider(ctx, server, {
    redirectUrl: oauthRedirectUrl(PUBLIC.publicUrl),
    publicUrl: PUBLIC.publicUrl,
  })
  await provider.saveClientInformation({
    client_id: "pcp-client",
    issuer: api.origin,
  })

  if (tokens) {
    await provider.saveTokens({ token_type: "Bearer", ...tokens } as never)
  }

  return getServer(ctx, id)
}

describe("a JMAP account signed in with OAuth", () => {
  it("reads the session with a live token as it is", async () => {
    const server = await connected({
      access_token: "at-1",
      expires_in: 3600,
      refresh_token: "rt-1",
    })

    expect(await syncServerTools(ctx, server, PUBLIC)).toMatchObject({
      status: "ok",
      toolCount: 16,
    })
    expect(fake.requests[0]!.authorization).toBe("Bearer at-1")
    expect(tokenRequests).toHaveLength(0)
  })

  it("renews a token about to run out, before using it", async () => {
    const server = await connected({
      access_token: "at-1",
      expires_in: 30,
      refresh_token: "rt-1",
    })
    valid = "at-2"

    expect(await syncServerTools(ctx, server, PUBLIC)).toMatchObject({
      status: "ok",
    })
    expect(tokenRequests).toHaveLength(1)
    expect(Object.fromEntries(tokenRequests[0]!)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt-1",
      client_id: "pcp-client",
    })
    expect(fake.requests.map((request) => request.authorization)).toEqual([
      "Bearer at-2",
    ])
    expect((await getServer(ctx, server.id)).oauthConnectedAt).not.toBeNull()
  })

  it("needs connecting without tokens, or when they ran out and cannot be renewed", async () => {
    for (const tokens of [null, { access_token: "at-1", expires_in: 30 }]) {
      const server = await connected(tokens)

      expect(await syncServerTools(ctx, server, PUBLIC)).toMatchObject({
        status: "auth_required",
        toolCount: 0,
      })
      expect((await getServer(ctx, server.id)).oauthConnectedAt).toBeNull()
    }

    expect(tokenRequests).toHaveLength(0)
    expect(fake.requests).toHaveLength(0)
  })

  it("gives up and forgets the tokens when the renewal is refused", async () => {
    const server = await connected({
      access_token: "at-1",
      expires_in: 3600,
      refresh_token: "rt-1",
    })
    valid = "never"
    tokenAnswer = { status: 400, body: { error: "invalid_grant" } }

    await expect(
      callServerTool(ctx, server, "list_mailboxes", {}, PUBLIC),
    ).rejects.toMatchObject({ code: "unauthorized" })
    expect(tokenRequests).toHaveLength(1)
    const row = await db().mcpServer.findUniqueOrThrow({
      where: { id: server.id },
    })
    expect(row.status).toBe("auth_required")
    expect(row.oauthConnectedAt).toBeNull()
  })

  it("renews a refused token once and carries on, with neither token in the answer", async () => {
    const server = await connected({
      access_token: "at-1",
      expires_in: 3600,
      refresh_token: "rt-1",
    })
    await syncServerTools(ctx, server, PUBLIC)
    valid = "at-2"

    const result = await callServerTool(
      ctx,
      await getServer(ctx, server.id),
      "list_mailboxes",
      {},
      PUBLIC,
    )

    expect(result.isError).toBeUndefined()
    expect(tokenRequests).toHaveLength(1)
    expect(
      fake.requests.slice(-2).map((request) => request.authorization),
    ).toEqual(["Bearer at-1", "Bearer at-2"])
    expect(JSON.stringify(result)).not.toMatch(/at-1|at-2/)
  })

  it("asks to be connected again when the renewed token is refused too", async () => {
    const server = await connected({
      access_token: "at-1",
      expires_in: 3600,
      refresh_token: "rt-1",
    })
    valid = "never"

    await expect(
      callServerTool(ctx, server, "list_mailboxes", {}, PUBLIC),
    ).rejects.toMatchObject({ code: "unauthorized" })
    const row = await db().mcpServer.findUniqueOrThrow({
      where: { id: server.id },
    })
    expect(row.status).toBe("auth_required")
    expect(row.statusMessage).toMatch(/needs to be connected/)
  })
})

describe("an MCP server that repeats its credential", () => {
  const KEY = "sk-live-echoed-0123456789"
  let mcp: TestApi

  beforeEach(async () => {
    // A stateless server that puts the key it was sent everywhere it can:
    // its tool list, a tool's answer, and an error's description.
    mcp = await startTestApi((request, res) => {
      if (request.method !== "POST") {
        res.statusCode = 405
        return res.end()
      }

      const sent = String(request.headers["x-api-key"])
      const { id, method, params } = JSON.parse(request.body) as {
        id?: number
        method: string
        params?: { name?: string }
      }
      const answer = (result: unknown) =>
        json(res, 200, { jsonrpc: "2.0", id, result })

      if (id === undefined) {
        res.statusCode = 202
        return res.end()
      }

      if (method === "initialize") {
        return answer({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "echo", version: "1" },
          instructions: `Signed in with ${sent}.`,
        })
      }

      if (method === "tools/list") {
        return answer({
          tools: [
            {
              name: "whoami",
              description: `Says who ${sent} is.`,
              inputSchema: { type: "object", default: { key: sent } },
            },
          ],
        })
      }

      if (params?.name === "fail") {
        return json(res, 400, {
          error: "invalid_request",
          error_description: `Unknown key: ${sent}`,
        })
      }

      return answer({
        content: [{ type: "text", text: `X-API-Key: ${sent}` }],
        structuredContent: { headers: { "x-api-key": sent } },
      })
    })
  })

  afterEach(async () => {
    await mcp.close()
  })

  async function echoServer() {
    const { id } = await createServer(ctx, {
      name: "Echo",
      url: `${mcp.origin}/mcp`,
      authType: "header",
      authHeaderName: "X-API-Key",
      authValueTemplate: "{{secret}}",
      authSecretId: NEW_SECRET,
      authSecretValue: KEY,
    })
    return getServer(ctx, id)
  }

  it("takes it out of the tool list, a tool's answer and an error", async () => {
    const server = await echoServer()

    expect((await syncServerTools(ctx, server, PUBLIC)).status).toBe("ok")
    const stored = await db().mcpServer.findUniqueOrThrow({
      where: { id: server.id },
      include: { tools: true },
    })
    expect(JSON.stringify(stored)).not.toContain(KEY)
    expect(stored.tools[0]!.description).toBe("Says who [redacted] is.")

    const result = await callServerTool(ctx, server, "whoami", {}, PUBLIC)
    expect(result.content).toEqual([
      { type: "text", text: "X-API-Key: [redacted]" },
    ])
    expect(result.structuredContent).toEqual({
      headers: { "x-api-key": "[redacted]" },
    })
    // It was sent all the same.
    expect(mcp.requests.at(-1)!.headers["x-api-key"]).toBe(KEY)

    await expect(
      callServerTool(ctx, server, "fail", {}, PUBLIC),
    ).rejects.toThrow(/Unknown key: \[redacted\]/)
    expect((await getServer(ctx, server.id)).statusMessage).not.toContain(KEY)
  })
})
