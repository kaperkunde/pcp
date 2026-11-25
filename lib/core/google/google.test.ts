import { createHash } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import { exportVault, readExport, restoreExport } from "../backup"
import { isConnectResult } from "../connect"
import type { VaultContext } from "../context"
import { db } from "../db"
import { isPcpError, PcpError } from "../errors"
import { oauthRedirectUrl } from "../oauth-client"
import { json, startTestApi, type TestApi } from "../openapi/test-api"
import { runCall } from "../permissions"
import { readSecretScopes } from "../secret-scope"
import { secretUses } from "../secret-uses"
import { createSecret, deleteSecret, revealSecret } from "../secrets"
import { getServer, listServers, updateServer } from "../servers"
import { scratchDatabase } from "../test-db"
import { callServerTool, googleAccessToken } from "../upstream"
import { setupVault } from "../vault"
import { disconnectOAuth, startOAuth } from "../oauth"
import {
  disconnectGoogle,
  finishGoogleConnect,
  googleStateFor,
  googleView,
  removeGoogle,
  saveGoogleSettings,
  startGoogleConnect,
} from "./account"
import { setGoogleEndpointsForTest } from "./endpoints"
import { ensureGoogleAccount, loadGoogleAccount } from "./meta"
import { resolveSecretRef } from "../secret-refs"
import { GOOGLE_PRODUCTS, scopesOf } from "./products"

// The vault's Google sign-in (kaperkunde/pcp#179), against a fake Google in
// the test process: its consent address is only built (the browser goes
// there), its token, revoke and userinfo addresses answer, and each product's
// MCP server answers at /mcp/<product>.

const PUBLIC_URL = "https://pcp.example.com"
const CLIENT_ID = "1234-abc.apps.googleusercontent.com"
const CLIENT_SECRET = "GOCSPX-client-secret-0123456789"
const NINE = [
  "gmail",
  "calendar",
  "search",
  "drive",
  "docs",
  "sheets",
  "slides",
  "tasks",
  "people",
]

let cleanup: () => Promise<void>
let ctx: VaultContext
let google: TestApi
/** Access tokens the products' servers take right now. */
let accepted: Set<string>
/** The tokens the token address hands out, in turn; the last repeats. */
let accessTokens: string[]
/** How long the token address takes to answer. */
let tokenDelayMs: number
/** What the token address answers to a refresh, when not the usual. */
let refreshAnswer: [number, Record<string, unknown>] | null
let expiresIn: number
let rotateRefresh: string | null
/** The refresh token Google takes now. */
let currentRefresh = "rt-1"
/** What Google would show as granted, as a space-separated list. */
let grantedScope: string | null
/** The PKCE challenge the last consent address carried. */
let challenge = ""

