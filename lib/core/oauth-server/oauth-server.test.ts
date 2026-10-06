import { createHash } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createApiToken,
  deleteApiToken,
  getApiToken,
  resolveApiToken,
  revokeApiToken,
} from "../api-tokens"
import type { VaultContext } from "../context"
import { randomSecret } from "../crypto"
import { db } from "../db"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import {
  approveAuthorization,
  checkAuthorizationRequest,
  denyAuthorization,
  tokensForClient,
  type AuthorizationParams,
  type AuthorizationRequest,
} from "./authorize"
import {
  checkClientMetadata,
  fetchClientMetadata,
  registerClient,
  type DocumentFetcher,
} from "./clients"
import { OAuthError } from "./errors"
import {
  authorizationServerMetadata,
  bearerChallenge,
  protectedResourceMetadata,
} from "./metadata"
import {
  resolveAccessToken,
  revokeRequest,
  tokenRequest,
  type TokenResponse,
} from "./tokens"

// PCP's authorization server against a scratch database: an assistant
// registers, the owner approves, the code becomes tokens that open the
// vault at the token's own levels, and every way a sign-in can be wrong,
// stale, replayed or revoked ends without a key.

const PUBLIC_URL = "https://alice.pcp.gg"
const RESOURCE = `${PUBLIC_URL}/mcp`
const REDIRECT = "https://assistant.example/callback"

let cleanup: () => Promise<void>
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({ name: "Ada", password: "correct horse battery" })
})

afterEach(async () => {
  vi.useRealTimers()
  await cleanup()
})

function pkce() {
  const verifier = randomSecret(32)
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

async function publicClient(name = "Test assistant") {
  const registered = await registerClient({
    client_name: name,
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
  })
  return registered.client_id
}

function params(
  clientId: string,
  challenge: string,
  extra: AuthorizationParams = {},
): AuthorizationParams {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: RESOURCE,
    ...extra,
  }
}

async function checked(query: AuthorizationParams) {
  const check = await checkAuthorizationRequest(query, PUBLIC_URL)
  if (check.kind !== "ok") {
    throw new Error(`expected ok, got ${JSON.stringify(check)}`)
  }
  return check.request
}

/** A sign-in the owner approved with a new token; returns the code. */
async function approve(
  clientId: string,
  challenge: string,
  choice: Parameters<typeof approveAuthorization>[2] = {
    token: { name: "Claude", allowAllServers: true, keepMemories: true },
  },
) {
  const request = await checked(params(clientId, challenge))
  const { tokenId, redirect } = await approveAuthorization(
    ctx,
    request,
    choice,
    PUBLIC_URL,
  )
  const url = new URL(redirect)
  expect(`${url.origin}${url.pathname}`).toBe(REDIRECT)
  expect(url.searchParams.get("state")).toBe("xyz")
  expect(url.searchParams.get("iss")).toBe(PUBLIC_URL)
  return { tokenId, code: url.searchParams.get("code")! }
}

function exchange(
  clientId: string,
  code: string,
  verifier: string,
  extra: Record<string, string> = {},
) {
  return tokenRequest(
    {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      resource: RESOURCE,
      ...extra,
    },
    null,
    PUBLIC_URL,
  )
}

function refresh(clientId: string, refreshToken: string) {
  return tokenRequest(
    {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    },
    null,
    PUBLIC_URL,
  )
}

/** A whole sign-in: register, approve, exchange. */
async function signIn() {
  const clientId = await publicClient()
  const { verifier, challenge } = pkce()
  const { tokenId, code } = await approve(clientId, challenge)
  const tokens = await exchange(clientId, code, verifier)
  return { clientId, tokenId, tokens }
}

async function oauthGrantCount() {
  return db().keyGrant.count({
    where: { kind: { in: ["oauth_code", "oauth_access", "oauth_refresh"] } },
  })
}

