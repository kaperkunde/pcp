import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { db } from "./db"
import { finishOAuth, reconcileIssuer, startOAuth } from "./oauth"
import { legacyRedirectUrl, oauthRedirectUrl } from "./oauth-client"
import { createMailAccount } from "./mail/accounts"
import { json, startTestApi, type TestApi } from "./openapi/test-api"
import {
  createServer,
  getServer,
  setOAuthClient,
  setOAuthSignInParams,
  updateServer,
} from "./servers"
import { scratchDatabase } from "./test-db"
import {
  describeOAuthConnection,
  PcpOAuthProvider,
  refusalReason,
  syncServerTools,
} from "./upstream"
import { setupVault } from "./vault"

// Regression: in the Docker image (bound to 0.0.0.0) Next.js rewrote the
// first loopback address in the callback URL — which was inside the encoded
// `iss` parameter — to "localhost", and the SDK's RFC 9207 check refused an
// issuer of 127.0.0.1 that came back as localhost.
describe("reconcileIssuer", () => {
  it("accepts another spelling of the same loopback issuer", () => {
    expect(
      reconcileIssuer("http://localhost:38665", "http://127.0.0.1:38665"),
    ).toBe("http://127.0.0.1:38665")
    expect(
      reconcileIssuer("http://localhost:8080/as", "http://[::1]:8080/as"),
    ).toBe("http://[::1]:8080/as")
  })

  it("passes everything else through untouched for the SDK to judge", () => {
    // Same issuer: nothing to reconcile.
    expect(
      reconcileIssuer("https://auth.example.com", "https://auth.example.com"),
    ).toBe("https://auth.example.com")
    // A different host is a mix-up, not a spelling: the SDK must refuse it.
    expect(
      reconcileIssuer("https://evil.example.com", "https://auth.example.com"),
    ).toBe("https://evil.example.com")
    // Loopback but another port or path is another server.
    expect(
      reconcileIssuer("http://localhost:9999", "http://127.0.0.1:38665"),
    ).toBe("http://localhost:9999")
    expect(
      reconcileIssuer("http://localhost:38665/x", "http://127.0.0.1:38665"),
    ).toBe("http://localhost:38665/x")
    // Nothing recorded, nothing received, or garbage: unchanged.
    expect(reconcileIssuer("http://localhost:1", undefined)).toBe(
      "http://localhost:1",
    )
    expect(reconcileIssuer(undefined, "http://127.0.0.1:1")).toBeUndefined()
    expect(reconcileIssuer("not a url", "http://127.0.0.1:1")).toBe("not a url")
  })
})

describe("refusalReason", () => {
  it("quotes the challenge, then an error object, never an answer", () => {
    expect(
      refusalReason(
        'Bearer realm="x", error="invalid_token", error_description="Token expired"',
        null,
      ),
    ).toBe("Token expired")
    expect(refusalReason('Bearer error="invalid_token"', null)).toBe(
      "invalid_token",
    )
    expect(
      refusalReason(
        null,
        '{"error":{"code":403,"message":"API disabled","status":"PERMISSION_DENIED"}}',
      ),
    ).toBe("API disabled")
    expect(
      refusalReason(null, '{"error":"access_denied","error_description":"No"}'),
    ).toBe("No")
    expect(
      refusalReason(null, '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'),
    ).toBeNull()
    expect(refusalReason(null, "<html>Forbidden</html>")).toBeNull()
    expect(refusalReason('Bearer error="a\nb"', null)).toBe("a b")
  })
})

/**
 * How PCP gets a client ID from servers that do and do not let it register
 * itself, against a small authorization server in the test process.
 */