const form = (body: string) => Object.fromEntries(new URLSearchParams(body))

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  accepted = new Set(["at-1"])
  accessTokens = ["at-1", "at-2", "at-3"]
  tokenDelayMs = 0
  refreshAnswer = null
  expiresIn = 3600
  rotateRefresh = null
  currentRefresh = "rt-1"
  grantedScope = null
  challenge = ""
  google = await startTestApi(async (req, res) => {
    const path = req.url.split("?")[0]!

    if (path === "/token") {
      const params = form(req.body)

      if (tokenDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, tokenDelayMs))
      }

      if (
        params.client_id !== CLIENT_ID ||
        params.client_secret !== CLIENT_SECRET
      ) {
        return json(res, 401, { error: "invalid_client" })
      }

      if (params.grant_type === "authorization_code") {
        const proof = createHash("sha256")
          .update(params.code_verifier ?? "")
          .digest("base64url")

        if (params.code !== "the-code" || proof !== challenge) {
          return json(res, 400, { error: "invalid_grant" })
        }

        return json(res, 200, {
          access_token: accessTokens.shift() ?? "at-late",
          refresh_token: "rt-1",
          expires_in: expiresIn,
          scope: grantedScope,
          token_type: "Bearer",
        })
      }

      if (refreshAnswer) {
        return json(res, refreshAnswer[0], refreshAnswer[1])
      }

      if (params.refresh_token !== currentRefresh) {
        return json(res, 400, { error: "invalid_grant" })
      }

      const next = accessTokens.shift() ?? "at-late"
      accepted.add(next)
      const rotated = rotateRefresh
      if (rotated) currentRefresh = rotated

      return json(res, 200, {
        access_token: next,
        expires_in: 3600,
        scope: grantedScope,
        token_type: "Bearer",
        ...(rotated ? { refresh_token: rotated } : {}),
      })
    }

    if (path === "/revoke") {
      return json(res, 200, {})
    }

    if (path === "/userinfo") {
      return req.headers.authorization
        ? json(res, 200, { email: "ada@example.com" })
        : json(res, 401, {})
    }

    const product = path.match(/^\/mcp\/([a-z]+)$/)?.[1]

    if (!product || req.method !== "POST") {
      res.statusCode = 405
      return res.end()
    }

    const { id, method } = JSON.parse(req.body) as {
      id?: number
      method: string
    }

    if (id === undefined) {
      res.statusCode = 202
      return res.end()
    }

    // Google answers the handshake and the tool list to anyone; the token is
    // checked on a call.
    if (method === "initialize") {
      return json(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: product, version: "1" },
        },
      })
    }

    if (method === "tools/list") {
      return json(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: `${product}_find`,
              description: `Finds things in ${product}.`,
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      })
    }

    const sent = (req.headers.authorization ?? "").replace(/^Bearer /, "")

    if (!accepted.has(sent)) {
      res.setHeader("www-authenticate", 'Bearer error="invalid_token"')
      return json(res, 401, { error: { code: 401, status: "UNAUTHENTICATED" } })
    }

    json(res, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `found with Bearer ${sent}` }],
      },
    })
  })
  setGoogleEndpointsForTest({
    authorize: `${google.origin}/authorize`,
    token: `${google.origin}/token`,
    revoke: `${google.origin}/revoke`,
    userinfo: `${google.origin}/userinfo`,
    mcp: (product) => `${google.origin}/mcp/${product}`,
    privateAddresses: true,
  })
})

afterEach(async () => {
  vi.useRealTimers()
  setGoogleEndpointsForTest()
  await google.close()
  await cleanup()
})

/** Two hours on: the access PCP holds has run out. */
function expire() {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)
}

function settings(
  extra: Partial<Parameters<typeof saveGoogleSettings>[1]> = {},
) {
  return {
    clientId: CLIENT_ID,
    clientSecretValue: CLIENT_SECRET,
    products: NINE,
    ...extra,
  }
}

/** Saves, goes to Google (as the browser would) and comes back. */
async function connect(
  input: Parameters<typeof saveGoogleSettings>[1] = settings(),
) {
  await saveGoogleSettings(ctx, input, { publicUrl: PUBLIC_URL })
  const { redirectTo } = await startGoogleConnect(ctx, {
    publicUrl: PUBLIC_URL,
  })
  const url = new URL(redirectTo)

  challenge = url.searchParams.get("code_challenge") ?? ""
  grantedScope ??= url.searchParams.get("scope")
  const finished = await finishGoogleConnect(
    ctx,
    new URLSearchParams({
      code: "the-code",
      state: url.searchParams.get("state")!,
    }),
    { publicUrl: PUBLIC_URL },
  )

  return { url, finished }
}

async function servers() {
  return (await listServers(ctx)).filter(
    (server) => server.authType === "google",
  )
}

