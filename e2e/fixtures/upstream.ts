import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { randomBytes, createHash } from "node:crypto"
import type { AddressInfo } from "node:net"

import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server"
import { z } from "zod"

/**
 * A stand-in for the MCP servers PCP proxies to, for the e2e suite:
 *
 * - `/mcp` — an MCP server with a few tools, protected by a bearer token
 *   (`expectedToken`) when one is set. `echo_auth` returns the Authorization
 *   header it received, which is how the tests prove the secret PCP holds
 *   reached the upstream and nothing else did.
 * - `/oauth/mcp` — the same server behind OAuth: an authorization server
 *   with metadata, dynamic client registration, an authorize page that
 *   approves at once, and a token endpoint. Enough for the real SDK flow
 *   PCP runs, nothing more.
 * - `/closed/mcp` — the same tools behind an authorization server (issuer
 *   `${origin}/closed`) that lets no app register itself, like most large
 *   providers: it knows one client (`closedClient`), whose redirect URIs a
 *   test fills in the way an owner would in a provider's console. It wants
 *   the client secret at the token endpoint, and hands out a refresh token
 *   only when the sign-in asked for `access_type=offline`.
 *
 * - `/openapi.json` and `/api/*` — a small REST API (a pet store) with its
 *   OpenAPI document, for PCP's API endpoints. `/api/*` wants the same
 *   bearer token as `/mcp` and records every request in `requests`, which is
 *   how the tests assert what PCP actually sent. `/openapi.json` is open,
 *   like most published schemas, and its server is `${origin}/api`.
 * - `/keyed/openapi.json` and `/keyed/*` — an API whose credential comes in
 *   two parts, a key and a secret key each in its own header, as Porkbun's
 *   does (`keyedKeys`). `/keyed/ping` answers with the secret key it got,
 *   as an API that echoes a credential back would, and records every
 *   request's headers in `keyedRequests`.
 *
 * Everything is in memory. Start one per test file.
 */

type Registered = { client_id: string; redirect_uris: string[] }
type Code = {
  client_id: string
  redirect_uri: string
  challenge: string
  offline?: boolean
}

export type Upstream = {
  origin: string
  mcpUrl: string
  oauthMcpUrl: string
  closedMcpUrl: string
  /** The one client the closed authorization server knows. */
  closedClient: { id: string; secret: string; redirectUris: Set<string> }
  /** The query of every sign-in the closed authorization server saw. */
  closedSignIns: Array<Record<string, string>>
  expectedToken: string
  /** Tokens the fake authorization server has issued. */
  issuedTokens: Set<string>
  /**
   * Tools the server gains while a test runs: add a name and the next
   * tools/list has a tool by that name, which answers with its own name. How the tests show PCP picking up a changed tool list.
   */
  lateTools: Set<string>
  /** Every tools/call the server handled, in order. */
  calls: Array<{
    tool: string
    args: Record<string, unknown>
    authorization: string | null
  }>
  /** The OpenAPI document of the pet store. */
  openapiUrl: string
  /** The key and secret key /keyed/* wants, in their two headers. */
  keyedKeys: { apiKey: string; secretKey: string }
  /** The two key headers of every request to /keyed/*, in order. */
  keyedRequests: Array<{ apiKey: string | null; secretKey: string | null }>
  /** Every request to /api/*, in order, whether or not it was allowed. */
  requests: Array<{
    method: string
    path: string
    query: Record<string, string>
    authorization: string | null
    contentType: string | null
    body: string
  }>
  close: () => Promise<void>
}

type Pet = { id: number; name: string; status: string }

/**
 * The pet store's OpenAPI document. Two operations are there to be left out:
 * one needs a cookie and one uploads a file, neither of which PCP sends.
 */