describe("connecting an OAuth server", () => {
  let cleanup: () => Promise<void>
  let ctx: Awaited<ReturnType<typeof setupVault>>
  let as: TestApi
  /** Added to (or, as undefined, removed from) the server's metadata. */
  let metadata: Record<string, unknown>
  let register: (res: Parameters<typeof json>[0], body: string) => void
  let tokenAnswer: Record<string, unknown>
  /** How /mcp answers a request with a token; without, it asks for one. */
  let signedIn: ((body: string, res: Parameters<typeof json>[0]) => void) | null

  const HTTP = { publicUrl: "http://pcp.lan:3000" }
  const HTTPS = { publicUrl: "https://pcp.example.com" }

  beforeEach(async () => {
    ;({ cleanup } = await scratchDatabase())
    ctx = await setupVault({ name: "Ada", password: "correct horse battery" })
    metadata = {}
    register = (res, body) =>
      json(res, 201, {
        client_id: "dynamic-client",
        ...JSON.parse(body),
      })
    tokenAnswer = { access_token: "at", token_type: "Bearer", expires_in: 60 }
    signedIn = null
    as = await startTestApi((req, res) => {
      const path = req.url.split("?")[0]

      if (path.startsWith("/.well-known/oauth-protected-resource")) {
        return json(res, 200, {
          resource: `${as.origin}/mcp`,
          authorization_servers: [as.origin],
        })
      }

      if (path === "/.well-known/oauth-authorization-server") {
        return json(
          res,
          200,
          JSON.parse(
            JSON.stringify({
              issuer: as.origin,
              authorization_endpoint: `${as.origin}/authorize`,
              token_endpoint: `${as.origin}/token`,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: [
                "client_secret_basic",
                "none",
              ],
              ...metadata,
            }),
          ),
        )
      }

      if (path === "/mcp" && signedIn && req.headers.authorization) {
        // No event stream: a stateless server, like Gmail's.
        if (req.method !== "POST") {
          res.statusCode = 405
          return res.end()
        }

        return signedIn(req.body, res)
      }

      if (path === "/mcp") {
        res.setHeader(
          "www-authenticate",
          `Bearer resource_metadata="${as.origin}/.well-known/oauth-protected-resource/mcp"`,
        )
        return json(res, 401, { error: "unauthorized" })
      }

      if (path === "/register") {
        return register(res, req.body)
      }

      if (path === "/token") {
        return json(res, 200, tokenAnswer)
      }

      json(res, 404, { error: "not_found" })
    })
  })

  afterEach(async () => {
    await as.close()
    await cleanup()
  })

  async function oauthServer(extra: Record<string, string> = {}) {
    const { id } = await createServer(ctx, {
      name: "Mail",
      url: `${as.origin}/mcp`,
      authType: "oauth",
      ...extra,
    })
    return id
  }

  function signInAddress(result: Awaited<ReturnType<typeof startOAuth>>) {
    expect(result).toHaveProperty("redirectTo")
    return new URL((result as { redirectTo: string }).redirectTo)
  }

  it("asks the owner for a client when the server lets no app register", async () => {
    const id = await oauthServer()

    await expect(startOAuth(ctx, id, HTTP)).rejects.toThrow(
      /Mail needs an OAuth client from you: it does not let apps register themselves\. .*http:\/\/pcp\.lan:3000\/api\/oauth\/callback/,
    )
    expect(await getServer(ctx, id)).toMatchObject({
      status: "client_required",
    })
    // Nothing tried to register, and a later read keeps saying why.
    expect(as.requests.some((req) => req.url === "/register")).toBe(false)
    await syncServerTools(ctx, await getServer(ctx, id), HTTP)
    expect((await getServer(ctx, id)).status).toBe("client_required")
  })

  it("takes the client from the status card and keeps the other settings", async () => {
    const id = await oauthServer({
      oauthScope: "mail.read",
      oauthAuthorizeParams: "access_type=offline",
    })
    await expect(startOAuth(ctx, id, HTTP)).rejects.toThrow()

    await expect(setOAuthClient(ctx, id, { clientId: "  " })).rejects.toThrow(
      /Enter the client ID/,
    )

    await setOAuthClient(ctx, id, {
      clientId: "owner-client",
      clientSecretValue: "owner-client-secret",
    })
    const server = await getServer(ctx, id)
    expect(server).toMatchObject({
      name: "Mail",
      url: `${as.origin}/mcp`,
      authType: "oauth",
      oauthClientId: "owner-client",
      oauthScope: "mail.read",
      oauthAuthorizeParams: "access_type=offline",
    })
    expect(server.oauthClientSecretId).not.toBeNull()

    // Saving the ID again without a secret keeps the one it has.
    await setOAuthClient(ctx, id, { clientId: "owner-client" })
    expect((await getServer(ctx, id)).oauthClientSecretId).toBe(
      server.oauthClientSecretId,
    )

    // Out of "needs a client": the next read asks for a sign-in instead.
    await syncServerTools(ctx, await getServer(ctx, id), HTTP)
    expect((await getServer(ctx, id)).status).toBe("auth_required")
    const url = signInAddress(await startOAuth(ctx, id, HTTP))
    expect(url.searchParams.get("client_id")).toBe("owner-client")
  })

  it("sets the sign-in parameters and keeps the connection", async () => {
    const id = await oauthServer({
      oauthClientId: "owner-client",
      oauthScope: "mail.read",
    })

    await setOAuthSignInParams(ctx, id, "access_type=offline")
    expect(await getServer(ctx, id)).toMatchObject({
      oauthClientId: "owner-client",
      oauthScope: "mail.read",
      oauthAuthorizeParams: "access_type=offline",
    })
    await expect(setOAuthSignInParams(ctx, id, "state=x")).rejects.toThrow(
      /PCP sets state itself/,
    )

    const url = signInAddress(await startOAuth(ctx, id, HTTP))
    expect(url.searchParams.get("access_type")).toBe("offline")
  })

  it("takes a client only for an OAuth server", async () => {
    const { id } = await createServer(ctx, {
      name: "Open",
      url: `${as.origin}/mcp`,
      authType: "none",
    })

    await expect(
      setOAuthClient(ctx, id, { clientId: "owner-client" }),
    ).rejects.toThrow(/does not use OAuth/)
  })

  it("signs in with the owner's client, secret and sign-in parameters", async () => {
    const id = await oauthServer()
    await expect(startOAuth(ctx, id, HTTP)).rejects.toThrow()

    await updateServer(ctx, id, {
      name: "Mail",
      url: `${as.origin}/mcp`,
      authType: "oauth",
      oauthClientId: "owner-client",
      oauthClientSecretValue: "owner-client-secret",
      oauthAuthorizeParams: "access_type=offline&prompt=consent",
    })

    const server = await getServer(ctx, id)
    const secret = await db().secret.findUniqueOrThrow({
      where: { id: server.oauthClientSecretId! },
    })
    expect(secret).toMatchObject({
      name: "Mail OAuth client secret",
      kind: "text",
    })

    const url = signInAddress(await startOAuth(ctx, id, HTTP))
    expect(url.origin + url.pathname).toBe(`${as.origin}/authorize`)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "owner-client",
      redirect_uri: oauthRedirectUrl(HTTP.publicUrl),
      access_type: "offline",
      prompt: "consent",
      response_type: "code",
    })

    // The owner's client is bound to the authorization server it was first
    // used with, so the SDK never sends its secret to another.
    const bound = await new PcpOAuthProvider(ctx, await getServer(ctx, id), {
      redirectUrl: oauthRedirectUrl(HTTP.publicUrl),
      publicUrl: HTTP.publicUrl,
    }).clientInformation()
    expect(bound).toMatchObject({
      client_id: "owner-client",
      client_secret: "owner-client-secret",
      issuer: as.origin,
    })

    // The callback: the state names the server, the secret goes to the
    // token endpoint, and a token set without a refresh token is reported.
    const { serverId } = await finishOAuth(
      ctx,
      new URLSearchParams({
        code: "the-code",
        state: url.searchParams.get("state")!,
      }),
      HTTP,
    )
    expect(serverId).toBe(id)
    const token = as.requests.find((req) => req.url === "/token")!
    expect(token.headers.authorization).toBe(
      `Basic ${Buffer.from("owner-client:owner-client-secret").toString("base64")}`,
    )
    expect(
      await describeOAuthConnection(ctx, await getServer(ctx, id)),
    ).toMatchObject({ renewable: false, reconnectRenews: false })
  })

  // Regression: Gmail turned PCP's token down with a 403 whose body was the
  // whole tool list, and the server page showed that body as "could not be
  // reached".
  it("says a signed-in request was refused, and why, not what the body was", async () => {
    const id = await oauthServer({ oauthClientId: "owner-client" })
    const url = signInAddress(await startOAuth(ctx, id, HTTP))
    signedIn = (body, res) => {
      const { id: rpcId, method } = JSON.parse(body) as {
        id?: number
        method: string
      }

      if (method === "initialize") {
        return json(res, 200, {
          jsonrpc: "2.0",
          id: rpcId,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "mail", version: "1" },
          },
        })
      }

      if (rpcId === undefined) {
        res.statusCode = 202
        return res.end()
      }

      res.setHeader(
        "www-authenticate",
        'Bearer error="access_denied", error_description="Mail API is not enabled for this project"',
      )
      json(res, 403, {
        jsonrpc: "2.0",
        id: rpcId,
        result: { tools: [{ name: "send", description: "Sends a mail" }] },
      })
    }

    await finishOAuth(
      ctx,
      new URLSearchParams({
        code: "the-code",
        state: url.searchParams.get("state")!,
      }),
      HTTP,
    )

    const server = await getServer(ctx, id)
    expect(server.status).toBe("refused")
    expect(server.statusMessage).toMatch(
      /^Mail refused PCP's request although PCP is signed in \(HTTP 403: Mail API is not enabled for this project\)\./,
    )
    expect(server.statusMessage).not.toMatch(/Sends a mail|jsonrpc/)
  })

  it("refuses a callback for another server at its old address", async () => {
    const id = await oauthServer({ oauthClientId: "owner-client" })
    const other = await oauthServer({ oauthClientId: "owner-client" })
    const url = signInAddress(await startOAuth(ctx, id, HTTP))

    await expect(
      finishOAuth(
        ctx,
        new URLSearchParams({
          code: "c",
          state: url.searchParams.get("state")!,
        }),
        { ...HTTP, serverId: other },
      ),
    ).rejects.toThrow(/not one PCP started/)
  })

  it("asks the owner for a client when the server refuses PCP's registration", async () => {
    metadata = { registration_endpoint: `${as.origin}/register` }
    register = (res) =>
      json(res, 403, {
        error: "unapproved_software_statement",
        error_description: "Only approved clients may register.",
      })
    const id = await oauthServer()

    await expect(startOAuth(ctx, id, HTTP)).rejects.toThrow(
      /it refused PCP's registration \(unapproved_software_statement: Only approved clients may register\.\)/,
    )
    expect((await getServer(ctx, id)).status).toBe("client_required")
  })

  it("registers dynamically with the one redirect address", async () => {
    metadata = {
      registration_endpoint: `${as.origin}/register`,
      // Both offered: PCP keeps to registration, which needs nothing public.
      client_id_metadata_document_supported: true,
    }
    const id = await oauthServer()

    // Reading the tools before anyone signed in registers nothing: only the
    // owner's Connect does.
    await syncServerTools(ctx, await getServer(ctx, id), HTTPS)
    expect((await getServer(ctx, id)).status).toBe("auth_required")
    expect(as.requests.some((req) => req.url === "/register")).toBe(false)

    const url = signInAddress(await startOAuth(ctx, id, HTTPS))
    expect(url.searchParams.get("client_id")).toBe("dynamic-client")
    expect(url.searchParams.get("redirect_uri")).toBe(
      oauthRedirectUrl(HTTPS.publicUrl),
    )
    const registration = as.requests.find((req) => req.url === "/register")!
    expect(JSON.parse(registration.body).redirect_uris).toEqual([
      oauthRedirectUrl(HTTPS.publicUrl),
    ])
  })

  // The SDK adds offline_access to a scope when the server lists it; a mail
  // account's refresh token, and so staying signed in, depends on that.
  describe("the scope of a mail account", () => {
    const MAIL = "urn:ietf:params:oauth:scope:mail"

    async function jmapAccount(oauthScope: string | null) {
      const { id } = await createMailAccount(ctx, {
        protocol: "jmap",
        name: "Mail",
        url: `${as.origin}/mcp`,
        readOnly: false,
        authType: "oauth",
        oauthScope,
      })
      return id
    }

    const scopeOf = (result: Awaited<ReturnType<typeof startOAuth>>) =>
      signInAddress(result).searchParams.get("scope")

    it("asks for offline_access when the server offers it, so PCP stays signed in", async () => {
      metadata = {
        registration_endpoint: `${as.origin}/register`,
        scopes_supported: ["openid", "offline_access", MAIL],
      }

      expect(
        scopeOf(await startOAuth(ctx, await jmapAccount(MAIL), HTTP)),
      ).toBe(`${MAIL} offline_access`)
      // Already there: not twice.
      expect(
        scopeOf(
          await startOAuth(
            ctx,
            await jmapAccount(`offline_access ${MAIL}`),
            HTTP,
          ),
        ),
      ).toBe(`offline_access ${MAIL}`)
    })

    it("leaves the scope alone when the server does not list offline_access, or none was given", async () => {
      metadata = {
        registration_endpoint: `${as.origin}/register`,
        scopes_supported: ["openid", MAIL],
      }
      expect(
        scopeOf(await startOAuth(ctx, await jmapAccount(MAIL), HTTP)),
      ).toBe(MAIL)

      // One scope alone would replace the server's default: not added.
      metadata = {
        registration_endpoint: `${as.origin}/register`,
        scopes_supported: ["openid", "offline_access", MAIL],
      }
      expect(
        scopeOf(await startOAuth(ctx, await jmapAccount(null), HTTP)),
      ).not.toBe("offline_access")
    })
  })

  it("offers its client metadata document when that is the only way", async () => {
    metadata = { client_id_metadata_document_supported: true }
    const id = await oauthServer()

    const url = signInAddress(await startOAuth(ctx, id, HTTPS))
    expect(url.searchParams.get("client_id")).toBe(
      "https://pcp.example.com/api/oauth/client-metadata",
    )
    expect(as.requests.some((req) => req.url === "/register")).toBe(false)

    // Off https the document cannot be fetched: the owner is asked instead.
    const lan = await oauthServer()
    await expect(startOAuth(ctx, lan, HTTP)).rejects.toThrow(
      /needs an OAuth client/,
    )
  })

  it("keeps the per-server address for a client registered with it", async () => {
    const id = await oauthServer()
    const server = await getServer(ctx, id)
    const legacy = legacyRedirectUrl(HTTP.publicUrl, id)
    await new PcpOAuthProvider(ctx, server, {
      redirectUrl: legacy,
      publicUrl: HTTP.publicUrl,
    }).saveClientInformation({
      client_id: "old-client",
      redirect_uris: [legacy],
    } as never)

    const url = signInAddress(await startOAuth(ctx, id, HTTP))
    expect(url.searchParams.get("client_id")).toBe("old-client")
    expect(url.searchParams.get("redirect_uri")).toBe(legacy)
  })
})