describe("saving the owner's Google client", () => {
  it("takes a client ID that is Google's and a secret, and the products", async () => {
    await expect(
      saveGoogleSettings(ctx, settings({ clientId: "not-a-client" }), {
        publicUrl: PUBLIC_URL,
      }),
    ).rejects.toThrow(/not a Google client ID/)
    await expect(
      saveGoogleSettings(ctx, settings({ clientSecretValue: "" }), {
        publicUrl: PUBLIC_URL,
      }),
    ).rejects.toThrow(/Give the client secret/)
    await expect(
      saveGoogleSettings(ctx, settings({ products: ["gmail", "myspace"] }), {
        publicUrl: PUBLIC_URL,
      }),
    ).rejects.toThrow(/not a Google product/)
    // Nothing half-made is left behind by a refusal.
    expect(await loadGoogleAccount(ctx)).toBeNull()
    expect(await db().secret.count()).toBe(0)

    const saved = await saveGoogleSettings(ctx, settings(), {
      publicUrl: PUBLIC_URL,
    })

    expect(saved.needsConsent).toBe(true)
    expect(saved.account).toMatchObject({
      clientId: CLIENT_ID,
      status: "disconnected",
      products: NINE,
    })
    // Nothing is a server until Google has said yes.
    expect(await servers()).toEqual([])
  })

  it("keeps the secret as one of the owner's, in scope for the account alone", async () => {
    const { account } = await saveGoogleSettings(ctx, settings(), {
      publicUrl: PUBLIC_URL,
    })
    const secretId = account.clientSecretId!
    const uses = (await secretUses(ctx, [secretId])).get(secretId)!.uses

    expect(uses).toEqual([
      expect.objectContaining({
        kind: "Google account",
        via: "google_account",
        id: account.id,
      }),
    ])
    // Not anywhere: the secret is for the account, so no other server may
    // be given it without the owner's say.
    const scope = (await readSecretScopes(ctx, [secretId])).get(secretId)!

    expect(scope.anywhere).toBe(false)
    expect(scope.consumers.map((consumer) => consumer.name)).toEqual([
      "Google account",
    ])
    // It cannot be deleted while the account uses it.
    await expect(deleteSecret(ctx, secretId)).rejects.toThrow(
      /used by Google account/,
    )
  })

  it("checks the secret against its scope like any other use", async () => {
    const account = await ensureGoogleAccount(ctx)
    const consumer = { id: account.id, name: "Google account" }
    await createSecret(ctx, { name: "Not for Google", value: "x" })
    await createSecret(ctx, { name: "For all", value: "y", anywhere: true })

    // A secret the owner kept for something else is not the account's until
    // they pick it on the Google page (their pick is the grant).
    await expect(
      resolveSecretRef(ctx, "Not for Google", {
        kind: "google_account",
        consumer,
      }),
    ).rejects.toThrow(/change_secret_scope/)
    expect(
      await resolveSecretRef(ctx, "Not for Google", {
        kind: "google_account",
        consumer,
        scope: "ask",
      }),
    ).toMatchObject({ inScope: false })
    expect(
      await resolveSecretRef(ctx, "For all", {
        kind: "google_account",
        consumer,
      }),
    ).toMatchObject({ inScope: true })
    expect(
      await resolveSecretRef(ctx, "Not for Google", {
        kind: "google_account",
        consumer,
        scope: "granted",
      }),
    ).toMatchObject({ inScope: false })
  })

  it("takes another of the owner's text secrets by pick, and refuses a managed one", async () => {
    const mine = await createSecret(ctx, {
      name: "Google OAuth",
      value: CLIENT_SECRET,
    })

    const saved = await saveGoogleSettings(
      ctx,
      {
        clientId: CLIENT_ID,
        clientSecretId: mine.id,
        products: ["gmail"],
      },
      { publicUrl: PUBLIC_URL },
    )

    expect(saved.account.clientSecretId).toBe(mine.id)

    const { id: tokens } = await (
      await import("../secrets")
    ).writeManagedSecret(ctx, { name: "oauth/x", description: "", value: "{}" })

    await expect(
      saveGoogleSettings(
        ctx,
        { clientId: CLIENT_ID, clientSecretId: tokens, products: ["gmail"] },
        { publicUrl: PUBLIC_URL },
      ),
    ).rejects.toThrow(/Pick a text secret/)
  })
})

