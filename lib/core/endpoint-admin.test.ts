import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import { db } from "./db"
import {
  getEndpoint,
  registerEndpoint,
  updateEndpointDetails,
  type EndpointScope,
} from "./endpoint-admin"
import { createEndpoint, updateEndpoint } from "./endpoints"
import { loadGatewayServers } from "./gateway"
import { json, startTestApi, type TestApi } from "./openapi/test-api"
import { createSecret } from "./secrets"
import { createServer, getServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { callServerTool } from "./upstream"
import { setupVault } from "./vault"

let cleanup: () => Promise<void>
let api: TestApi
let ctx: Awaited<ReturnType<typeof setupVault>>
let scope: EndpointScope

const KEY = "sk-live-0123456789"
const PUBLIC = { publicUrl: "http://localhost:3000" }

function spec(origin: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Pets", description: "Pets for sale." },
    servers: [{ url: `${origin}/api` }],
    paths: {
      "/pets": {
        get: { operationId: "listPets", summary: "List pets" },
        post: {
          operationId: "createPet",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    ...extra,
  })
}

/** An endpoint the owner made: any address, optionally with their secret. */
async function ownerEndpoint(overrides: Record<string, unknown> = {}) {
  const { id: secretId } = await createSecret(ctx, {
    name: "Pets billing credential",
    value: KEY,
  })
  const { id } = await createEndpoint(ctx, {
    name: "Owner pets",
    specSource: "upload",
    specText: spec(api.origin),
    readOnly: false,
    authType: "header",
    authSecretId: secretId,
    authHeaderName: "X-API-Key",
    authValueTemplate: "{{secret}}",
    ...overrides,
  })
  return { id, secretId }
}

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  scope = { ctx, tokenId: "token", serverIds: null }
  api = await startTestApi((req, res) => json(res, 200, { path: req.url }))
})

afterEach(async () => {
  await api.close()
  await cleanup()
})

describe("a token's right to manage endpoints", () => {
  it("is off unless the owner turns it on", async () => {
    const plain = await createApiToken(ctx, {
      name: "Plain",
      allowAllServers: true,
    })
    const managing = await createApiToken(ctx, {
      name: "Managing",
      allowAllServers: true,
      manageEndpoints: true,
    })

    expect((await resolveApiToken(plain.token))!.manageEndpoints).toBe(false)
    expect((await resolveApiToken(managing.token))!.manageEndpoints).toBe(true)
  })
})

