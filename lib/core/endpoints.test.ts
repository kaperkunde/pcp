import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import { db } from "./db"
import {
  createEndpoint,
  rebuildOutdatedEndpoints,
  syncEndpointTools,
  updateEndpoint,
  type EndpointInput,
} from "./endpoints"
import { buildInstructions, loadGatewayServers } from "./gateway"
import { json, startTestApi, type TestApi } from "./openapi/test-api"
import { NEW_SECRET } from "./constants"
import {
  createSecret,
  deleteSecret,
  listSecrets,
  revealSecret,
} from "./secrets"
import {
  getServer,
  listServers,
  setToolDescription,
  updateServer,
} from "./servers"
import { scratchDatabase } from "./test-db"
import { callServerTool, syncServerTools } from "./upstream"
import { setupVault } from "./vault"
import { PCP_VERSION } from "./version"

let cleanup: () => Promise<void>
let api: TestApi
let ctx: Awaited<ReturnType<typeof setupVault>>

const KEY = "sk-live-0123456789"
const PUBLIC = { publicUrl: "http://localhost:3000" }

function schema(origin: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Pets", description: "Pets for sale." },
    servers: [{ url: `${origin}/api` }],
    security: [{ key: [] }],
    components: {
      securitySchemes: {
        key: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
    },
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          summary: "List pets",
          parameters: [
            { name: "status", in: "query", schema: { type: "string" } },
          ],
        },
        post: {
          operationId: "createPet",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
              },
            },
          },
        },
      },
      "/pets/{petId}": {
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
      },
      "/upload": {
        post: {
          operationId: "upload",
          requestBody: {
            required: true,
            content: { "multipart/form-data": { schema: { type: "object" } } },
          },
        },
      },
    },
    ...extra,
  })
}

function input(overrides: Partial<EndpointInput> = {}): EndpointInput {
  return {
    name: "Petstore",
    specSource: "upload",
    specText: schema(api.origin),
    readOnly: false,
    authType: "none",
    ...overrides,
  }
}

async function withSecret() {
  const { id } = await createSecret(ctx, { name: "Pets key", value: KEY })
  return {
    authType: "header" as const,
    authSecretId: id,
    authHeaderName: "X-API-Key",
    authValueTemplate: "{{secret}}",
  }
}

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  api = await startTestApi((req, res) => {
    if (req.url.startsWith("/api/pets/404"))
      return json(res, 404, { error: "no" })
    if (req.url.startsWith("/api/pets/401"))
      return json(res, 401, { error: "key" })
    json(res, 200, { ok: true, path: req.url })
  })
})

afterEach(async () => {
  await api.close()
  await cleanup()
})