describe("connecting Google", () => {
  it("asks Google once, for every chosen product, with PKCE and no resource", async () => {
    await saveGoogleSettings(ctx, settings(), { publicUrl: PUBLIC_URL })
    const { redirectTo } = await startGoogleConnect(ctx, {
      publicUrl: PUBLIC_URL,
    })
    const url = new URL(redirectTo)
    const asked = url.searchParams.get("scope")!.split(" ")

    expect(url.origin + url.pathname).toBe(`${google.origin}/authorize`)
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID)
    expect(url.searchParams.get("redirect_uri")).toBe(
      oauthRedirectUrl(PUBLIC_URL),
    )
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/)
    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("prompt")).toBe("consent")
    expect(url.searchParams.get("include_granted_scopes")).toBe("true")
    expect(url.searchParams.has("resource")).toBe(false)
    expect(url.searchParams.has("client_secret")).toBe(false)
    expect(redirectTo).not.toContain(CLIENT_SECRET)
    // The union of the nine, once each, and who it is; not Chat or Classroom.
    expect(asked).toEqual(
      expect.arrayContaining([...scopesOf(NINE), "openid", "email"]),
    )
    expect(new Set(asked).size).toBe(asked.length)
    expect(asked.some((scope) => scope.includes("chat"))).toBe(false)
    expect(asked.some((scope) => scope.includes("classroom"))).toBe(false)
    expect(asked).toContain("https://www.googleapis.com/auth/drive.file")
    expect(asked).not.toContain("https://www.googleapis.com/auth/drive")
    expect(asked).not.toContain("https://www.googleapis.com/auth/gmail.send")
    // The state is PCP's, in this vault, and its verifier is not in the URL.
    expect(await googleStateFor(ctx, url.searchParams)).toBe(true)
    expect(await googleStateFor(ctx, new URLSearchParams({ state: "x" }))).toBe(
      false,
    )
    expect(redirectTo).not.toContain("code_verifier")
  })

  it("keeps the tokens encrypted, makes a server for each product and reads their tools", async () => {
    const { finished } = await connect()

    expect(finished.account).toMatchObject({
      status: "connected",
      email: "ada@example.com",
    })
    expect(finished.added).toHaveLength(9)

    // The token exchange carried the verifier and the owner's client.
    const exchange = google.requests.find((req) => req.url === "/token")!
    expect(form(exchange.body)).toMatchObject({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: oauthRedirectUrl(PUBLIC_URL),
    })

    // Encrypted at rest, under a managed secret no assistant can name.
    const tokens = await db().secret.findUniqueOrThrow({
      where: { id: finished.account.tokensId! },
    })

    expect(tokens.kind).toBe("oauth")
    expect(Buffer.from(tokens.ciphertext).toString("utf8")).not.toContain(
      "at-1",
    )
    expect(JSON.parse(await revealSecret(ctx, tokens.id))).toMatchObject({
      access_token: "at-1",
      refresh_token: "rt-1",
    })

    const bound = await servers()

    expect(bound.map((server) => server.slug).sort()).toEqual(
      NINE.map((id) => GOOGLE_PRODUCTS.find((p) => p.id === id)!.slug).sort(),
    )

    for (const server of bound) {
      expect(server).toMatchObject({
        kind: "mcp",
        authType: "google",
        connected: true,
        enabled: true,
        status: "ok",
        toolCount: 1,
      })
    }

    const gmail = await getServer(
      ctx,
      bound.find((server) => server.slug === "google-gmail")!.id,
    )

    expect(gmail).toMatchObject({
      name: "Google Gmail",
      accountId: finished.account.id,
      oauthClientId: null,
      oauthClientSecretId: null,
      oauthTokensId: null,
    })
    // Its tool's tier comes from the server's own hint, and it starts at
    // "ask": nothing was allowed for anyone.
    expect(await db().vaultToolAccess.count()).toBe(0)
    expect(await db().apiTokenToolAccess.count()).toBe(0)
    // The state is spent, and the sign-in cannot be replayed.
    expect(await db().oAuthAccountState.count()).toBe(0)
    await expect(
      finishGoogleConnect(
        ctx,
        new URLSearchParams({ code: "the-code", state: "gone" }),
        { publicUrl: PUBLIC_URL },
      ),
    ).rejects.toThrow(/not one PCP started/)
  })

  it("sends the access token on every call, scrubbed from the answer", async () => {
    await connect()
    const gmail = (await servers()).find((s) => s.slug === "google-gmail")!
    const result = await callServerTool(
      ctx,
      await getServer(ctx, gmail.id),
      "gmail_find",
      {},
      { publicUrl: PUBLIC_URL },
    )
    const text = (result.content[0] as { text: string }).text
    const call = google.requests.filter(
      (req) => req.url === "/mcp/gmail" && req.body.includes("tools/call"),
    )

    expect(call.at(-1)!.headers.authorization).toBe("Bearer at-1")
    // The upstream echoed its token; the assistant is not handed it.
    expect(text).not.toContain("at-1")
    expect(text).toContain("found with")
  })

  it("refuses a sign-in that came back from somewhere else, refused, or late", async () => {
    await saveGoogleSettings(ctx, settings(), { publicUrl: PUBLIC_URL })
    const start = async () =>
      new URL(
        (await startGoogleConnect(ctx, { publicUrl: PUBLIC_URL })).redirectTo,
      ).searchParams.get("state")!

    await expect(
      finishGoogleConnect(
        ctx,
        new URLSearchParams({
          code: "the-code",
          state: await start(),
          iss: "https://evil.example.com",
        }),
        { publicUrl: PUBLIC_URL },
      ),
    ).rejects.toThrow(/did not come from Google/)
    await expect(
      finishGoogleConnect(
        ctx,
        new URLSearchParams({
          error: "access_denied",
          state: await start(),
        }),
        { publicUrl: PUBLIC_URL },
      ),
    ).rejects.toThrow(/you did not allow it/)

    const late = await start()
    await db().oAuthAccountState.update({
      where: { id: late },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await expect(
      finishGoogleConnect(
        ctx,
        new URLSearchParams({ code: "the-code", state: late }),
        { publicUrl: PUBLIC_URL },
      ),
    ).rejects.toThrow(/took too long/)
    expect(google.requests.some((req) => req.url === "/token")).toBe(false)
    expect((await loadGoogleAccount(ctx))!.status).toBe("disconnected")
  })

  it("never puts the client secret in an error", async () => {
    await saveGoogleSettings(ctx, settings(), { publicUrl: PUBLIC_URL })
    const url = new URL(
      (await startGoogleConnect(ctx, { publicUrl: PUBLIC_URL })).redirectTo,
    )
    // The state is Google's to give back; the code is wrong.
    const failure = await finishGoogleConnect(
      ctx,
      new URLSearchParams({
        code: "wrong",
        state: url.searchParams.get("state")!,
      }),
      { publicUrl: PUBLIC_URL },
    ).catch((error: unknown) => error)

    expect(isPcpError(failure)).toBe(true)
    expect((failure as PcpError).message).toMatch(/Google refused/)
    expect(JSON.stringify(failure)).not.toContain(CLIENT_SECRET)
    expect((failure as PcpError).message).not.toContain(CLIENT_SECRET)
  })
})