describe("registerEndpoint", () => {
  it("adds an endpoint from schema text with no credential and public addresses only", async () => {
    const result = await registerEndpoint(scope, {
      name: "Assistant pets",
      spec: spec(api.origin),
    })

    expect(result).toMatchObject({
      endpoint: "assistant-pets",
      name: "Assistant pets",
      description: "Pets for sale.",
      baseUrl: `${api.origin}/api`,
      readOnly: false,
      publicOnly: true,
      authentication: { type: "none", header: null },
      schema: { source: "upload", url: null },
    })
    expect(
      result.tools.map((tool) => [tool.name, tool.method, tool.path]),
    ).toEqual([
      ["createPet", "POST", "/pets"],
      ["listPets", "GET", "/pets"],
    ])
    expect(result.registered).toMatch(
      /Registered Assistant pets as assistant-pets with 2 tools/,
    )

    const row = await getServer(
      ctx,
      (await db().mcpServer.findFirstOrThrow()).id,
    )
    expect(row).toMatchObject({
      kind: "openapi",
      authType: "none",
      authSecretId: null,
      publicOnly: true,
    })
  })

  it("warns that a private address is refused until the owner allows it", async () => {
    // The test API is on 127.0.0.1.
    const result = await registerEndpoint(scope, {
      name: "Local",
      spec: spec(api.origin),
    })
    expect(result.next.join(" ")).toMatch(
      /127\.0\.0\.1, a private or local address/,
    )
    expect(result.next.join(" ")).toMatch(/ask the owner to attach a secret/)
  })

  it("takes the base URL from the assistant when the schema has none", async () => {
    const relative = spec(api.origin, { servers: [{ url: "/api" }] })
    await expect(
      registerEndpoint(scope, { name: "Pets", spec: relative }),
    ).rejects.toThrow(/Enter the base URL/)

    const result = await registerEndpoint(scope, {
      name: "Pets",
      spec: relative,
      baseUrl: "https://api.example.com/v2/",
    })
    expect(result.baseUrl).toBe("https://api.example.com/v2")
  })

  it("can be read-only from the start", async () => {
    const result = await registerEndpoint(scope, {
      name: "Pets",
      spec: spec(api.origin),
      readOnly: true,
    })
    expect(result.tools.map((tool) => tool.name)).toEqual(["listPets"])
  })

  it("leaves nothing behind for a schema that does not read", async () => {
    await expect(
      registerEndpoint(scope, { name: "Bad", spec: "not a schema" }),
    ).rejects.toThrow()
    await expect(
      registerEndpoint(scope, {
        name: "Swagger",
        spec: JSON.stringify({ swagger: "2.0" }),
      }),
    ).rejects.toThrow(/Swagger 2/)
    expect(await db().mcpServer.count()).toBe(0)
  })

  it("lets a token limited to some servers use what it registered", async () => {
    const other = await createServer(ctx, {
      name: "Other",
      url: "https://mcp.example.com/mcp",
      authType: "none",
    })
    const { token } = await createApiToken(ctx, {
      name: "Scoped",
      allowAllServers: false,
      serverIds: [other.id],
      manageEndpoints: true,
    })
    const resolved = (await resolveApiToken(token))!

    const result = await registerEndpoint(resolved, {
      name: "Mine",
      spec: spec(api.origin),
    })
    const visible = await loadGatewayServers({ ...resolved, ...PUBLIC })
    // Re-resolve: the scope is read when the token is presented.
    const again = (await resolveApiToken(token))!
    const visibleNow = await loadGatewayServers({ ...again, ...PUBLIC })

    expect(visible.map((server) => server.slug)).not.toContain(result.endpoint)
    expect(visibleNow.map((server) => server.slug)).toContain(result.endpoint)
  })
})

describe("getEndpoint", () => {
  it("shows settings and tools, and what a token may change", async () => {
    const { id } = await ownerEndpoint()
    const slug = (await getServer(ctx, id)).slug
    const details = await getEndpoint(scope, slug)

    expect(details).toMatchObject({
      endpoint: "owner-pets",
      publicOnly: false,
      authentication: { type: "header", header: "X-API-Key" },
    })
    expect(details.changes.baseUrl).toMatch(/secret is attached/)
    expect(details.changes.authentication).toMatch(/only the owner/)
    expect(details.changes.spec).toBe("yes, as OpenAPI text")
  })

  it("never includes a secret, its name, or its id", async () => {
    const { id, secretId } = await ownerEndpoint()
    const details = await getEndpoint(scope, (await getServer(ctx, id)).slug, {
      includeSpec: true,
    })
    const everything = JSON.stringify(details)

    expect(everything).not.toContain(KEY)
    expect(everything).not.toContain(secretId)
    expect(everything).not.toContain("billing")
    expect(everything).not.toContain("{{secret}}")
  })

  it("returns the stored schema on request, unless it is too long", async () => {
    const result = await registerEndpoint(scope, {
      name: "Pets",
      spec: spec(api.origin),
    })
    const withSpec = await getEndpoint(scope, result.endpoint, {
      includeSpec: true,
    })
    expect(JSON.parse(withSpec.spec!)).toMatchObject({ openapi: "3.0.3" })

    const without = await getEndpoint(scope, result.endpoint)
    expect(without.spec).toBeUndefined()

    const padded = spec(api.origin, {
      info: { title: "x", description: "d".repeat(60_000) },
    })
    const big = await registerEndpoint(scope, { name: "Big", spec: padded })
    const bigDetails = await getEndpoint(scope, big.endpoint, {
      includeSpec: true,
    })
    expect(bigDetails.spec).toBeUndefined()
    expect(bigDetails.note).toMatch(/too long/)
  })

  it("does not find an MCP server, or an endpoint outside the token's scope", async () => {
    await createServer(ctx, {
      name: "Mcp",
      url: "https://mcp.example.com/mcp",
      authType: "none",
    })
    const mine = await registerEndpoint(scope, {
      name: "Mine",
      spec: spec(api.origin),
    })
    const theirs = await registerEndpoint(scope, {
      name: "Theirs",
      spec: spec(api.origin),
    })

    await expect(getEndpoint(scope, "mcp")).rejects.toThrow(
      /No API endpoint called mcp\. Endpoints: mine, theirs/,
    )

    const limited: EndpointScope = {
      ctx,
      tokenId: "t",
      serverIds: [
        (
          await db().mcpServer.findFirstOrThrow({
            where: { slug: mine.endpoint },
          })
        ).id,
      ],
    }
    await expect(getEndpoint(limited, theirs.endpoint)).rejects.toThrow(
      /Endpoints: mine\./,
    )
    await expect(
      updateEndpointDetails(limited, theirs.endpoint, { name: "Taken" }),
    ).rejects.toThrow(/No API endpoint called theirs/)
  })
})