async function oauthError(promise: Promise<unknown>): Promise<OAuthError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(OAuthError)
  return error as OAuthError
}

describe("discovery", () => {
  it("names PCP's public URL as the issuer and /mcp as the resource", () => {
    expect(protectedResourceMetadata(PUBLIC_URL)).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [PUBLIC_URL],
    })
    expect(authorizationServerMetadata(PUBLIC_URL)).toMatchObject({
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
      token_endpoint: `${PUBLIC_URL}/oauth/token`,
      registration_endpoint: `${PUBLIC_URL}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    })
    expect(bearerChallenge(PUBLIC_URL, false)).toBe(
      `Bearer realm="pcp", resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
    )
    expect(bearerChallenge(PUBLIC_URL, true)).toContain('error="invalid_token"')
  })
})

describe("signing an assistant in", () => {
  it("turns an approved code into tokens that open the vault at the token's levels", async () => {
    const { clientId, tokenId, tokens } = await signIn()

    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600 })
    expect(tokens.access_token).toMatch(/^pcp_at_/)
    expect(tokens.refresh_token).toMatch(/^pcp_rt_/)

    const resolved = await resolveAccessToken(tokens.access_token)
    expect(resolved).toMatchObject({
      tokenId,
      tokenName: "Claude",
      serverIds: null,
      keepMemories: true,
      manageEndpoints: false,
    })
    expect(resolved?.ctx.vaultId).toBe(ctx.vaultId)
    expect(resolved?.ctx.dek.equals(ctx.dek)).toBe(true)

    // It is an API token like any other, marked with the assistant.
    const summary = await getApiToken(ctx, tokenId)
    expect(summary.oauthClient).toEqual({
      id: clientId,
      name: "Test assistant",
    })

    // A bearer API token is not an access token, nor the other way round.
    expect(await resolveApiToken(tokens.access_token)).toBeNull()
    expect(await resolveAccessToken(tokens.refresh_token)).toBeNull()
  })

  it("keeps only hashes: nothing in the database is a credential", async () => {
    const { tokens } = await signIn()
    const rows = JSON.stringify([
      await db().oAuthCredential.findMany(),
      await db().keyGrant.findMany(),
      await db().apiToken.findMany(),
    ])

    expect(rows).not.toContain(tokens.access_token)
    expect(rows).not.toContain(tokens.refresh_token)
    expect(rows).not.toContain(tokens.access_token.slice(7))
  })

  it("leaves bearer API tokens working", async () => {
    const { token } = await createApiToken(ctx, {
      name: "Laptop",
      allowAllServers: true,
    })
    await signIn()

    expect((await resolveApiToken(token))?.tokenName).toBe("Laptop")
    expect(await resolveAccessToken(token)).toBeNull()
  })

  it("sends a refusal back as access_denied", async () => {
    const clientId = await publicClient()
    const request = await checked(params(clientId, pkce().challenge))
    const url = new URL(denyAuthorization(request, PUBLIC_URL))

    expect(url.searchParams.get("error")).toBe("access_denied")
    expect(url.searchParams.get("state")).toBe("xyz")
    expect(await db().apiToken.count()).toBe(0)
  })
})