describe("renewing the access", () => {
  it("renews an access that is about to run out, once for any number of calls", async () => {
    await connect()
    expire()
    tokenDelayMs = 60
    const account = (await loadGoogleAccount(ctx))!
    const before = google.requests.filter((req) => req.url === "/token").length

    const got = await Promise.all(
      Array.from({ length: 6 }, () => googleAccessToken(ctx, account.id)),
    )

    expect(new Set(got.map((token) => token.access))).toEqual(new Set(["at-2"]))
    expect(
      google.requests.filter((req) => req.url === "/token").length - before,
    ).toBe(1)
    const refresh = form(
      google.requests.filter((r) => r.url === "/token").at(-1)!.body,
    )
    expect(refresh).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt-1",
      client_secret: CLIENT_SECRET,
    })

    // The renewed access lasts: no more requests for the next calls.
    await googleAccessToken(ctx, account.id)
    expect(
      google.requests.filter((req) => req.url === "/token").length - before,
    ).toBe(1)
  })

  it("keeps a refresh token Google rotates", async () => {
    await connect()
    expire()
    const account = (await loadGoogleAccount(ctx))!
    rotateRefresh = "rt-2"
    await googleAccessToken(ctx, account.id)

    expect(
      JSON.parse(
        await revealSecret(ctx, (await loadGoogleAccount(ctx))!.tokensId!),
      ),
    ).toMatchObject({ access_token: "at-2", refresh_token: "rt-2" })
  })

  it("renews once and calls again when Google refuses the access it was sent", async () => {
    await connect()
    // Ten seconds on: the access is not new, Google has stopped taking it.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(Date.now() + 10_000)
    accepted = new Set()
    const gmail = (await servers()).find((s) => s.slug === "google-gmail")!
    const result = await callServerTool(
      ctx,
      await getServer(ctx, gmail.id),
      "gmail_find",
      {},
      { publicUrl: PUBLIC_URL },
    )

    expect(result.isError).not.toBe(true)
    const calls = google.requests
      .filter(
        (req) => req.url === "/mcp/gmail" && req.body.includes("tools/call"),
      )
      .map((req) => req.headers.authorization)

    expect(calls).toEqual(["Bearer at-1", "Bearer at-2"])
  })

  it("marks the account as needing the owner when Google refuses the refresh token", async () => {
    const { finished } = await connect()

    expire()
    refreshAnswer = [400, { error: "invalid_grant" }]
    const gmail = (await servers()).find((s) => s.slug === "google-gmail")!
    const error = await callServerTool(
      ctx,
      await getServer(ctx, gmail.id),
      "gmail_find",
      {},
      { publicUrl: PUBLIC_URL },
    ).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(PcpError)
    expect((error as PcpError).code).toBe("unauthorized")
    expect(await loadGoogleAccount(ctx)).toMatchObject({
      status: "needs_reconnect",
      tokensId: null,
    })
    // The refresh token and the tokens' secret are gone, and every server
    // reads as not connected.
    expect(
      await db().secret.count({ where: { id: finished.account.tokensId! } }),
    ).toBe(0)

    for (const server of await servers()) {
      expect(server.connected).toBe(false)
      expect(server.status).toBe("auth_required")
      expect(server.statusMessage).toMatch(/Google needs to be connected again/)
    }
  })

  it("answers an assistant with the Google page's link, not a token's story", async () => {
    await connect()
    expire()
    const { token } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })
    const tokenId = (await resolveApiToken(token))!.tokenId
    const gmail = await getServer(
      ctx,
      (await servers()).find((s) => s.slug === "google-gmail")!.id,
    )

    refreshAnswer = [400, { error: "invalid_grant" }]
    // The first call finds out; it already hands over the link.
    const first = await runCall(
      ctx,
      gmail,
      "gmail_find",
      {},
      {
        publicUrl: PUBLIC_URL,
        tokenId,
      },
    )

    expect(isConnectResult(first)).toBe(true)
    expect(first.structuredContent).toMatchObject({
      kind: "needs_owner",
      reason: "connect",
      url: `${PUBLIC_URL}/servers/google`,
      label: "Connect Google in PCP",
    })
    const said = (first.content[0] as { text: string }).text
    expect(said.split("\n").at(-1)).toBe(
      `[Connect Google in PCP](${PUBLIC_URL}/servers/google)`,
    )
    expect(said).toContain("check_server")
    expect(said).not.toMatch(/at-1|rt-1|invalid_grant/)

    // Now it is known: the next call does not even reach Google.
    const before = google.requests.length
    const again = await runCall(
      ctx,
      await getServer(ctx, gmail.id),
      "gmail_find",
      {},
      { publicUrl: PUBLIC_URL, tokenId },
    )

    expect(isConnectResult(again)).toBe(true)
    expect(google.requests.length).toBe(before)
  })

  it("lets the gate cool Google down when its token address says to slow down", async () => {
    await connect()
    expire()
    const account = (await loadGoogleAccount(ctx))!

    refreshAnswer = [429, { error: "rate_limit_exceeded" }]
    const error = await googleAccessToken(ctx, account.id).catch(
      (thrown: unknown) => thrown,
    )
    const { throttleOf } = await import("../throttle-signal")

    expect(throttleOf(error)).toMatchObject({
      reason: expect.stringContaining("HTTP 429"),
    })
    // A throttle is no refusal of the sign-in: the account stays connected.
    expect((await loadGoogleAccount(ctx))!.status).toBe("connected")
  })
})