describe("updateEndpointDetails", () => {
  it("changes name, description and tool descriptions, and says what it ignored", async () => {
    const { endpoint } = await registerEndpoint(scope, {
      name: "Pets",
      spec: spec(api.origin),
    })

    const result = await updateEndpointDetails(scope, endpoint, {
      name: "Pet shop",
      description: "Adopt a pet.",
      toolDescriptions: { listPets: "Everything in stock.", nope: "x" },
    })

    expect(result).toMatchObject({
      name: "Pet shop",
      description: "Adopt a pet.",
    })
    expect(result.tools.find((tool) => tool.name === "listPets")).toMatchObject(
      {
        description: "Everything in stock.",
        edited: true,
      },
    )
    expect(result.updated).toMatch(/No tool called nope/)

    const cleared = await updateEndpointDetails(scope, endpoint, {
      toolDescriptions: { listPets: null },
    })
    expect(cleared.tools.find((tool) => tool.name === "listPets")!.edited).toBe(
      false,
    )
  })

  it("replaces the schema of an endpoint added as text, keeping descriptions", async () => {
    const { endpoint } = await registerEndpoint(scope, {
      name: "Pets",
      spec: spec(api.origin),
    })
    await updateEndpointDetails(scope, endpoint, {
      toolDescriptions: { listPets: "Mine." },
    })

    const fewer = JSON.parse(spec(api.origin))
    delete fewer.paths["/pets"].post
    fewer.paths["/pets/{petId}"] = {
      get: {
        operationId: "getPet",
        parameters: [
          {
            name: "petId",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
      },
    }
    const result = await updateEndpointDetails(scope, endpoint, {
      spec: JSON.stringify(fewer),
    })

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "getPet",
      "listPets",
    ])
    expect(
      result.tools.find((tool) => tool.name === "listPets")!.description,
    ).toBe("Mine.")
    expect(
      (await getEndpoint(scope, endpoint, { includeSpec: true })).spec,
    ).toBe(JSON.stringify(fewer))
  })

  it("refuses an update that changes nothing", async () => {
    const { endpoint } = await registerEndpoint(scope, {
      name: "Pets",
      spec: spec(api.origin),
    })
    await expect(updateEndpointDetails(scope, endpoint, {})).rejects.toThrow(
      /Nothing to change/,
    )
  })

  it("keeps the old tools when the new schema does not read", async () => {
    const { endpoint } = await registerEndpoint(scope, {
      name: "Pets",
      spec: spec(api.origin),
    })
    await expect(
      updateEndpointDetails(scope, endpoint, { spec: "{ nope" }),
    ).rejects.toThrow()
    expect((await getEndpoint(scope, endpoint)).tools).toHaveLength(2)
  })

  describe("on an endpoint the assistant registered", () => {
    it("may move it to another address, which stays public-only", async () => {
      const { endpoint } = await registerEndpoint(scope, {
        name: "Pets",
        spec: spec(api.origin),
      })
      const result = await updateEndpointDetails(scope, endpoint, {
        baseUrl: "https://api.example.com/v3",
      })
      expect(result).toMatchObject({
        baseUrl: "https://api.example.com/v3",
        publicOnly: true,
      })
    })

    it("may turn read-only on and off", async () => {
      const { endpoint } = await registerEndpoint(scope, {
        name: "Pets",
        spec: spec(api.origin),
      })
      expect(
        (await updateEndpointDetails(scope, endpoint, { readOnly: true }))
          .tools,
      ).toHaveLength(1)
      expect(
        (await updateEndpointDetails(scope, endpoint, { readOnly: false }))
          .tools,
      ).toHaveLength(2)
    })
  })

  describe("on an endpoint that sends the owner's secret", () => {
    it("cannot be moved, by base URL or by a schema that names another server", async () => {
      const { id } = await ownerEndpoint()
      const slug = (await getServer(ctx, id)).slug

      await expect(
        updateEndpointDetails(scope, slug, {
          baseUrl: "https://evil.example.com/api",
        }),
      ).rejects.toThrow(/only the owner can change where its requests go/)

      // A new schema that names another host leaves the address where it was.
      const moved = spec("https://evil.example.com")
      const result = await updateEndpointDetails(scope, slug, { spec: moved })
      expect(result.baseUrl).toBe(`${api.origin}/api`)
      expect((await getServer(ctx, id)).url).toBe(`${api.origin}/api`)
      expect(result.updated).toMatch(
        /names https:\/\/evil\.example\.com\/api as its server/,
      )
    })

    it("accepts the same address spelled differently, as a no-op", async () => {
      const { id } = await ownerEndpoint()
      const slug = (await getServer(ctx, id)).slug
      const result = await updateEndpointDetails(scope, slug, {
        baseUrl: `${api.origin}/api/`,
        description: "Hi.",
      })
      expect(result.baseUrl).toBe(`${api.origin}/api`)
    })

    it("can be made read-only, but only the owner can turn that off", async () => {
      const { id } = await ownerEndpoint()
      const slug = (await getServer(ctx, id)).slug

      const on = await updateEndpointDetails(scope, slug, { readOnly: true })
      expect(on.readOnly).toBe(true)
      expect(on.tools.map((tool) => tool.name)).toEqual(["listPets"])
      expect(on.changes.readOnly).toMatch(/only the owner can turn it off/)

      await expect(
        updateEndpointDetails(scope, slug, { readOnly: false }),
      ).rejects.toThrow(/Only the owner can turn read-only off/)
      expect((await getEndpoint(scope, slug)).readOnly).toBe(true)

      // The owner can.
      await updateEndpoint(ctx, id, {
        name: "Owner pets",
        baseUrl: `${api.origin}/api`,
        specSource: "upload",
        readOnly: false,
        authType: "header",
        authSecretId: (
          await db().mcpServer.findUniqueOrThrow({ where: { id } })
        ).authSecretId,
        authHeaderName: "X-API-Key",
        authValueTemplate: "{{secret}}",
      })
      expect((await getEndpoint(scope, slug)).readOnly).toBe(false)
    })

    it("keeps the credential exactly as the owner set it", async () => {
      const { id, secretId } = await ownerEndpoint()
      const slug = (await getServer(ctx, id)).slug
      await updateEndpointDetails(scope, slug, {
        name: "Renamed",
        description: "New words.",
        spec: spec(api.origin),
      })

      const row = await getServer(ctx, id)
      expect(row).toMatchObject({
        authType: "header",
        authSecretId: secretId,
        authHeaderName: "X-API-Key",
        authValueTemplate: "{{secret}}",
        publicOnly: false,
      })

      const reply = await callServerTool(ctx, row, "listPets", {}, PUBLIC)
      expect(reply.isError).toBeUndefined()
      expect(api.requests.at(-1)!.headers["x-api-key"]).toBe(KEY)
    })
  })

  describe("on an endpoint the owner added at an address they chose", () => {
    it("cannot be moved even without a secret", async () => {
      const { id } = await ownerEndpoint({
        authType: "none",
        authSecretId: null,
      })
      const slug = (await getServer(ctx, id)).slug
      await expect(
        updateEndpointDetails(scope, slug, {
          baseUrl: "http://169.254.169.254/latest",
        }),
      ).rejects.toThrow(/owner set this endpoint's address/)
    })
  })

  describe("on an endpoint whose schema the owner reads from a URL", () => {
    it("takes no schema text, and still takes the rest", async () => {
      const docs = await startTestApi((_, res) => {
        res.setHeader("content-type", "application/json")
        res.end(spec(api.origin))
      })
      try {
        const { id } = await createEndpoint(ctx, {
          name: "Remote",
          specSource: "url",
          specUrl: `${docs.origin}/openapi.json`,
          baseUrl: `${api.origin}/api`,
          readOnly: false,
          authType: "none",
        })
        const slug = (await getServer(ctx, id)).slug

        await expect(
          updateEndpointDetails(scope, slug, { spec: spec(api.origin) }),
        ).rejects.toThrow(
          /reads its schema from .*openapi\.json, which only the owner can change/,
        )

        const result = await updateEndpointDetails(scope, slug, {
          description: "Remote pets.",
        })
        expect(result.description).toBe("Remote pets.")
        expect(result.schema).toMatchObject({
          source: "url",
          url: `${docs.origin}/openapi.json`,
        })
      } finally {
        await docs.close()
      }
    })
  })

  it("does not touch an MCP server", async () => {
    const mcp = await createServer(ctx, {
      name: "Mcp",
      url: "https://mcp.example.com/mcp",
      authType: "none",
    })
    const slug = (await getServer(ctx, mcp.id)).slug
    await expect(
      updateEndpointDetails(scope, slug, { name: "Hijacked" }),
    ).rejects.toThrow(/No API endpoint called/)
    expect((await getServer(ctx, mcp.id)).name).toBe("Mcp")
  })
})

describe("what an assistant registers cannot reach the owner's network", () => {
  it("is refused at the address, until the owner allows private ones", async () => {
    const { endpoint } = await registerEndpoint(scope, {
      name: "Local",
      spec: spec(api.origin),
    })
    const row = await db().mcpServer.findFirstOrThrow({
      where: { slug: endpoint },
    })

    await expect(
      callServerTool(ctx, row, "listPets", {}, PUBLIC),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringMatching(/127\.0\.0\.1.*only reaches public/),
    })
    expect(api.requests).toHaveLength(0)
    // A refused address is the rule working, not an outage.
    expect((await getServer(ctx, row.id)).status).toBe("ok")

    // The owner decides: private addresses allowed for this endpoint.
    await updateEndpoint(ctx, row.id, {
      name: row.name,
      baseUrl: row.url,
      specSource: "upload",
      readOnly: false,
      publicOnly: false,
      authType: "none",
    })
    const allowed = await callServerTool(
      ctx,
      await getServer(ctx, row.id),
      "listPets",
      {},
      PUBLIC,
    )
    expect(allowed.isError).toBeUndefined()
    expect(api.requests).toHaveLength(1)
  })

  it("cannot be unlocked by the assistant, by any update", async () => {
    const { endpoint } = await registerEndpoint(scope, {
      name: "Local",
      spec: spec(api.origin),
    })
    await updateEndpointDetails(scope, endpoint, {
      baseUrl: "https://api.example.com",
      description: "x",
      readOnly: false,
    })
    expect((await getEndpoint(scope, endpoint)).publicOnly).toBe(true)
  })
})
