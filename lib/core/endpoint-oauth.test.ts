import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { db } from "./db"
import { createEndpoint, updateEndpoint, type EndpointInput } from "./endpoints"
import { isPcpError } from "./errors"
import { finishOAuth, startOAuth } from "./oauth"
import { oauthRedirectUrl } from "./oauth-client"
import { json, startTestApi, type TestApi } from "./openapi/test-api"
import { revealSecret } from "./secrets"
import { getServer, setOAuthClient } from "./servers"
import { scratchDatabase } from "./test-db"
import { callServerTool, describeOAuthConnection } from "./upstream"
import { setupVault } from "./vault"

/**
 * An API endpoint that signs in with OAuth, against a test server that is
 * both the API and its authorization server: the flow comes from the
 * schema, the owner's client signs in, and the token goes on every call and
 * is renewed when the API stops taking it.
 */

let cleanup: () => Promise<void>
let api: TestApi
let ctx: Awaited<ReturnType<typeof setupVault>>
/** The access tokens the API takes right now. */
let valid: Set<string>
/** What the token endpoint answers next. */
let tokenAnswers: Array<[number, Record<string, unknown>]>
/** What the authorization server publishes (RFC 8414); undefined: nothing. */
let metadata: Record<string, unknown> | undefined

const HTTP = { publicUrl: "http://pcp.lan:3000" }

function schema(origin: string, flows: Record<string, unknown> | null) {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Mail" },
    servers: [{ url: `${origin}/api` }],
    components: flows
      ? { securitySchemes: { oauth: { type: "oauth2", flows } } }
      : {},
    paths: {
      "/me": {
        get: {
          operationId: "me",
          security: [{ oauth: ["mail.read"] }],
        },
      },
      "/send": {
        post: {
          operationId: "send",
          security: [{ oauth: ["mail.send"] }],
          parameters: [
            // The token's header is PCP's: never an argument.
            { name: "Authorization", in: "header", schema: { type: "string" } },
          ],
        },
      },
    },
  })
}

function flowsAt(origin: string) {
  return {
    authorizationCode: {
      authorizationUrl: `${origin}/authorize`,
      tokenUrl: `${origin}/token`,
      scopes: { "mail.read": "Read", "mail.send": "Send", "mail.admin": "" },
    },
  }
}

function input(extra: Partial<EndpointInput> = {}): EndpointInput {
  return {
    name: "Mail",
    baseUrl: `${api.origin}/api`,
    specSource: "upload",
    specText: schema(api.origin, flowsAt(api.origin)),
    readOnly: false,
    authType: "oauth",
    oauthClientId: "owner-client",
    oauthClientSecretValue: "owner-secret",
    ...extra,
  }
}

async function connect(id: string) {
  const start = await startOAuth(ctx, id, HTTP)
  expect(start).toHaveProperty("redirectTo")
  const url = new URL((start as { redirectTo: string }).redirectTo)

  await finishOAuth(
    ctx,
    new URLSearchParams({
      code: "the-code",
      state: url.searchParams.get("state")!,
    }),
    HTTP,
  )

  return url
}

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({ name: "Ada", password: "correct horse battery" })
  valid = new Set(["at-1"])
  tokenAnswers = [
    [
      200,
      {
        access_token: "at-1",
        refresh_token: "rt-1",
        token_type: "Bearer",
        expires_in: 3600,
      },
    ],
  ]
  metadata = undefined
  api = await startTestApi((req, res) => {
    const path = req.url.split("?")[0]

    if (
      path === "/.well-known/oauth-authorization-server" ||
      path === "/.well-known/openid-configuration"
    ) {
      return metadata ? json(res, 200, metadata) : json(res, 404, {})
    }

    // RFC 7591: a client registers itself and is told its ID.
    if (path === "/register") {
      return json(res, 201, {
        ...(JSON.parse(req.body) as Record<string, unknown>),
        client_id: "dynamic-client",
      })
    }

    if (path === "/token") {
      const [status, body] = tokenAnswers.shift() ?? [500, {}]
      return json(res, status, body)
    }

    if (path.startsWith("/api/")) {
      const token = (req.headers.authorization ?? "").replace("Bearer ", "")

      if (!valid.has(token)) {
        return json(res, 401, { error: "invalid_token" })
      }

      // An API that repeats what it was sent, token included.
      return json(res, 200, { you: "ada", echo: req.headers.authorization })
    }

    json(res, 404, {})
  })
})