describe("adding and taking away products", () => {
  it("asks only for what a new product lacks, and makes its server once granted", async () => {
    await connect(settings({ products: ["gmail"] }))
    expect((await servers()).map((s) => s.slug)).toEqual(["google-gmail"])

    const saved = await saveGoogleSettings(
      ctx,
      settings({ clientSecretValue: undefined, products: ["gmail", "drive"] }),
      { publicUrl: PUBLIC_URL },
    )

    // Not granted yet: no server, and the owner is sent to consent.
    expect(saved.needsConsent).toBe(true)
    expect((await servers()).map((s) => s.slug)).toEqual(["google-gmail"])

    const { redirectTo } = await startGoogleConnect(ctx, {
      publicUrl: PUBLIC_URL,
    })
    const url = new URL(redirectTo)
    const asked = url.searchParams.get("scope")!.split(" ")

    expect(asked).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ])
    expect(url.searchParams.get("include_granted_scopes")).toBe("true")

    // Google's token carries everything granted so far.
    challenge = url.searchParams.get("code_challenge")!
    grantedScope = scopesOf(["gmail", "drive"]).join(" ")
    accessTokens = ["at-9"]
    accepted.add("at-9")
    const { added } = await finishGoogleConnect(
      ctx,
      new URLSearchParams({
        code: "the-code",
        state: url.searchParams.get("state")!,
      }),
      { publicUrl: PUBLIC_URL },
    )

    expect(added).toEqual(["Google Drive"])
    expect((await servers()).map((s) => s.slug).sort()).toEqual([
      "google-drive",
      "google-gmail",
    ])
  })

  it("makes no server for a product Google did not grant", async () => {
    await saveGoogleSettings(ctx, settings({ products: ["gmail", "tasks"] }), {
      publicUrl: PUBLIC_URL,
    })
    const url = new URL(
      (await startGoogleConnect(ctx, { publicUrl: PUBLIC_URL })).redirectTo,
    )

    challenge = url.searchParams.get("code_challenge")!
    // The owner unticked Tasks on Google's own consent page.
    grantedScope = scopesOf(["gmail"]).join(" ")
    await finishGoogleConnect(
      ctx,
      new URLSearchParams({
        code: "the-code",
        state: url.searchParams.get("state")!,
      }),
      { publicUrl: PUBLIC_URL },
    )

    expect((await servers()).map((s) => s.slug)).toEqual(["google-gmail"])
    const view = await googleView(ctx, { publicUrl: PUBLIC_URL })

    expect(view.products.find((p) => p.id === "tasks")).toMatchObject({
      chosen: true,
      granted: false,
      server: null,
    })
  })

  it("disables the server of a product taken away, and enables it again", async () => {
    await connect(settings({ products: ["gmail", "tasks"] }))
    const without = { clientSecretValue: undefined }

    await saveGoogleSettings(
      ctx,
      settings({ ...without, products: ["gmail"] }),
      {
        publicUrl: PUBLIC_URL,
      },
    )
    expect((await servers()).map((s) => [s.slug, s.enabled]).sort()).toEqual([
      ["google-gmail", true],
      ["google-tasks", false],
    ])

    const again = await saveGoogleSettings(
      ctx,
      settings({ ...without, products: ["gmail", "tasks"] }),
      { publicUrl: PUBLIC_URL },
    )

    // Granted before: it needs no new consent, and its server is back.
    expect(again.needsConsent).toBe(false)
    expect((await servers()).every((s) => s.enabled)).toBe(true)
  })

  it("ends the sign-in when the owner changes the client", async () => {
    await connect(settings({ products: ["gmail"] }))
    const saved = await saveGoogleSettings(
      ctx,
      {
        clientId: "9999-zzz.apps.googleusercontent.com",
        clientSecretValue: "another-client-secret",
        products: ["gmail"],
      },
      { publicUrl: PUBLIC_URL },
    )

    expect(saved.signedOut).toBe(true)
    expect(saved.account).toMatchObject({
      status: "disconnected",
      tokensId: null,
    })
    expect((await servers())[0]).toMatchObject({ connected: false })
    expect(google.requests.some((req) => req.url === "/revoke")).toBe(true)
  })
})