function petstoreSpec(origin: string) {
  const petId = {
    name: "petId",
    in: "path",
    required: true,
    schema: { type: "integer" },
  }
  const pet = {
    type: "object",
    required: ["name"],
    properties: {
      id: { type: "integer", readOnly: true },
      name: { type: "string" },
      status: { type: "string", enum: ["available", "sold"] },
    },
  }

  return {
    openapi: "3.0.3",
    info: { title: "Pet store", description: "Pets for sale.", version: "1" },
    servers: [{ url: `${origin}/api` }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: { Pet: pet },
    },
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          summary: "List pets",
          description: "Pets in the store, optionally only one status.",
          parameters: [
            {
              name: "status",
              in: "query",
              schema: { type: "string", enum: ["available", "sold"] },
            },
            { name: "limit", in: "query", schema: { type: "integer" } },
          ],
          responses: { "200": { description: "The pets" } },
        },
        post: {
          operationId: "createPet",
          summary: "Add a pet",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
          },
          responses: { "201": { description: "The new pet" } },
        },
      },
      "/pets/{petId}": {
        get: {
          operationId: "getPet",
          summary: "Get a pet",
          parameters: [petId],
          responses: { "200": { description: "The pet" } },
        },
        delete: {
          operationId: "deletePet",
          summary: "Remove a pet",
          parameters: [petId],
          responses: { "204": { description: "Removed" } },
        },
      },
      "/pets/{petId}/photo": {
        post: {
          operationId: "uploadPhoto",
          parameters: [petId],
          requestBody: {
            required: true,
            content: { "multipart/form-data": { schema: { type: "object" } } },
          },
          responses: { "200": { description: "Stored" } },
        },
      },
      "/session": {
        get: {
          operationId: "getSession",
          parameters: [
            {
              name: "sid",
              in: "cookie",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: { "200": { description: "The session" } },
        },
      },
    },
  }
}

function buildServer(
  calls: Upstream["calls"],
  authorization: () => string | null,
  lateTools: Set<string>,
): McpServer {
  const server = new McpServer(
    { name: "fake-upstream", version: "1.0.0" },
    {
      instructions: "A pretend service with a few tools, used to test PCP.",
    },
  )

  server.registerTool(
    "echo_auth",
    {
      title: "Echo authorization",
      description:
        "Returns the Authorization header this server received, to prove which credential reached it.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      calls.push({
        tool: "echo_auth",
        args: {},
        authorization: authorization(),
      })
      return {
        content: [{ type: "text", text: authorization() ?? "(none)" }],
      }
    },
  )

  server.registerTool(
    "add_numbers",
    {
      title: "Add numbers",
      description: "Adds two numbers together and returns the sum.",
      inputSchema: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ a, b }) => {
      calls.push({
        tool: "add_numbers",
        args: { a, b },
        authorization: authorization(),
      })
      return { content: [{ type: "text", text: String(a + b) }] }
    },
  )

  server.registerTool(
    "send_postcard",
    {
      title: "Send a postcard",
      description:
        "Mails a postcard with a message to an address. Irreversible.",
      inputSchema: z.object({
        to: z.string().describe("Recipient"),
        message: z.string().describe("What to write"),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ to, message }) => {
      calls.push({
        tool: "send_postcard",
        args: { to, message },
        authorization: authorization(),
      })
      return { content: [{ type: "text", text: `Sent to ${to}: ${message}` }] }
    },
  )

  for (const name of lateTools) {
    server.registerTool(
      name,
      {
        description: `A tool the server added later: ${name}.`,
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => {
        calls.push({ tool: name, args: {}, authorization: authorization() })
        return { content: [{ type: "text", text: name }] }
      },
    )
  }

  return server
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function toWebRequest(
  request: IncomingMessage,
  origin: string,
  body: string,
): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(key, value)
    else if (Array.isArray(value)) headers.set(key, value.join(", "))
  }
  const method = request.method ?? "GET"
  return new Request(new URL(request.url ?? "/", origin), {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  })
}

async function sendWebResponse(response: Response, res: ServerResponse) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

/** The two-key API's OpenAPI document: both keys, required together. */
export function keyedSpec(origin: string) {
  return {
    openapi: "3.0.3",
    info: { title: "Domains", description: "Domains for sale.", version: "1" },
    servers: [{ url: `${origin}/keyed` }],
    security: [{ ApiKeyHeader: [], SecretApiKeyHeader: [] }],
    components: {
      securitySchemes: {
        ApiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key" },
        SecretApiKeyHeader: {
          type: "apiKey",
          in: "header",
          name: "X-Secret-API-Key",
        },
      },
    },
    paths: {
      "/ping": {
        post: {
          operationId: "ping",
          summary: "Check the keys",
          responses: { "200": { description: "The keys work" } },
        },
      },
    },
  }
}