describe("createEndpoint", () => {
  it("stores the endpoint, its tools with call plans, and the schema", async () => {
    const { id, sync } = await createEndpoint(ctx, input())
    const server = await getServer(ctx, id)

    expect(server).toMatchObject({
      kind: "openapi",
      name: "Petstore",
      slug: "petstore",
      url: `${api.origin}/api`,
      specSource: "upload",
      specUrl: null,
      readOnly: false,
      authType: "none",
      status: "ok",
      // From the schema, since the owner wrote none.
      description: "Pets for sale.",
    })
    expect(server.tools.map((tool) => tool.name)).toEqual([
      "createPet",
      "getPet",
      "listPets",
    ])
    expect(JSON.parse(server.tools[1]!.operation!)).toMatchObject({
      method: "GET",
      path: "/pets/{petId}",
    })
    expect(sync).toMatchObject({ status: "ok", toolCount: 3 })
    // What was left out, and the credential the schema asks for.
    expect(sync.message).toMatch(
      /Skipped 1: POST \/upload \(it needs a file upload\)/,
    )
    expect(sync.message).toMatch(
      /need a key in the X-API-Key header; this endpoint sends none/,
    )

    const spec = await db().openApiSpec.findUniqueOrThrow({
      where: { serverId: id },
    })
    expect(spec.text).toBe(schema(api.origin))
    expect(spec.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("shows up as an endpoint in the list, and through a scoped token", async () => {
    const { id } = await createEndpoint(ctx, input())
    const listed = (await listServers(ctx)).find((server) => server.id === id)
    expect(listed).toMatchObject({
      kind: "openapi",
      toolCount: 3,
      connected: true,
    })

    const { token } = await createApiToken(ctx, {
      name: "Only pets",
      allowAllServers: false,
      serverIds: [id],
    })
    const resolved = await resolveApiToken(token)
    const visible = await loadGatewayServers({ ...resolved!, ...PUBLIC })
    expect(buildInstructions(visible)).toContain(
      "petstore: Pets for sale. (3 tools)",
    )
  })

  it("uses the owner's base URL over the schema's", async () => {
    const { id } = await createEndpoint(
      ctx,
      input({ baseUrl: `${api.origin}/other/` }),
    )
    const server = await getServer(ctx, id)
    expect(server.url).toBe(`${api.origin}/other`)
    // The schema's own server is reported, not followed.
    expect(server.statusMessage).toMatch(
      /names .*\/api as its server; PCP sends requests to .*\/other/,
    )
  })

  it("leaves nothing behind when the schema is unusable", async () => {
    for (const specText of ["{ nope", JSON.stringify({ swagger: "2.0" })]) {
      await expect(createEndpoint(ctx, input({ specText }))).rejects.toThrow()
    }
    // A relative server in an upload, with no base URL to go with it.
    await expect(
      createEndpoint(
        ctx,
        input({ specText: schema(api.origin, { servers: [{ url: "/api" }] }) }),
      ),
    ).rejects.toThrow(/Enter the base URL/)
    // Only an upload operation: nothing to offer.
    await expect(
      createEndpoint(
        ctx,
        input({ specText: JSON.stringify({ openapi: "3.0.0", paths: {} }) }),
      ),
    ).rejects.toThrow(/no operations/)

    expect(await db().mcpServer.count()).toBe(0)
    expect(await db().openApiSpec.count()).toBe(0)
  })

  it("offers GET operations only when read-only", async () => {
    const { id } = await createEndpoint(ctx, input({ readOnly: true }))
    expect((await getServer(ctx, id)).tools.map((tool) => tool.name)).toEqual([
      "getPet",
      "listPets",
    ])
  })

  it("sends a secret that exists, or a token from the schema's sign-in", async () => {
    await expect(
      createEndpoint(ctx, input({ authType: "header", authSecretId: "nope" })),
    ).rejects.toThrow(/does not exist/)
    await expect(
      createEndpoint(ctx, input({ authType: "basic" as never })),
    ).rejects.toThrow(/an OAuth token, or no credential/)
    // This schema's only scheme is an API key: there is no sign-in to use.
    await expect(
      createEndpoint(
        ctx,
        input({ authType: "oauth", baseUrl: `${api.origin}/api` }),
      ),
    ).rejects.toThrow(/declares no OAuth sign-in/)
  })

  it("saves a secret typed into the form with it, and none when it is refused", async () => {
    const typed = {
      baseUrl: `${api.origin}/api`,
      authType: "header" as const,
      authSecretId: NEW_SECRET,
      authSecretValue: KEY,
      authHeaderName: "X-API-Key",
      authValueTemplate: "{{secret}}",
    }

    // Refused for the schema after the secret was checked: nothing is kept.
    await expect(
      createEndpoint(ctx, input({ ...typed, specText: "{ nope" })),
    ).rejects.toThrow()
    await expect(
      createEndpoint(ctx, input({ ...typed, authSecretValue: "" })),
    ).rejects.toThrow(/Enter the secret's value/)
    expect(await listSecrets(ctx)).toEqual([])

    const { id } = await createEndpoint(ctx, input(typed))
    const [secret] = await listSecrets(ctx)
    expect(secret).toMatchObject({
      name: "Petstore key",
      description: "Sent to Petstore in the X-API-Key header.",
      usedBy: [{ id, name: "Petstore" }],
    })
    expect(await revealSecret(ctx, secret!.id)).toBe(KEY)

    // Named by the owner; a name that is taken is refused before anything.
    await expect(
      createEndpoint(ctx, input({ ...typed, authSecretName: "Petstore key" })),
    ).rejects.toThrow(/already exists/)
    const named = await createEndpoint(
      ctx,
      input({ ...typed, authSecretName: "Pets live key" }),
    )
    expect((await getServer(ctx, named.id)).authSecretId).toBe(
      (await listSecrets(ctx)).find((each) => each.name === "Pets live key")
        ?.id,
    )
    expect(await db().mcpServer.count()).toBe(2)
  })

  it("switches to a secret typed in on an edit, saved beside the old one", async () => {
    const auth = await withSecret()
    const { id } = await createEndpoint(
      ctx,
      input({ ...auth, baseUrl: `${api.origin}/api` }),
    )

    await updateEndpoint(
      ctx,
      id,
      input({
        ...auth,
        baseUrl: `${api.origin}/api`,
        authSecretId: NEW_SECRET,
        authSecretName: "Pets rotated key",
        authSecretValue: "sk-live-rotated",
      }),
    )

    const rotated = (await listSecrets(ctx)).find(
      (each) => each.name === "Pets rotated key",
    )
    expect(rotated?.usedBy).toEqual([{ id, name: "Petstore" }])
    expect((await getServer(ctx, id)).authSecretId).toBe(rotated?.id)
    expect(await revealSecret(ctx, rotated!.id)).toBe("sk-live-rotated")
    // The old one stays, no longer used by it.
    expect(
      (await listSecrets(ctx)).find((each) => each.id === auth.authSecretId)
        ?.usedBy,
    ).toEqual([])
  })

  it("names the second endpoint with the same name differently", async () => {
    const one = await createEndpoint(ctx, input())
    const two = await createEndpoint(ctx, input())
    expect((await getServer(ctx, one.id)).slug).toBe("petstore")
    expect((await getServer(ctx, two.id)).slug).toBe("petstore-2")
  })
})

describe("downloaded schemas", () => {
  it("are fetched, keep their address, and re-read on refresh", async () => {
    const docs = await startTestApi((req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(schema(api.origin))
    })

    try {
      const { id } = await createEndpoint(ctx, {
        name: "Remote",
        specSource: "url",
        specUrl: `${docs.origin}/openapi.json`,
        readOnly: false,
        authType: "none",
      })
      const server = await getServer(ctx, id)
      expect(server).toMatchObject({
        specSource: "url",
        specUrl: `${docs.origin}/openapi.json`,
      })
      expect(docs.requests).toHaveLength(1)
      // No credential goes to the schema's address.
      expect(docs.requests[0]!.headers["x-api-key"]).toBeUndefined()
      expect(docs.requests[0]!.headers.authorization).toBeUndefined()

      await syncServerTools(ctx, server, PUBLIC)
      expect(docs.requests).toHaveLength(2)
    } finally {
      await docs.close()
    }
  })

  it("refuse to aim a secret at another origin than the schema's own", async () => {
    const docs = await startTestApi((_, res) => {
      res.setHeader("content-type", "application/json")
      res.end(schema(api.origin))
    })

    try {
      const base = {
        name: "Remote",
        specSource: "url" as const,
        specUrl: `${docs.origin}/openapi.json`,
        readOnly: false,
        ...(await withSecret()),
      }
      // The schema is on one origin and names another as its server.
      await expect(createEndpoint(ctx, base)).rejects.toThrow(
        /not where it was downloaded from/,
      )
      expect(await db().mcpServer.count()).toBe(0)

      // Typing the address is the owner's confirmation.
      const { id } = await createEndpoint(ctx, {
        ...base,
        baseUrl: `${api.origin}/api`,
      })
      expect((await getServer(ctx, id)).url).toBe(`${api.origin}/api`)
    } finally {
      await docs.close()
    }
  })

  it("keep the tools and say why when the schema stops reading", async () => {
    let body = schema(api.origin)
    const docs = await startTestApi((_, res) => {
      res.setHeader("content-type", "application/json")
      res.end(body)
    })

    try {
      const { id } = await createEndpoint(ctx, {
        name: "Remote",
        specSource: "url",
        specUrl: `${docs.origin}/openapi.json`,
        readOnly: false,
        authType: "none",
      })
      body = "<html>moved</html>"
      const result = await syncEndpointTools(await getServer(ctx, id))

      expect(result.status).toBe("error")
      const server = await getServer(ctx, id)
      expect(server.status).toBe("error")
      expect(server.tools).toHaveLength(3)
    } finally {
      await docs.close()
    }
  })
})

describe("where a secret may go", () => {
  const attacker = "https://attacker.example.com"

  const withKey = async () => ({
    authType: "header" as const,
    authSecretId: (await createSecret(ctx, { name: "Pets key", value: KEY }))
      .id,
    authHeaderName: "X-API-Key",
    authValueTemplate: "{{secret}}",
  })

  it("is never the address a schema file names, unless the owner types it", async () => {
    const hostile = schema(attacker)
    const auth = await withKey()

    await expect(
      createEndpoint(ctx, input({ ...auth, specText: hostile })),
    ).rejects.toThrow(
      /attacker\.example\.com as its server.*enter the base URL/,
    )
    expect(await db().mcpServer.count()).toBe(0)

    const { id } = await createEndpoint(
      ctx,
      input({ ...auth, specText: hostile, baseUrl: `${api.origin}/api` }),
    )
    expect((await getServer(ctx, id)).url).toBe(`${api.origin}/api`)
  })

  it("is not an address that came from the schema, when attached later", async () => {
    // Added without a secret, from a file whose server was taken as given.
    const { id } = await createEndpoint(
      ctx,
      input({ specText: schema(attacker) }),
    )
    expect((await getServer(ctx, id)).url).toBe(`${attacker}/api`)

    const auth = await withKey()

    // Saving the form with a secret and nothing typed would send it there.
    await expect(
      updateEndpoint(ctx, id, input({ ...auth, specText: null })),
    ).rejects.toThrow(/came from the schema, not from you/)
    expect((await getServer(ctx, id)).authType).toBe("none")

    // Typing an address is the owner's say.
    await updateEndpoint(
      ctx,
      id,
      input({ ...auth, specText: null, baseUrl: `${api.origin}/api` }),
    )
    expect(await getServer(ctx, id)).toMatchObject({
      authType: "header",
      url: `${api.origin}/api`,
    })
  })

  it("may be attached later to an address on the schema's own origin", async () => {
    let origin = ""
    const docs = await startTestApi((_, res) => {
      res.setHeader("content-type", "application/json")
      res.end(schema(origin))
    })
    origin = docs.origin
    const auth = await withKey()

    try {
      const remote = {
        name: "Remote",
        specSource: "url" as const,
        specUrl: `${docs.origin}/openapi.json`,
        readOnly: false,
      }
      const { id } = await createEndpoint(ctx, { ...remote, authType: "none" })
      await updateEndpoint(ctx, id, { ...remote, ...auth })
      expect((await getServer(ctx, id)).authType).toBe("header")

      // An address on another origin has to be typed.
      const elsewhere = {
        ...remote,
        name: "Elsewhere",
        baseUrl: `${api.origin}/api`,
      }
      const other = await createEndpoint(ctx, {
        ...elsewhere,
        authType: "none",
      })
      await updateEndpoint(ctx, other.id, { ...elsewhere, ...auth })
      expect(await getServer(ctx, other.id)).toMatchObject({
        authType: "header",
        url: `${api.origin}/api`,
      })

      // Not typed, and not the schema's origin: refused.
      const quiet = await createEndpoint(ctx, {
        ...remote,
        name: "Quiet",
        baseUrl: `${api.origin}/api`,
        authType: "none",
      })
      await expect(
        updateEndpoint(ctx, quiet.id, { ...remote, name: "Quiet", ...auth }),
      ).rejects.toThrow(/came from the schema, not from you/)
    } finally {
      await docs.close()
    }
  })

  it("stays where it is when an edit leaves the address empty, whatever the schema now says", async () => {
    const auth = await withKey()
    const { id } = await createEndpoint(
      ctx,
      input({ ...auth, baseUrl: `${api.origin}/api` }),
    )

    // A new file that names another server, saved with the field empty.
    await updateEndpoint(
      ctx,
      id,
      input({ ...auth, specText: schema(attacker) }),
    )
    expect((await getServer(ctx, id)).url).toBe(`${api.origin}/api`)

    // Without a secret too: an edit never takes the schema's server.
    const open = await createEndpoint(ctx, input({ name: "Open" }))
    const before = (await getServer(ctx, open.id)).url
    await updateEndpoint(
      ctx,
      open.id,
      input({ name: "Open", specText: schema(attacker) }),
    )
    expect((await getServer(ctx, open.id)).url).toBe(before)
  })
})

describe("refreshing and editing", () => {
  it("keeps the owner's description overrides and drops vanished tools", async () => {
    const { id } = await createEndpoint(ctx, input())
    await setToolDescription(ctx, id, "listPets", "Everything in stock.")

    const fewer = JSON.parse(schema(api.origin))
    delete fewer.paths["/pets"].post
    await updateEndpoint(ctx, id, input({ specText: JSON.stringify(fewer) }))

    const server = await getServer(ctx, id)
    expect(server.tools.map((tool) => tool.name)).toEqual([
      "getPet",
      "listPets",
    ])
    expect(
      server.tools.find((tool) => tool.name === "listPets")!
        .descriptionOverride,
    ).toBe("Everything in stock.")
  })

  it("regenerates an uploaded schema from its kept copy when read-only changes", async () => {
    const { id } = await createEndpoint(ctx, input())
    // No file this time: the stored copy is used.
    await updateEndpoint(ctx, id, input({ specText: null, readOnly: true }))
    expect((await getServer(ctx, id)).tools.map((tool) => tool.name)).toEqual([
      "getPet",
      "listPets",
    ])

    await updateEndpoint(ctx, id, input({ specText: null, readOnly: false }))
    expect((await getServer(ctx, id)).tools).toHaveLength(3)
  })

  it("re-reading an upload keeps its tools, and never moves the base URL", async () => {
    const { id } = await createEndpoint(ctx, input())
    const before = await getServer(ctx, id)
    const result = await syncServerTools(ctx, before, PUBLIC)
    expect(result).toMatchObject({ status: "ok", toolCount: 3 })
    expect((await getServer(ctx, id)).url).toBe(before.url)
  })

  it("cannot be edited as an MCP server", async () => {
    const { id } = await createEndpoint(ctx, input())
    await expect(
      updateServer(ctx, id, {
        name: "x",
        url: "https://x.test",
        authType: "none",
      }),
    ).rejects.toThrow(/API endpoint/)
  })
})

describe("tools an earlier PCP built", () => {
  /** The pet store, with an answer to outline, as an older PCP left it. */
  async function builtByEarlierPcp() {
    const described = JSON.parse(schema(api.origin))
    described.paths["/pets"].get.responses = {
      "200": {
        description: "The pets",
        content: {
          "application/json": {
            schema: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        },
      },
    }
    const { id } = await createEndpoint(
      ctx,
      input({ specText: JSON.stringify(described) }),
    )

    await db().mcpTool.updateMany({
      where: { serverId: id },
      data: { description: "stale", output: null },
    })
    await db().openApiSpec.update({
      where: { serverId: id },
      data: { builtWith: "0.0.1" },
    })
    await db().mcpServer.update({
      where: { id },
      data: {
        status: "ok",
        statusMessage:
          "The schema at its URL has changed since it was approved.",
      },
    })

    return id
  }

  it("are rebuilt from the kept copy once, and nothing else about the endpoint changes", async () => {
    const id = await builtByEarlierPcp()
    const before = await db().openApiSpec.findUniqueOrThrow({
      where: { serverId: id },
    })

    expect(await rebuildOutdatedEndpoints()).toEqual({ rebuilt: 1, failed: [] })

    const server = await getServer(ctx, id)
    const listPets = server.tools.find((tool) => tool.name === "listPets")!
    expect(listPets.description).not.toBe("stale")
    expect(listPets.output).toMatch(/name/)
    expect(server.status).toBe("ok")
    expect(server.statusMessage).toBe(
      "The schema at its URL has changed since it was approved.",
    )

    const after = await db().openApiSpec.findUniqueOrThrow({
      where: { serverId: id },
    })
    expect(after.builtWith).toBe(PCP_VERSION)
    expect(after.fetchedAt).toEqual(before.fetchedAt)

    expect(await rebuildOutdatedEndpoints()).toEqual({ rebuilt: 0, failed: [] })
  })

  it("stay as they are when the kept schema no longer builds, to be tried again", async () => {
    const id = await builtByEarlierPcp()
    await db().openApiSpec.update({
      where: { serverId: id },
      data: {
        patches: JSON.stringify([{ op: "remove", path: "/paths/~1gone" }]),
      },
    })

    const result = await rebuildOutdatedEndpoints()
    expect(result.rebuilt).toBe(0)
    expect(result.failed).toEqual([
      { serverId: id, message: expect.any(String) },
    ])

    const server = await getServer(ctx, id)
    expect(server.tools).toHaveLength(3)
    expect(server.tools.every((tool) => tool.description === "stale")).toBe(
      true,
    )
    expect(
      (await db().openApiSpec.findUniqueOrThrow({ where: { serverId: id } }))
        .builtWith,
    ).toBe("0.0.1")
  })

  it("are marked with the version that built them", async () => {
    const { id } = await createEndpoint(ctx, input())
    expect(
      (await db().openApiSpec.findUniqueOrThrow({ where: { serverId: id } }))
        .builtWith,
    ).toBe(PCP_VERSION)
  })
})

describe("secrets", () => {
  it("are listed as used by the endpoint, which blocks deleting them", async () => {
    const auth = await withSecret()
    await createEndpoint(ctx, input({ ...auth, baseUrl: `${api.origin}/api` }))

    const secret = (await listSecrets(ctx)).find(
      (entry) => entry.id === auth.authSecretId,
    )!
    expect(secret.usedBy.map((server) => server.name)).toEqual(["Petstore"])
    await expect(deleteSecret(ctx, auth.authSecretId)).rejects.toThrow(
      /used by/,
    )
  })
})

describe("calling an endpoint tool", () => {
  async function endpoint(overrides: Partial<EndpointInput> = {}) {
    const auth = await withSecret()
    // A secret goes to an address the owner typed.
    const { id } = await createEndpoint(
      ctx,
      input({ ...auth, baseUrl: `${api.origin}/api`, ...overrides }),
    )
    return getServer(ctx, id)
  }

  const text = (result: Awaited<ReturnType<typeof callServerTool>>) => {
    const block = result.content[0]
    return block?.type === "text" ? block.text : ""
  }

  it("sends the request the plan describes, with the stored secret added", async () => {
    const server = await endpoint()

    const listed = await callServerTool(
      ctx,
      server,
      "listPets",
      { status: "sold" },
      PUBLIC,
    )
    expect(listed.isError).toBeUndefined()
    expect(JSON.parse(text(listed))).toEqual({
      ok: true,
      path: "/api/pets?status=sold",
    })
    expect(api.requests[0]).toMatchObject({
      method: "GET",
      url: "/api/pets?status=sold",
    })
    expect(api.requests[0]!.headers["x-api-key"]).toBe(KEY)

    await callServerTool(
      ctx,
      server,
      "createPet",
      { body: { name: "Rex" } },
      PUBLIC,
    )
    expect(api.requests[1]).toMatchObject({
      method: "POST",
      url: "/api/pets",
      body: '{"name":"Rex"}',
    })
    expect(api.requests[1]!.headers["content-type"]).toBe("application/json")

    await callServerTool(ctx, server, "getPet", { petId: 7 }, PUBLIC)
    expect(api.requests[2]).toMatchObject({ method: "GET", url: "/api/pets/7" })
  })

  it("never puts the secret in what the assistant reads, even if the API repeats it", async () => {
    const server = await endpoint()
    // An API that reflects the key: in a header echo, and in an error.
    const reflecting = await startTestApi((req, res) => {
      if (req.url.includes("/pets/9")) {
        res.statusCode = 403
        res.setHeader("content-type", "text/plain")
        return res.end(`Key ${req.headers["x-api-key"]} may not read pet 9`)
      }
      json(res, 200, { youSent: req.headers["x-api-key"] })
    })
    await db().mcpServer.update({
      where: { id: server.id },
      data: { url: `${reflecting.origin}/api` },
    })
    const moved = await getServer(ctx, server.id)

    try {
      const echoed = await callServerTool(ctx, moved, "listPets", {}, PUBLIC)
      const refused = await callServerTool(
        ctx,
        moved,
        "getPet",
        { petId: 9 },
        PUBLIC,
      )
      expect(reflecting.requests[0]!.headers["x-api-key"]).toBe(KEY)
      expect(JSON.stringify(echoed)).not.toContain(KEY)
      expect(JSON.stringify(refused)).not.toContain(KEY)
      expect(text(echoed)).toContain("[redacted]")
      expect(text(refused)).toBe(
        "HTTP 403 Forbidden\nKey [redacted] may not read pet 9",
      )
    } finally {
      await reflecting.close()
    }
  })

  it("turns an error status into an error result the assistant can read", async () => {
    const server = await endpoint()
    const result = await callServerTool(
      ctx,
      server,
      "getPet",
      { petId: 404 },
      PUBLIC,
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/^HTTP 404/)
    expect((await getServer(ctx, server.id)).status).toBe("ok")
  })

  it("marks the endpoint when the API rejects the credential", async () => {
    const server = await endpoint()
    const result = await callServerTool(
      ctx,
      server,
      "getPet",
      { petId: 401 },
      PUBLIC,
    )
    expect(result.isError).toBe(true)
    const after = await getServer(ctx, server.id)
    expect(after.status).toBe("auth_required")
    expect(after.statusMessage).toMatch(/rejected the credentials/)
  })

  it("will not send a secret a header cannot carry, and never quotes it", async () => {
    // fetch refuses a line break in a header and its error message quotes
    // the value, which would put a multi-line key in the status, the log
    // and what the assistant is told.
    const multiline =
      "-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END KEY-----"
    const { id: secretId } = await createSecret(ctx, {
      name: "Pem key",
      value: multiline,
    })
    const { id } = await createEndpoint(
      ctx,
      input({
        baseUrl: `${api.origin}/api`,
        authType: "header",
        authSecretId: secretId,
        authHeaderName: "X-API-Key",
        authValueTemplate: "{{secret}}",
      }),
    )
    const server = await getServer(ctx, id)

    const failure = await callServerTool(
      ctx,
      server,
      "listPets",
      {},
      PUBLIC,
    ).then(
      () => null,
      (error: Error) => error,
    )

    expect(failure).toMatchObject({ code: "state" })
    expect(failure!.message).toMatch(/cannot carry, so PCP cannot send it/)
    expect(failure!.message).not.toContain("MIIEvQ")
    expect(JSON.stringify(await getServer(ctx, id))).not.toContain("MIIEvQ")
    expect(api.requests).toHaveLength(0)
  })

  it("refuses bad arguments before anything is sent", async () => {
    const server = await endpoint()
    await expect(
      callServerTool(
        ctx,
        server,
        "getPet",
        { petId: "../admin", extra: 1 },
        PUBLIC,
      ),
    ).rejects.toThrow(/Unknown argument "extra"/)
    await expect(
      callServerTool(ctx, server, "getPet", { petId: ".." }, PUBLIC),
    ).rejects.toThrow(/between slashes/)
    await expect(
      callServerTool(ctx, server, "getPet", {}, PUBLIC),
    ).rejects.toThrow(/Missing argument/)
    expect(api.requests).toHaveLength(0)
  })

  it("says so when the tool is not one of the endpoint's", async () => {
    const server = await endpoint()
    await expect(
      callServerTool(ctx, server, "nope", {}, PUBLIC),
    ).rejects.toThrow(/no usable tool called nope/)
  })

  it("refuses a non-GET tool on a read-only endpoint, even from a stale catalogue", async () => {
    const server = await endpoint()
    await db().mcpServer.update({
      where: { id: server.id },
      data: { readOnly: true },
    })
    const readOnly = await getServer(ctx, server.id)

    await expect(
      callServerTool(
        ctx,
        readOnly,
        "createPet",
        { body: { name: "x" } },
        PUBLIC,
      ),
    ).rejects.toThrow(/read-only/)
    expect(api.requests).toHaveLength(0)
  })

  it("marks the endpoint unreachable when nothing answers", async () => {
    const server = await endpoint()
    await api.close()
    await expect(
      callServerTool(ctx, server, "listPets", {}, PUBLIC),
    ).rejects.toThrow(/could not be reached/)
    expect((await getServer(ctx, server.id)).status).toBe("error")
    api = await startTestApi()
  })
})

describe("a schema with many operations", () => {
  const many = (count: number, prefix = "op") =>
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Big" },
      servers: [{ url: "https://api.example.com" }],
      paths: Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `/p${i}`,
          { get: { operationId: `${prefix}${i}` } },
        ]),
      ),
    })

  it("is stored past SQLite's limit on variables, and re-read down again", async () => {
    // 1,200 tools: "name NOT IN (every current name)" is one variable each,
    // and SQLite allows 999.
    const { id, sync } = await createEndpoint(
      ctx,
      input({ name: "Big", specText: many(1200) }),
    )
    expect(sync.toolCount).toBe(1200)
    expect((await getServer(ctx, id)).tools).toHaveLength(1200)

    await updateEndpoint(
      ctx,
      id,
      input({ name: "Big", specText: many(1100, "other") }),
    )
    const tools = (await getServer(ctx, id)).tools
    expect(tools).toHaveLength(1100)
    // None of the old names survive: all 1,200 were removed in chunks.
    expect(tools.every((tool) => tool.name.startsWith("other"))).toBe(true)
  })
})