afterEach(async () => {
  await api.close()
  await cleanup()
})

describe("an OAuth API endpoint", () => {
  it("is made from the schema's flow, with the scopes its operations need", async () => {
    const { id } = await createEndpoint(ctx, input())
    const server = await getServer(ctx, id)

    expect(server).toMatchObject({
      authType: "oauth",
      oauthClientId: "owner-client",
      oauthAuthorizationUrl: `${api.origin}/authorize`,
      oauthTokenUrl: `${api.origin}/token`,
      oauthScope: "mail.read mail.send",
      authHeaderName: "Authorization",
    })
    expect(await revealSecret(ctx, server.oauthClientSecretId!)).toBe(
      "owner-secret",
    )
    // The header the token goes in is not an argument of any tool.
    const send = server.tools.find((tool) => tool.name === "send")!
    expect(send.inputSchema).not.toMatch(/Authorization/)

    const readOnly = await createEndpoint(
      ctx,
      input({
        name: "Mail read",
        readOnly: true,
        oauthClientSecretValue: null,
      }),
    )
    expect((await getServer(ctx, readOnly.id)).oauthScope).toBe("mail.read")
  })

  it("refuses OAuth for a schema that declares no sign-in", async () => {
    await expect(
      createEndpoint(ctx, input({ specText: schema(api.origin, null) })),
    ).rejects.toThrow(/declares no OAuth sign-in/)
    await expect(
      createEndpoint(
        ctx,
        input({
          specText: schema(api.origin, {
            clientCredentials: { tokenUrl: `${api.origin}/token` },
          }),
        }),
      ),
    ).rejects.toThrow(/no authorization code flow/)
    // Nothing was kept from either attempt: not the row, not the secret.
    expect(await db().mcpServer.count()).toBe(0)
    expect(await db().secret.count()).toBe(0)
  })

  it("signs in with the owner's client, calls with the token, and renews it", async () => {
    const { id } = await createEndpoint(ctx, input())

    // Not connected yet: the gateway is told to have the owner connect it.
    await expect(
      callServerTool(ctx, await getServer(ctx, id), "me", {}, HTTP),
    ).rejects.toSatisfy(
      (error) => isPcpError(error) && error.code === "unauthorized",
    )

    const signIn = await connect(id)
    expect(signIn.origin + signIn.pathname).toBe(`${api.origin}/authorize`)
    expect(Object.fromEntries(signIn.searchParams)).toMatchObject({
      client_id: "owner-client",
      redirect_uri: oauthRedirectUrl(HTTP.publicUrl),
      scope: "mail.read mail.send",
      response_type: "code",
      code_challenge_method: "S256",
    })
    // A REST API names no resource; a provider may refuse one.
    expect(signIn.searchParams.has("resource")).toBe(false)

    const exchange = api.requests.find((req) => req.url === "/token")!
    expect(exchange.headers.authorization).toBe(
      `Basic ${Buffer.from("owner-client:owner-secret").toString("base64")}`,
    )
    expect(new URLSearchParams(exchange.body).get("grant_type")).toBe(
      "authorization_code",
    )
    expect(new URLSearchParams(exchange.body).has("resource")).toBe(false)

    let server = await getServer(ctx, id)
    expect(server.status).toBe("ok")
    expect(await describeOAuthConnection(ctx, server)).toMatchObject({
      renewable: true,
    })

    const first = await callServerTool(ctx, server, "me", {}, HTTP)
    expect(first.isError ?? false).toBe(false)
    const firstText = JSON.stringify(first)
    expect(firstText).toContain("ada")
    // The API repeating the token does not hand it to the assistant.
    expect(firstText).not.toContain("at-1")

    // The API stops taking the token: PCP renews it and tries once more.
    valid = new Set(["at-2"])
    tokenAnswers.push([
      200,
      { access_token: "at-2", token_type: "Bearer", expires_in: 3600 },
    ])
    const second = await callServerTool(ctx, server, "me", {}, HTTP)
    expect(second.isError ?? false).toBe(false)
    const renewal = api.requests.filter((req) => req.url === "/token").at(-1)!
    expect(Object.fromEntries(new URLSearchParams(renewal.body))).toMatchObject(
      { grant_type: "refresh_token", refresh_token: "rt-1" },
    )
    expect(
      api.requests.filter((req) => req.url === "/api/me").at(-1)!.headers
        .authorization,
    ).toBe("Bearer at-2")

    // A renewal the provider refuses: it needs signing in again.
    valid = new Set()
    tokenAnswers.push([400, { error: "invalid_grant" }])
    server = await getServer(ctx, id)
    await expect(callServerTool(ctx, server, "me", {}, HTTP)).rejects.toSatisfy(
      (error) => isPcpError(error) && error.code === "unauthorized",
    )
    expect(await getServer(ctx, id)).toMatchObject({
      oauthConnectedAt: null,
      status: "auth_required",
    })
  })

  it("renews a token that has run out before calling", async () => {
    const { id } = await createEndpoint(ctx, input())
    tokenAnswers = [
      [
        200,
        {
          access_token: "at-1",
          refresh_token: "rt-1",
          token_type: "Bearer",
          expires_in: 30,
        },
      ],
      [200, { access_token: "at-2", token_type: "Bearer", expires_in: 3600 }],
    ]
    valid = new Set(["at-2"])
    await connect(id)

    const result = await callServerTool(
      ctx,
      await getServer(ctx, id),
      "me",
      {},
      HTTP,
    )
    expect(result.isError ?? false).toBe(false)
    // Only one call reached the API, with the renewed token.
    const calls = api.requests.filter((req) => req.url === "/api/me")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.headers.authorization).toBe("Bearer at-2")
  })

  it("asks for a client when there is none, and takes it on the endpoint's page", async () => {
    const { id } = await createEndpoint(
      ctx,
      input({ oauthClientId: null, oauthClientSecretValue: null }),
    )

    // The schema names no registration endpoint: the owner makes a client.
    await expect(startOAuth(ctx, id, HTTP)).rejects.toThrow(
      /needs an OAuth client from you/,
    )
    expect((await getServer(ctx, id)).status).toBe("client_required")

    await setOAuthClient(ctx, id, {
      clientId: "owner-client",
      clientSecretValue: "owner-secret",
    })
    const signIn = await connect(id)
    expect(signIn.searchParams.get("client_id")).toBe("owner-client")
    expect((await getServer(ctx, id)).oauthConnectedAt).not.toBeNull()
  })

  describe("at a provider that lets apps register themselves", () => {
    /** What such an authorization server publishes about itself. */
    function published(overrides: Record<string, unknown> = {}) {
      return {
        issuer: api.origin,
        authorization_endpoint: `${api.origin}/authorize`,
        token_endpoint: `${api.origin}/token`,
        registration_endpoint: `${api.origin}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        ...overrides,
      }
    }

    const asked = (path: string) =>
      api.requests.filter((req) => req.url.split("?")[0] === path)
    const noClient = { oauthClientId: null, oauthClientSecretValue: null }

    it("registers PCP itself, signs in with that client, and renews with it", async () => {
      metadata = published()
      const { id } = await createEndpoint(ctx, input(noClient))

      const signIn = await connect(id)
      expect(signIn.origin + signIn.pathname).toBe(`${api.origin}/authorize`)
      expect(signIn.searchParams.get("client_id")).toBe("dynamic-client")

      // Registered once, with PCP's one redirect address.
      expect(asked("/register")).toHaveLength(1)
      expect(JSON.parse(asked("/register")[0]!.body)).toMatchObject({
        redirect_uris: [oauthRedirectUrl(HTTP.publicUrl)],
      })

      let server = await getServer(ctx, id)
      expect(server).toMatchObject({ status: "ok", oauthClientId: null })
      const first = await callServerTool(ctx, server, "me", {}, HTTP)
      expect(first.isError ?? false).toBe(false)
      expect(api.requests.find((req) => req.url === "/api/me")).toBeDefined()

      // The API stops taking the token: renewed as the client PCP registered.
      valid = new Set(["at-2"])
      tokenAnswers.push([
        200,
        { access_token: "at-2", token_type: "Bearer", expires_in: 3600 },
      ])
      server = await getServer(ctx, id)
      const second = await callServerTool(ctx, server, "me", {}, HTTP)
      expect(second.isError ?? false).toBe(false)
      const renewal = asked("/token").at(-1)!
      expect(
        Object.fromEntries(new URLSearchParams(renewal.body)),
      ).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "rt-1",
        client_id: "dynamic-client",
      })
      // Only the first connection registered.
      expect(asked("/register")).toHaveLength(1)
    })

    it("asks for a client when what it publishes names other addresses", async () => {
      metadata = published({
        authorization_endpoint: "https://elsewhere.example/authorize",
        token_endpoint: "https://elsewhere.example/token",
      })
      const { id } = await createEndpoint(ctx, input(noClient))

      await expect(startOAuth(ctx, id, HTTP)).rejects.toThrow(
        /https:\/\/elsewhere\.example\/authorize.*not the addresses this endpoint was approved with/,
      )
      expect((await getServer(ctx, id)).status).toBe("client_required")
      // PCP did not register where the owner did not approve.
      expect(asked("/register")).toHaveLength(0)
    })

    it("asks for a client when the provider publishes nothing, or no registration endpoint", async () => {
      const { id } = await createEndpoint(ctx, input(noClient))

      await expect(startOAuth(ctx, id, HTTP)).rejects.toThrow(
        /needs an OAuth client from you/,
      )

      metadata = published({ registration_endpoint: undefined })
      await expect(startOAuth(ctx, id, HTTP)).rejects.toThrow(
        /needs an OAuth client from you: it does not let apps register/,
      )
      expect(asked("/register")).toHaveLength(0)
    })

    it("does not read the metadata when the owner brought a client", async () => {
      metadata = published()
      const { id } = await createEndpoint(ctx, input())

      const signIn = await connect(id)
      expect(signIn.searchParams.get("client_id")).toBe("owner-client")
      expect(asked("/register")).toHaveLength(0)
      expect(
        api.requests.filter((req) => req.url.includes(".well-known")),
      ).toHaveLength(0)
    })

    it("does not reach a private address to find out, for an endpoint that keeps to public ones", async () => {
      metadata = published()
      const { id } = await createEndpoint(
        ctx,
        input({ ...noClient, publicOnly: true }),
      )

      await expect(startOAuth(ctx, id, HTTP)).rejects.toThrow(
        /needs an OAuth client from you/,
      )
      expect(
        api.requests.filter((req) => req.url.includes(".well-known")),
      ).toHaveLength(0)
    })
  })

  it("keeps the approved addresses when the schema moves them, and drops the tokens when the owner takes new ones", async () => {
    const { id } = await createEndpoint(ctx, input())
    await connect(id)
    const moved = schema(api.origin, {
      authorizationCode: {
        authorizationUrl: "https://elsewhere.example/authorize",
        tokenUrl: "https://elsewhere.example/token",
      },
    })

    // The owner saving the form with the new schema takes the new addresses,
    // and the tokens from the old sign-in go.
    await updateEndpoint(ctx, id, input({ specText: moved }))
    const server = await getServer(ctx, id)
    expect(server).toMatchObject({
      oauthAuthorizationUrl: "https://elsewhere.example/authorize",
      oauthTokenUrl: "https://elsewhere.example/token",
      oauthConnectedAt: null,
      oauthTokensId: null,
    })
  })
})