export async function startUpstream({
  expectedToken = `upstream-secret-${randomBytes(6).toString("hex")}`,
}: { expectedToken?: string } = {}): Promise<Upstream> {
  const calls: Upstream["calls"] = []
  const lateTools = new Set<string>()
  const requests: Upstream["requests"] = []
  const keyedKeys = {
    apiKey: `pk1_${randomBytes(6).toString("hex")}`,
    secretKey: `sk1_${randomBytes(6).toString("hex")}`,
  }
  const keyedRequests: Upstream["keyedRequests"] = []
  const pets: Pet[] = [
    { id: 1, name: "Fido", status: "available" },
    { id: 2, name: "Tom", status: "sold" },
  ]
  const issuedTokens = new Set<string>()
  const clients = new Map<string, Registered>()
  const codes = new Map<string, Code>()
  const closedClient = {
    id: "closed-client",
    secret: `closed-secret-${randomBytes(6).toString("hex")}`,
    redirectUris: new Set<string>(),
  }
  const closedSignIns: Upstream["closedSignIns"] = []
  let origin = ""

  // The Authorization header of the request being served, read by the
  // tools above. One request is served at a time in these tests.
  let currentAuthorization: string | null = null

  const handlers: Record<string, McpHttpHandler> = {
    "/mcp": createMcpHandler(
      () => buildServer(calls, () => currentAuthorization, lateTools),
      {
        legacy: "stateless",
      },
    ),
    "/oauth/mcp": createMcpHandler(
      () => buildServer(calls, () => currentAuthorization, lateTools),
      {
        legacy: "stateless",
      },
    ),
    "/closed/mcp": createMcpHandler(
      () => buildServer(calls, () => currentAuthorization, lateTools),
      {
        legacy: "stateless",
      },
    ),
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin)
    const body = await readBody(req)
    const authorization = req.headers.authorization ?? null

    try {
      if (url.pathname === "/mcp") {
        if (authorization !== `Bearer ${expectedToken}`) {
          return json(res, 401, { error: "unauthorized" })
        }
        currentAuthorization = authorization
        return await sendWebResponse(
          await handlers["/mcp"].fetch(toWebRequest(req, origin, body)),
          res,
        )
      }

      if (url.pathname === "/oauth/mcp" || url.pathname === "/closed/mcp") {
        const token = authorization?.replace(/^Bearer\s+/i, "")
        if (!token || !issuedTokens.has(token)) {
          res.setHeader(
            "WWW-Authenticate",
            `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${url.pathname}"`,
          )
          return json(res, 401, { error: "unauthorized" })
        }
        currentAuthorization = authorization
        return await sendWebResponse(
          await handlers[url.pathname].fetch(toWebRequest(req, origin, body)),
          res,
        )
      }

      if (url.pathname === "/.well-known/oauth-protected-resource/closed/mcp") {
        return json(res, 200, {
          resource: `${origin}/closed/mcp`,
          authorization_servers: [`${origin}/closed`],
        })
      }

      if (url.pathname === "/.well-known/oauth-authorization-server/closed") {
        // No registration_endpoint, and no client metadata documents.
        return json(res, 200, {
          issuer: `${origin}/closed`,
          authorization_endpoint: `${origin}/closed/authorize`,
          token_endpoint: `${origin}/closed/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: [
            "client_secret_basic",
            "client_secret_post",
          ],
        })
      }

      if (url.pathname === "/closed/authorize") {
        closedSignIns.push(Object.fromEntries(url.searchParams))
        const redirectUri = url.searchParams.get("redirect_uri") ?? ""
        if (
          url.searchParams.get("client_id") !== closedClient.id ||
          !closedClient.redirectUris.has(redirectUri)
        ) {
          return json(res, 400, { error: "invalid_request" })
        }
        const code = `code-${randomBytes(8).toString("hex")}`
        codes.set(code, {
          client_id: closedClient.id,
          redirect_uri: redirectUri,
          challenge: url.searchParams.get("code_challenge") ?? "",
          offline: url.searchParams.get("access_type") === "offline",
        })
        const back = new URL(redirectUri)
        back.searchParams.set("code", code)
        back.searchParams.set("state", url.searchParams.get("state") ?? "")
        back.searchParams.set("iss", `${origin}/closed`)
        res.statusCode = 302
        res.setHeader("location", back.toString())
        return res.end()
      }

      if (url.pathname === "/closed/token" && req.method === "POST") {
        const form = new URLSearchParams(body)
        const basic = authorization?.startsWith("Basic ")
          ? Buffer.from(authorization.slice(6), "base64").toString()
          : null
        const [id, secret] = basic
          ? basic.split(":").map(decodeURIComponent)
          : [form.get("client_id"), form.get("client_secret")]
        if (id !== closedClient.id || secret !== closedClient.secret) {
          return json(res, 401, { error: "invalid_client" })
        }
        let offline = false
        if (form.get("grant_type") === "authorization_code") {
          const code = codes.get(form.get("code") ?? "")
          const expected = createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url")
          if (!code || code.challenge !== expected) {
            return json(res, 400, { error: "invalid_grant" })
          }
          codes.delete(form.get("code") ?? "")
          offline = code.offline ?? false
        } else if (form.get("grant_type") === "refresh_token") {
          if (!issuedTokens.has(`refresh:${form.get("refresh_token")}`)) {
            return json(res, 400, { error: "invalid_grant" })
          }
        } else {
          return json(res, 400, { error: "unsupported_grant_type" })
        }
        const access = `access-${randomBytes(8).toString("hex")}`
        issuedTokens.add(access)
        const refresh = offline
          ? `refresh-${randomBytes(8).toString("hex")}`
          : null
        if (refresh) issuedTokens.add(`refresh:${refresh}`)
        return json(res, 200, {
          access_token: access,
          token_type: "Bearer",
          expires_in: 3600,
          ...(refresh ? { refresh_token: refresh } : {}),
        })
      }

      if (url.pathname === "/openapi.json") {
        return json(res, 200, petstoreSpec(origin))
      }

      if (url.pathname === "/keyed/openapi.json") {
        return json(res, 200, keyedSpec(origin))
      }

      if (url.pathname.startsWith("/keyed/")) {
        const header = (name: string) => {
          const value = req.headers[name]
          return typeof value === "string" ? value : null
        }
        const sent = {
          apiKey: header("x-api-key"),
          secretKey: header("x-secret-api-key"),
        }
        keyedRequests.push(sent)

        if (
          sent.apiKey !== keyedKeys.apiKey ||
          sent.secretKey !== keyedKeys.secretKey
        ) {
          return json(res, 401, { status: "ERROR", message: "Invalid keys." })
        }

        if (url.pathname === "/keyed/ping" && req.method === "POST") {
          return json(res, 200, { status: "SUCCESS", yourKey: sent.secretKey })
        }

        return json(res, 404, { error: "not_found" })
      }

      if (url.pathname.startsWith("/api/")) {
        requests.push({
          method: req.method ?? "GET",
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          authorization,
          contentType: req.headers["content-type"] ?? null,
          body,
        })

        if (authorization !== `Bearer ${expectedToken}`) {
          return json(res, 401, { error: "unauthorized" })
        }

        const one = /^\/api\/pets\/(\d+)$/.exec(url.pathname)

        if (url.pathname === "/api/pets" && req.method === "GET") {
          const status = url.searchParams.get("status")
          const limit = Number(url.searchParams.get("limit") ?? pets.length)
          return json(
            res,
            200,
            pets
              .filter((pet) => !status || pet.status === status)
              .slice(0, limit),
          )
        }

        if (url.pathname === "/api/pets" && req.method === "POST") {
          const input = JSON.parse(body || "{}") as Partial<Pet>
          const pet = {
            id: Math.max(0, ...pets.map((entry) => entry.id)) + 1,
            name: String(input.name ?? ""),
            status: String(input.status ?? "available"),
          }
          pets.push(pet)
          return json(res, 201, pet)
        }

        if (one && req.method === "GET") {
          const pet = pets.find((entry) => entry.id === Number(one[1]))
          return pet
            ? json(res, 200, pet)
            : json(res, 404, { error: "no such pet" })
        }

        if (one && req.method === "DELETE") {
          const index = pets.findIndex((entry) => entry.id === Number(one[1]))
          if (index < 0) return json(res, 404, { error: "no such pet" })
          pets.splice(index, 1)
          res.statusCode = 204
          return res.end()
        }

        return json(res, 404, { error: "not_found" })
      }

      if (url.pathname === "/.well-known/oauth-protected-resource/oauth/mcp") {
        return json(res, 200, {
          resource: `${origin}/oauth/mcp`,
          authorization_servers: [origin],
        })
      }

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["postcards"],
        })
      }

      if (url.pathname === "/register" && req.method === "POST") {
        const metadata = JSON.parse(body) as { redirect_uris?: string[] }
        const client_id = `client-${randomBytes(4).toString("hex")}`
        clients.set(client_id, {
          client_id,
          redirect_uris: metadata.redirect_uris ?? [],
        })
        return json(res, 201, {
          client_id,
          redirect_uris: metadata.redirect_uris ?? [],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        })
      }

      if (url.pathname === "/authorize") {
        const clientId = url.searchParams.get("client_id") ?? ""
        const redirectUri = url.searchParams.get("redirect_uri") ?? ""
        const client = clients.get(clientId)
        if (!client || !client.redirect_uris.includes(redirectUri)) {
          return json(res, 400, { error: "invalid_client" })
        }
        // A real server shows a consent screen; this one says yes.
        const code = `code-${randomBytes(8).toString("hex")}`
        codes.set(code, {
          client_id: clientId,
          redirect_uri: redirectUri,
          challenge: url.searchParams.get("code_challenge") ?? "",
        })
        const back = new URL(redirectUri)
        back.searchParams.set("code", code)
        back.searchParams.set("state", url.searchParams.get("state") ?? "")
        back.searchParams.set("iss", origin)
        res.statusCode = 302
        res.setHeader("location", back.toString())
        return res.end()
      }

      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(body)
        if (form.get("grant_type") === "authorization_code") {
          const code = codes.get(form.get("code") ?? "")
          const verifier = form.get("code_verifier") ?? ""
          const expected = createHash("sha256")
            .update(verifier)
            .digest("base64url")
          if (
            !code ||
            code.client_id !== form.get("client_id") ||
            code.challenge !== expected
          ) {
            return json(res, 400, { error: "invalid_grant" })
          }
          codes.delete(form.get("code") ?? "")
        } else if (form.get("grant_type") === "refresh_token") {
          if (!issuedTokens.has(`refresh:${form.get("refresh_token")}`)) {
            return json(res, 400, { error: "invalid_grant" })
          }
        } else {
          return json(res, 400, { error: "unsupported_grant_type" })
        }
        const access = `access-${randomBytes(8).toString("hex")}`
        const refresh = `refresh-${randomBytes(8).toString("hex")}`
        issuedTokens.add(access)
        issuedTokens.add(`refresh:${refresh}`)
        return json(res, 200, {
          access_token: access,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: refresh,
          scope: "postcards",
        })
      }

      json(res, 404, { error: "not_found" })
    } catch (error) {
      console.error("[fake-upstream]", error)
      if (!res.headersSent) json(res, 500, { error: "internal" })
      else res.end()
    }
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  origin = `http://127.0.0.1:${port}`

  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    oauthMcpUrl: `${origin}/oauth/mcp`,
    closedMcpUrl: `${origin}/closed/mcp`,
    closedClient,
    closedSignIns,
    openapiUrl: `${origin}/openapi.json`,
    keyedKeys,
    keyedRequests,
    expectedToken,
    issuedTokens,
    lateTools,
    calls,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        for (const handler of Object.values(handlers)) void handler.close()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