describe("the authorization request", () => {
  it("shows the owner, and sends nothing to, a redirect URI the client did not register", async () => {
    const clientId = await publicClient()
    const check = await checkAuthorizationRequest(
      params(clientId, pkce().challenge, {
        redirect_uri: "https://evil.example/callback",
      }),
      PUBLIC_URL,
    )

    expect(check.kind).toBe("show")
    expect(check.kind === "show" && check.message).toContain(
      "not an address it registered",
    )
  })

  it("shows the owner an unknown client", async () => {
    const check = await checkAuthorizationRequest(
      params("pcp_client_nobody", pkce().challenge),
      PUBLIC_URL,
    )

    expect(check).toEqual({
      kind: "show",
      message: "PCP does not know this client.",
    })
  })

  it("requires PKCE with S256", async () => {
    const clientId = await publicClient()

    for (const extra of [
      { code_challenge: undefined },
      { code_challenge_method: "plain" },
      { code_challenge_method: undefined },
      { code_challenge: "too-short" },
    ]) {
      const check = await checkAuthorizationRequest(
        params(clientId, pkce().challenge, extra),
        PUBLIC_URL,
      )
      expect(check.kind).toBe("redirect")
      const url = new URL(check.kind === "redirect" ? check.url : "")
      expect(url.searchParams.get("error")).toBe("invalid_request")
      expect(url.searchParams.get("state")).toBe("xyz")
    }
  })

  it("issues tokens for this PCP's /mcp only", async () => {
    const clientId = await publicClient()
    const check = await checkAuthorizationRequest(
      params(clientId, pkce().challenge, {
        resource: "https://other.example/mcp",
      }),
      PUBLIC_URL,
    )

    expect(check.kind).toBe("redirect")
    expect(
      new URL(check.kind === "redirect" ? check.url : "").searchParams.get(
        "error",
      ),
    ).toBe("invalid_target")

    // A trailing slash is the same resource; none at all means /mcp.
    await checked(
      params(clientId, pkce().challenge, { resource: `${RESOURCE}/` }),
    )
    await checked(params(clientId, pkce().challenge, { resource: undefined }))
  })

  it("refuses response types other than code", async () => {
    const clientId = await publicClient()
    const check = await checkAuthorizationRequest(
      params(clientId, pkce().challenge, { response_type: "token" }),
      PUBLIC_URL,
    )

    expect(check.kind === "redirect" && check.url).toContain(
      "error=unsupported_response_type",
    )
  })
})

describe("the code exchange", () => {
  it("refuses a code_verifier that does not match, and spends the code", async () => {
    const clientId = await publicClient()
    const { verifier, challenge } = pkce()
    const { code } = await approve(clientId, challenge)

    const wrong = await oauthError(exchange(clientId, code, pkce().verifier))
    expect(wrong.error).toBe("invalid_grant")
    expect(wrong.message).toContain("code_verifier")

    // One try: the right verifier is too late now.
    expect((await oauthError(exchange(clientId, code, verifier))).error).toBe(
      "invalid_grant",
    )
    expect(await oauthGrantCount()).toBe(0)
  })

  it("refuses a redirect_uri other than the code's", async () => {
    const clientId = await publicClient()
    const { verifier, challenge } = pkce()
    const { code } = await approve(clientId, challenge)

    const error = await oauthError(
      exchange(clientId, code, verifier, {
        redirect_uri: "https://assistant.example/other",
      }),
    )
    expect(error.error).toBe("invalid_grant")
    expect(error.message).toContain("redirect_uri")
  })

  it("refuses an expired code", async () => {
    const clientId = await publicClient()
    const { verifier, challenge } = pkce()
    const { code } = await approve(clientId, challenge)

    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(Date.now() + 3 * 60 * 1000)

    const error = await oauthError(exchange(clientId, code, verifier))
    expect(error.error).toBe("invalid_grant")
    expect(error.message).toContain("expired")
  })

  it("refuses a code issued to another client", async () => {
    const clientId = await publicClient()
    const other = await publicClient("Other")
    const { verifier, challenge } = pkce()
    const { code } = await approve(clientId, challenge)

    expect((await oauthError(exchange(other, code, verifier))).error).toBe(
      "invalid_grant",
    )
  })

  it("takes an empty client_secret from a public client as none", async () => {
    const clientId = await publicClient()
    const { verifier, challenge } = pkce()
    const { code } = await approve(clientId, challenge)

    const tokens = await exchange(clientId, code, verifier, {
      client_secret: "",
    })
    expect(tokens.access_token).toMatch(/^pcp_at_/)
  })

  it("ends the sign-in when a code is used twice", async () => {
    const clientId = await publicClient()
    const { verifier, challenge } = pkce()
    const { code } = await approve(clientId, challenge)
    const tokens = await exchange(clientId, code, verifier)

    expect((await oauthError(exchange(clientId, code, verifier))).error).toBe(
      "invalid_grant",
    )
    expect(await resolveAccessToken(tokens.access_token)).toBeNull()
  })
})