describe("disconnecting and removing Google", () => {
  it("revokes at Google, deletes the tokens and leaves the servers signed out", async () => {
    const { finished } = await connect(settings({ products: ["gmail"] }))
    const { revoked } = await disconnectGoogle(ctx)

    expect(revoked).toBe(true)
    // The refresh token is what is revoked, which ends every access with it.
    expect(
      form(google.requests.find((req) => req.url === "/revoke")!.body),
    ).toEqual({ token: "rt-1" })
    expect(
      await db().secret.count({ where: { id: finished.account.tokensId! } }),
    ).toBe(0)
    expect(await loadGoogleAccount(ctx)).toMatchObject({
      status: "disconnected",
      tokensId: null,
      granted: [],
      email: null,
    })
    expect((await servers())[0]).toMatchObject({
      connected: false,
      enabled: true,
    })
    await expect(googleAccessToken(ctx, finished.account.id)).rejects.toThrow(
      /needs to be connected/,
    )
  })

  it("lets go of its tokens even when Google cannot be reached", async () => {
    const { finished } = await connect(settings({ products: ["gmail"] }))

    await google.close()
    google = await startTestApi()
    setGoogleEndpointsForTest({
      revoke: "http://127.0.0.1:1/revoke",
      privateAddresses: true,
    })
    const { revoked } = await disconnectGoogle(ctx)

    expect(revoked).toBe(false)
    expect(
      await db().secret.count({ where: { id: finished.account.tokensId! } }),
    ).toBe(0)
  })

  it("removes the account, its servers and its use of the secret", async () => {
    const { finished } = await connect(
      settings({ products: ["gmail", "docs"] }),
    )
    const secretId = finished.account.clientSecretId!

    await removeGoogle(ctx)

    expect(await loadGoogleAccount(ctx)).toBeNull()
    expect(await servers()).toEqual([])
    expect(await db().oAuthAccount.count()).toBe(0)
    // The owner's secret stays, and can now be deleted.
    expect((await secretUses(ctx, [secretId])).get(secretId)!.uses).toEqual([])
    await deleteSecret(ctx, secretId)
  })

  it("is a disconnect when the owner deletes the tokens' secret under Secrets", async () => {
    const { finished } = await connect(settings({ products: ["gmail"] }))

    await deleteSecret(ctx, finished.account.tokensId!)

    expect(await loadGoogleAccount(ctx)).toMatchObject({
      status: "disconnected",
    })
    expect((await servers())[0]).toMatchObject({ connected: false })
  })
})