describe("refresh tokens", () => {
  it("rotate: each use gives a new pair and spends the old refresh token", async () => {
    const { clientId, tokenId, tokens } = await signIn()
    const next = await refresh(clientId, tokens.refresh_token)

    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    expect((await resolveAccessToken(next.access_token))?.tokenId).toBe(tokenId)

    const after = await refresh(clientId, next.refresh_token)
    expect((await resolveAccessToken(after.access_token))?.tokenId).toBe(
      tokenId,
    )
  })

  it("end the sign-in when a spent one comes back", async () => {
    const { clientId, tokens } = await signIn()
    const next = await refresh(clientId, tokens.refresh_token)

    const replay = await oauthError(refresh(clientId, tokens.refresh_token))
    expect(replay.error).toBe("invalid_grant")
    expect(replay.message).toContain("used before")

    // Whoever held the newer pair is signed out too.
    expect(await resolveAccessToken(next.access_token)).toBeNull()
    expect(
      (await oauthError(refresh(clientId, next.refresh_token))).error,
    ).toBe("invalid_grant")
    expect(await oauthGrantCount()).toBe(0)
  })

  it("belong to the client they were issued to", async () => {
    const { tokens } = await signIn()
    const other = await publicClient("Other")

    expect((await oauthError(refresh(other, tokens.refresh_token))).error).toBe(
      "invalid_grant",
    )
  })

  it("expire, and so do access tokens", async () => {
    const { clientId, tokens } = await signIn()
    vi.useFakeTimers({ toFake: ["Date"] })

    vi.setSystemTime(Date.now() + 61 * 60 * 1000)
    expect(await resolveAccessToken(tokens.access_token)).toBeNull()

    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000)
    const error = await oauthError(refresh(clientId, tokens.refresh_token))
    expect(error.message).toContain("expired")
  })
})

describe("revocation", () => {
  it("by the owner under API tokens signs the assistant out", async () => {
    const { clientId, tokenId, tokens } = await signIn()

    await revokeApiToken(ctx, tokenId)

    expect(await resolveAccessToken(tokens.access_token)).toBeNull()
    expect(
      (await oauthError(refresh(clientId, tokens.refresh_token))).error,
    ).toBe("invalid_grant")
    expect(await oauthGrantCount()).toBe(0)
  })

  it("by deleting the token leaves no copy of the key behind", async () => {
    const { tokenId } = await signIn()
    expect(await oauthGrantCount()).toBe(2)

    await deleteApiToken(ctx, tokenId)

    expect(await oauthGrantCount()).toBe(0)
    expect(await db().oAuthCredential.count()).toBe(0)
  })

  it("by the client: a refresh token revokes its token, an access token only itself", async () => {
    const { clientId, tokenId, tokens } = await signIn()
    const next = await refresh(clientId, tokens.refresh_token)

    await revokeRequest({ token: next.access_token, client_id: clientId }, null)
    expect(await resolveAccessToken(next.access_token)).toBeNull()
    expect((await getApiToken(ctx, tokenId)).revokedAt).toBeNull()

    await revokeRequest(
      { token: next.refresh_token, client_id: clientId },
      null,
    )
    expect((await getApiToken(ctx, tokenId)).revokedAt).not.toBeNull()
    expect(await oauthGrantCount()).toBe(0)
  })

  it("by another client changes nothing", async () => {
    const { tokenId, tokens } = await signIn()
    const other = await publicClient("Other")

    await revokeRequest({ token: tokens.refresh_token, client_id: other }, null)
    expect((await getApiToken(ctx, tokenId)).revokedAt).toBeNull()
  })
})

describe("signing in again", () => {
  it("can reuse the token this client had, keeping it and ending its earlier sign-ins", async () => {
    const { clientId, tokenId, tokens } = await signIn()
    expect(await tokensForClient(ctx, clientId)).toEqual([
      expect.objectContaining({ id: tokenId, name: "Claude" }),
    ])

    const { verifier, challenge } = pkce()
    const again = await approve(clientId, challenge, { tokenId })
    expect(again.tokenId).toBe(tokenId)
    const fresh = await exchange(clientId, again.code, verifier)

    expect(await resolveAccessToken(tokens.access_token)).toBeNull()
    expect((await resolveAccessToken(fresh.access_token))?.tokenId).toBe(
      tokenId,
    )
    expect(await db().apiToken.count()).toBe(1)
  })

  it("never onto a token made for another client", async () => {
    const { tokenId } = await signIn()
    const other = await publicClient("Other")
    const request = await checked(params(other, pkce().challenge))

    await expect(
      approveAuthorization(ctx, request, { tokenId }, PUBLIC_URL),
    ).rejects.toThrow("another app")
  })
})

describe("client registration", () => {
  it("gives a client that does not say otherwise a secret, which it must present", async () => {
    const registered = await registerClient({
      client_name: "Confidential",
      redirect_uris: [REDIRECT],
    })
    expect(registered.token_endpoint_auth_method).toBe("client_secret_basic")
    expect(registered.client_secret).toMatch(/^pcp_cs_/)
    expect(JSON.stringify(await db().oAuthClient.findMany())).not.toContain(
      registered.client_secret,
    )

    const { verifier, challenge } = pkce()
    const { code } = await approve(registered.client_id, challenge)
    const basic = (secret: string) =>
      `Basic ${Buffer.from(`${registered.client_id}:${secret}`).toString("base64")}`
    const body = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    }

    const missing = await oauthError(
      tokenRequest(
        { ...body, client_id: registered.client_id },
        null,
        PUBLIC_URL,
      ),
    )
    expect(missing.error).toBe("invalid_client")
    expect(missing.status).toBe(401)
    expect(
      (await oauthError(tokenRequest(body, basic("wrong"), PUBLIC_URL))).error,
    ).toBe("invalid_client")

    const tokens: TokenResponse = await tokenRequest(
      body,
      basic(registered.client_secret!),
      PUBLIC_URL,
    )
    expect(tokens.access_token).toMatch(/^pcp_at_/)
  })

  it("takes redirect URIs that are https, this computer, or an app's own scheme", async () => {
    for (const uri of [
      "https://claude.ai/api/mcp/auth_callback",
      "http://localhost:6274/oauth/callback",
      "http://127.0.0.1:33418/callback",
      "com.example.app:/oauth",
    ]) {
      await expect(
        registerClient({
          redirect_uris: [uri],
          token_endpoint_auth_method: "none",
        }),
      ).resolves.toMatchObject({ redirect_uris: [uri] })
    }

    for (const uri of [
      "http://assistant.example/callback",
      "javascript:alert(1)",
      "https://assistant.example/callback#fragment",
      "https://user:pass@assistant.example/callback",
      "/relative",
    ]) {
      const error = await oauthError(registerClient({ redirect_uris: [uri] }))
      expect(error.error).toBe("invalid_redirect_uri")
    }

    expect(
      (await oauthError(registerClient({ client_name: "No URIs" }))).error,
    ).toBe("invalid_redirect_uri")
    expect(
      (
        await oauthError(
          registerClient({
            redirect_uris: [REDIRECT],
            grant_types: ["client_credentials"],
          }),
        )
      ).error,
    ).toBe("invalid_client_metadata")
  })

  it("prunes registrations no sign-in used within a day", async () => {
    await publicClient("Never used")
    const used = await publicClient("Used")
    await approve(used, pkce().challenge)

    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000)
    await publicClient("New")

    const names = (await db().oAuthClient.findMany()).map((row) => row.name)
    expect(names.sort()).toEqual(["New", "Used"])
  })
})