describe("only the owner's page changes any of it", () => {
  it("keeps a Google server out of the ways to edit or connect an ordinary one", async () => {
    await connect(settings({ products: ["gmail"] }))
    const id = (await servers())[0]!.id

    await expect(
      updateServer(ctx, id, {
        name: "Mine",
        url: "https://evil.example.com/mcp",
        authType: "none",
      }),
    ).rejects.toThrow(/Google page/)
    await expect(disconnectOAuth(ctx, id)).rejects.toThrow(/disconnect Google/)
    await expect(
      startOAuth(ctx, id, { publicUrl: PUBLIC_URL }),
    ).rejects.toThrow(/does not use OAuth/)
    expect(await getServer(ctx, id)).toMatchObject({
      url: `${google.origin}/mcp/gmail`,
      authType: "google",
    })
  })

  it("is carried in an export and restored with its servers", async () => {
    const { finished } = await connect(
      settings({ products: ["gmail", "tasks"] }),
    )
    const file = await exportVault(ctx, "export password 1234 ok")
    const { payload } = await readExport(file, "export password 1234 ok")

    expect(payload.tables.oauthAccounts).toHaveLength(1)
    // The file holds the account's rows as they are: sealed, no secret.
    expect(file.toString("utf8")).not.toContain(CLIENT_SECRET)
    expect(JSON.stringify(payload.tables.oauthAccounts)).not.toContain(
      CLIENT_ID,
    )
    await restoreExport(
      payload,
      { into: "vault", ctx },
      { restoreHostSettings: false },
    )

    expect(await loadGoogleAccount(ctx)).toMatchObject({
      id: finished.account.id,
      clientId: CLIENT_ID,
      status: "connected",
      tokensId: finished.account.tokensId,
      clientSecretId: finished.account.clientSecretId,
      products: ["gmail", "tasks"],
    })
    const bound = await servers()

    expect(bound).toHaveLength(2)
    expect(
      (await db().mcpServer.findMany({ where: { authType: "google" } })).every(
        (row) => row.accountId === finished.account.id,
      ),
    ).toBe(true)
    // The sign-in still works after the restore.
    const gmail = bound.find((server) => server.slug === "google-gmail")!
    const result = await callServerTool(
      ctx,
      await getServer(ctx, gmail.id),
      "gmail_find",
      {},
      { publicUrl: PUBLIC_URL },
    )

    expect(result.isError).not.toBe(true)
  })
})