describe("client metadata documents", () => {
  const DOCUMENT_URL = "https://claude.ai/oauth/mcp-oauth-client-metadata"
  const document = {
    client_id: DOCUMENT_URL,
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }

  function serving(
    body: string,
    init: ResponseInit = {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  ): DocumentFetcher & { calls: string[] } {
    const calls: string[] = []
    const fetcher = async (url: string) => {
      calls.push(url)
      return new Response(body, init)
    }
    return Object.assign(fetcher, { calls })
  }

  it("signs in a client by the URL of its document", async () => {
    const fetcher = serving(JSON.stringify(document))
    const { verifier, challenge } = pkce()
    const check = await checkAuthorizationRequest(
      params(DOCUMENT_URL, challenge, {
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      }),
      PUBLIC_URL,
      fetcher,
    )

    expect(check.kind).toBe("ok")
    const request = (check as { request: AuthorizationRequest }).request
    expect(request.client).toMatchObject({
      name: "Claude",
      host: "claude.ai",
      fromDocument: true,
    })
    expect(fetcher.calls).toEqual([DOCUMENT_URL])

    const { redirect } = await approveAuthorization(
      ctx,
      request,
      { token: { name: "Claude", allowAllServers: true } },
      PUBLIC_URL,
    )
    const code = new URL(redirect).searchParams.get("code")!
    const tokens = await tokenRequest(
      {
        grant_type: "authorization_code",
        client_id: DOCUMENT_URL,
        code,
        code_verifier: verifier,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      },
      null,
      PUBLIC_URL,
    )
    expect(await resolveAccessToken(tokens.access_token)).not.toBeNull()
  })

  it("refuses a document that is not the client's own, public, small and JSON", async () => {
    const refusals: Array<[DocumentFetcher, string]> = [
      [
        serving(
          JSON.stringify({ ...document, client_id: "https://x.example/c" }),
        ),
        "another client_id",
      ],
      [
        serving(JSON.stringify({ ...document, client_secret: "s" })),
        "client_secret",
      ],
      [
        serving(
          JSON.stringify({
            ...document,
            token_endpoint_auth_method: "client_secret_basic",
          }),
        ),
        "without a secret",
      ],
      [
        serving(JSON.stringify({ ...document, redirect_uris: [] })),
        "redirect_uris",
      ],
      [
        serving("", {
          status: 302,
          headers: { location: "https://elsewhere.example/doc" },
        }),
        "no redirect",
      ],
      [
        serving(JSON.stringify(document), {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
        "not JSON",
      ],
      [
        serving(JSON.stringify({ ...document, padding: "x".repeat(6 * 1024) })),
        "larger than 5 KB",
      ],
    ]

    for (const [fetcher, message] of refusals) {
      const error = await oauthError(fetchClientMetadata(DOCUMENT_URL, fetcher))
      expect(error.error).toBe("invalid_client")
      expect(error.message).toContain(message)
    }
  })

  it("never reads a document at a local or malformed address", async () => {
    const fetcher = serving(JSON.stringify(document))

    for (const url of [
      "https://localhost/client",
      "https://192.168.1.10/client",
      "https://pcp.local/client",
      "https://claude.ai",
      "https://claude.ai/a/../client",
      "https://user:pw@claude.ai/client",
    ]) {
      await oauthError(fetchClientMetadata(url, fetcher))
    }

    expect(fetcher.calls).toEqual([])
  })

  it("takes the host as the name when the document gives none", () => {
    const unnamed: Record<string, unknown> = { ...document }
    delete unnamed.client_name
    expect(checkClientMetadata(DOCUMENT_URL, unnamed).name).toBe("claude.ai")
  })
})
