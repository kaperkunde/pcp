import { randomUUID } from "node:crypto"

import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken, revokeApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import { prepareRegistration } from "./endpoint-admin"
import { loadGatewayServers, type GatewayServer } from "./gateway"
import { listMemories } from "./memories"
import {
  checkPermission,
  decidePermission,
  getPermissionView,
  prunePermissionRequests,
  withPermission,
  type PermissionExecutor,
  type PermissionScope,
  type RegisterArgs,
} from "./permissions"
import { createSecret, revealSecret } from "./secrets"
import { createServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// The owner's permission against a scratch database, with the upstream
// replaced by a stub that counts what actually ran.

let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
})

afterEach(async () => {
  await cleanup()
})

const PASSWORD = "correct horse battery staple"
const PUBLIC_URL = "http://localhost:3000"

function stub() {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const executor: PermissionExecutor = {
    callTool: async (_ctx, _server, tool, args) => {
      calls.push({ tool, args })
      return { content: [{ type: "text", text: `ran ${tool}` }] }
    },
    syncTools: async () => ({ status: "ok", message: "", toolCount: 3 }),
  }

  return { calls, executor }
}

function textOf(result: unknown): string {
  const content = (result as CallToolResult).content ?? []
  return content.map((part) => (part.type === "text" ? part.text : "")).join("")
}

async function setup(options: { allowAllServers?: boolean } = {}): Promise<{
  ctx: VaultContext
  scope: PermissionScope
  tokenId: string
  server: GatewayServer
}> {
  const ctx = await setupVault({ name: "Ada", password: PASSWORD })
  const { id: serverId } = await createServer(ctx, {
    name: "Postcards",
    url: "https://postcards.example.com/mcp",
    authType: "none",
  })

  for (const [name, annotations] of [
    ["add_numbers", { readOnlyHint: true }],
    ["send_postcard", { destructiveHint: true }],
  ] as const) {
    await db().mcpTool.create({
      data: {
        id: randomUUID(),
        serverId,
        name,
        description: `${name} does one thing.`,
        inputSchema: JSON.stringify({ type: "object" }),
        annotations: JSON.stringify(annotations),
      },
    })
  }

  const allowAllServers = options.allowAllServers ?? true
  const { id: tokenId, token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers,
    serverIds: allowAllServers ? [] : [serverId],
  })
  const resolved = (await resolveApiToken(token))!
  const scope = { ...resolved, publicUrl: PUBLIC_URL }
  const [server] = await loadGatewayServers(scope)

  return { ctx, scope, tokenId, server }
}

function call(server: GatewayServer, tool: string, args = {}) {
  return {
    kind: "call" as const,
    server,
    tool: server.tools.find((entry) => entry.name === tool)!,
    args,
  }
}

async function onlyRequestId(): Promise<string> {
  return (await db().permissionRequest.findFirstOrThrow()).id
}

describe("asking the owner", () => {
  it("hands out a link, keeps the arguments encrypted and asks once per request", async () => {
    const { scope, server } = await setup()
    const asked = call(server, "send_postcard", { to: "Ada", message: "Hi" })

    const first = await withPermission(scope, asked)
    const id = await onlyRequestId()

    expect(textOf(first)).toContain("Not done yet")
    expect(textOf(first)).toContain(`${PUBLIC_URL}/permissions/${id}`)
    // Passed on, then waited for: check_permission holds the call.
    expect(textOf(first)).toContain(
      `Then call check_permission with id "${id}": it waits while they answer`,
    )
    expect((first as CallToolResult).structuredContent).toBeUndefined()

    const row = await db().permissionRequest.findUniqueOrThrow({
      where: { id },
    })
    expect(Buffer.from(row.argsCiphertext).toString("latin1")).not.toContain(
      "Ada",
    )

    // The same request again finds the same row; other arguments do not.
    await withPermission(scope, asked)
    expect(await db().permissionRequest.count()).toBe(1)
    await withPermission(
      scope,
      call(server, "send_postcard", { to: "Bob", message: "Hi" }),
    )
    expect(await db().permissionRequest.count()).toBe(2)
  })

  it("shows the owner what the call does, with a warning for destructive tools", async () => {
    const { ctx, scope, server } = await setup()
    await withPermission(scope, call(server, "send_postcard", { to: "Ada" }))

    const view = await getPermissionView(ctx, await onlyRequestId(), {
      publicUrl: PUBLIC_URL,
    })

    expect(view?.title).toBe("Allow postcards/send_postcard?")
    expect(view?.lines).toContain("to: Ada")
    expect(view?.lines).toContain('Asked by the token "Claude"')
    expect(view?.warning).toMatch(/destructive/)
  })
})

describe("check_permission", () => {
  it("waits while the owner answers, then gives the outcome", async () => {
    const { ctx, scope, server } = await setup()
    const { calls, executor } = stub()
    await withPermission(scope, call(server, "add_numbers", { a: 1 }))
    const id = await onlyRequestId()

    const checked = checkPermission(scope, id, { waitMs: 10_000 })
    // The owner answers on PCP's page while the call is held.
    setTimeout(() => {
      void decidePermission(
        ctx,
        id,
        "allow_once",
        { publicUrl: PUBLIC_URL },
        executor,
      )
    }, 200)

    expect(textOf(await checked)).toBe(
      "The owner allowed it and it ran.\nran add_numbers",
    )
    expect(calls).toHaveLength(1)
  })

  it("stops waiting after a while, and when the client goes away", async () => {
    const { scope, server } = await setup()
    await withPermission(scope, call(server, "add_numbers", { a: 1 }))
    const id = await onlyRequestId()

    const late = await checkPermission(scope, id, { waitMs: 50 })
    expect(textOf(late)).toContain("Still waiting for the owner")
    expect(textOf(late)).toContain("call check_permission again")

    const gone = new AbortController()
    const started = Date.now()
    const checked = checkPermission(scope, id, {
      waitMs: 10_000,
      signal: gone.signal,
    })
    setTimeout(() => gone.abort(), 100)
    expect(textOf(await checked)).toContain("Still waiting for the owner")
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it("answers at once for a request that is settled already", async () => {
    const { ctx, scope, server } = await setup()
    const { executor } = stub()
    await withPermission(scope, call(server, "add_numbers", { a: 1 }))
    const id = await onlyRequestId()
    await decidePermission(
      ctx,
      id,
      "decline",
      { publicUrl: PUBLIC_URL },
      executor,
    )

    const started = Date.now()
    expect(textOf(await checkPermission(scope, id))).toContain("said no")
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe("the owner's answer", () => {
  it("Always allow runs the call once and allows the tool from then on", async () => {
    const { ctx, scope, server, tokenId } = await setup()
    const { calls, executor } = stub()
    await withPermission(scope, call(server, "add_numbers", { a: 1 }))
    const id = await onlyRequestId()

    const ran = await decidePermission(
      ctx,
      id,
      "always",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    expect(textOf(ran)).toBe("ran add_numbers")
    expect(calls).toHaveLength(1)
    expect(
      await db().apiTokenToolAccess.findFirst({ where: { tokenId } }),
    ).toMatchObject({ toolName: "add_numbers", access: "allowed" })

    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(view).toMatchObject({
      status: "executed",
      outcome: "ran add_numbers",
    })

    // A second answer reads the outcome instead of running it again.
    const again = await decidePermission(
      ctx,
      id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    expect(textOf(again)).toContain("allowed it and it ran")
    expect(calls).toHaveLength(1)
  })

  it("runs once however many answers race for it", async () => {
    const { ctx, scope, server } = await setup()
    const { calls, executor } = stub()
    await withPermission(scope, call(server, "add_numbers", { a: 1 }))
    const id = await onlyRequestId()
    const answer = () =>
      decidePermission(
        ctx,
        id,
        "allow_once",
        { publicUrl: PUBLIC_URL },
        executor,
      )

    await Promise.all([answer(), answer(), answer()])

    expect(calls).toHaveLength(1)
  })

  it("Block declines without running and blocks the tool for the token", async () => {
    const { ctx, scope, server, tokenId } = await setup()
    const { calls, executor } = stub()
    await withPermission(scope, call(server, "send_postcard", { to: "Ada" }))
    const id = await onlyRequestId()

    const blocked = await decidePermission(
      ctx,
      id,
      "block",
      { publicUrl: PUBLIC_URL, tokenId },
      executor,
    )

    expect(textOf(blocked)).toContain("blocked postcards/send_postcard")
    expect(calls).toHaveLength(0)
    expect(
      await db().apiTokenToolAccess.findFirst({ where: { tokenId } }),
    ).toMatchObject({ toolName: "send_postcard", access: "blocked" })
    expect(textOf(await checkPermission(scope, id))).toContain(
      "blocked postcards/send_postcard",
    )
  })

  it("does not run expired requests, other tokens' requests, or revoked tokens' requests", async () => {
    const { ctx, scope, server, tokenId } = await setup()
    const { calls, executor } = stub()
    const web = { publicUrl: PUBLIC_URL }

    await withPermission(scope, call(server, "add_numbers", { a: 1 }))
    const expired = await onlyRequestId()
    await db().permissionRequest.update({
      where: { id: expired },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    expect(
      textOf(await decidePermission(ctx, expired, "allow_once", web, executor)),
    ).toContain("expired")

    await withPermission(scope, call(server, "add_numbers", { a: 2 }))
    const other = (
      await db().permissionRequest.findFirstOrThrow({
        where: { id: { not: expired } },
      })
    ).id
    const answeredByAnotherToken = await decidePermission(
      ctx,
      other,
      "allow_once",
      { ...web, tokenId: "some-other-token" },
      executor,
    )
    expect(answeredByAnotherToken.isError).toBe(true)

    await revokeApiToken(ctx, tokenId)
    expect(
      textOf(await decidePermission(ctx, other, "allow_once", web, executor)),
    ).toContain("no longer valid")

    expect(calls).toHaveLength(0)
  })
})

describe("adding a server", () => {
  it("adds an OAuth server only after the owner agrees, then asks them to connect it", async () => {
    const { ctx, scope, tokenId } = await setup({ allowAllServers: false })
    const { executor } = stub()

    const asked = await withPermission(scope, {
      kind: "register",
      input: {
        name: "Linear",
        url: "https://mcp.linear.example/mcp",
        description: "Issues.",
        authType: "oauth",
        oauthScope: "read",
      },
    })
    expect(textOf(asked)).toMatch(/Give the owner this link.*\/permissions\//)
    expect(await db().mcpServer.count()).toBe(1)

    const id = await onlyRequestId()
    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(view?.title).toBe("Add the server Linear?")
    expect(view?.decisions.map((decision) => decision.value)).toEqual([
      "allow_once",
      "decline",
    ])

    // "Always" means nothing for a new server; it is added once.
    const added = await decidePermission(
      ctx,
      id,
      "always",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    const linear = await db().mcpServer.findFirstOrThrow({
      where: { name: "Linear" },
    })

    expect(added.structuredContent).toMatchObject({
      kind: "connect",
      connect: {
        serverId: linear.id,
        startUrl: `${PUBLIC_URL}/api/servers/${linear.id}/oauth/start`,
      },
    })
    expect(linear).toMatchObject({ authType: "oauth", oauthScope: "read" })
    // The scoped token reaches the server it asked for.
    expect(
      await db().apiTokenServer.count({
        where: { tokenId, serverId: linear.id },
      }),
    ).toBe(1)
    const after = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(after?.connect?.serverId).toBe(linear.id)
    // The server was added, which is what the owner agreed to.
    expect(after?.status).toBe("executed")

    // A panel the host rebuilt asks where things are: Connect until the
    // owner has signed in, then done.
    const waiting = await checkPermission(scope, id)
    expect(waiting.structuredContent).toMatchObject({
      kind: "connect",
      connect: { serverId: linear.id, slug: linear.slug },
    })
    expect(textOf(waiting)).toContain("Linear needs connecting")

    await db().mcpServer.update({
      where: { id: linear.id },
      data: { oauthConnectedAt: new Date() },
    })
    const done = await checkPermission(scope, id)
    expect(done.structuredContent).toMatchObject({
      kind: "done",
      server: { id: linear.id, slug: linear.slug, connected: true },
    })
    expect(textOf(done)).toContain("It is connected now")
  })

  it("names the secret a header server would get, and reads its tools once added", async () => {
    const { ctx, scope } = await setup()
    const { executor } = stub()
    const secret = await createSecret(ctx, { name: "weather key", value: "k" })

    await withPermission(scope, {
      kind: "register",
      input: {
        name: "Weather",
        url: "https://weather.example.com/mcp",
        authType: "header",
        authSecretId: secret.id,
        authHeaderName: "Authorization",
        authValueTemplate: "Bearer {{secret}}",
        secretName: "weather key",
      },
    })
    const id = await onlyRequestId()
    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(view?.lines).toContain(
      'Authentication: sends your secret "weather key" in the Authorization header',
    )
    expect(view?.warning).toMatch(/weather key/)

    const added = await decidePermission(
      ctx,
      id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    expect(textOf(added)).toMatch(/Added Weather as "weather" with 3 tools/)
    expect(
      await db().mcpServer.findFirstOrThrow({ where: { name: "Weather" } }),
    ).toMatchObject({ authType: "header", authSecretId: secret.id })
  })
})

const PETS_SPEC = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Pets" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/pets": {
      get: { operationId: "listPets", summary: "List pets" },
      post: { operationId: "createPet" },
    },
    "/pets/{petId}": {
      delete: {
        operationId: "deletePet",
        parameters: [
          {
            name: "petId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
      },
    },
  },
})

/** What register_server builds from OpenAPI text before it asks the owner. */
async function apiRegistration(
  ctx: VaultContext,
  overrides: {
    secret?: { id: string; name: string }
    baseUrl?: string
    readOnly?: boolean
    patches?: unknown
  } = {},
): Promise<RegisterArgs> {
  const prepared = await prepareRegistration(ctx, {
    name: "Pets",
    spec: PETS_SPEC,
    baseUrl: overrides.baseUrl,
    readOnly: overrides.readOnly,
    authSecretId: overrides.secret?.id,
    patches: overrides.patches,
  })

  return {
    name: prepared.name,
    description: prepared.description,
    url: prepared.url,
    authType: overrides.secret ? "header" : "none",
    authHeaderName: overrides.secret ? "X-API-Key" : null,
    authValueTemplate: overrides.secret ? "{{secret}}" : null,
    authSecretId: overrides.secret?.id ?? null,
    secretName: overrides.secret?.name ?? null,
    oauthScope: null,
    endpoint: prepared.registration,
  }
}

describe("adding an API from OpenAPI text", () => {
  it("tells the owner where the schema comes from and how many edits it has", async () => {
    const { ctx, scope } = await setup()
    const fromText = await apiRegistration(ctx)
    const edited = await apiRegistration(ctx, {
      patches: [{ op: "remove", path: "/paths/~1pets/post" }],
    })
    // As a schema downloaded from a URL is held on the request.
    edited.endpoint!.specUrl = "https://raw.example.com/pets/openapi.yaml"

    for (const input of [fromText, edited]) {
      await withPermission(scope, { kind: "register", input })
    }
    const views = await Promise.all(
      (await db().permissionRequest.findMany()).map((row) =>
        getPermissionView(ctx, row.id, { publicUrl: PUBLIC_URL }),
      ),
    )
    const [byUrl, asText] = [
      views.find((view) => view?.lines.some((line) => /^Edits/.test(line))),
      views.find((view) => !view?.lines.some((line) => /^Edits/.test(line))),
    ]

    expect(asText?.lines).toContain("Schema: supplied as text")
    expect(byUrl?.lines).toEqual(
      expect.arrayContaining([
        "Schema: downloaded from https://raw.example.com/pets/openapi.yaml; a later change to it waits for you",
        "Edits: 1 change to the schema, applied before the tools are made",
        "Tools: 2 from the OpenAPI schema it supplied (GET 1, DELETE 1)",
      ]),
    )
  })

  it("adds nothing until the owner agrees, shows what it would do, then adds it on, public-only, and in reach of the token", async () => {
    const { ctx, scope, tokenId } = await setup({ allowAllServers: false })
    const { executor } = stub()

    const asked = await withPermission(scope, {
      kind: "register",
      input: await apiRegistration(ctx),
    })
    expect(textOf(asked)).toContain("needs the owner's permission")
    // Only the server the token started with.
    expect(await db().mcpServer.count()).toBe(1)

    const id = await onlyRequestId()
    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(view?.title).toBe("Add the API endpoint Pets?")
    expect(view?.lines).toEqual(
      expect.arrayContaining([
        "Address: https://api.example.com/v1",
        "Tools: 3 from the OpenAPI schema it supplied (GET 1, POST 1, DELETE 1)",
        "Operations: GET /pets, POST /pets, DELETE /pets/{petId}",
        "Authentication: none",
      ]),
    )
    expect(view?.lines.join("\n")).toMatch(/Can change things/)
    expect(view?.warning).toBeNull()
    expect(view?.decisions.map((decision) => decision.value)).toEqual([
      "allow_once",
      "decline",
    ])

    const added = await decidePermission(
      ctx,
      id,
      "always",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    expect(textOf(added)).toMatch(/Added Pets as "pets" with 3 tools/)

    const pets = await db().mcpServer.findFirstOrThrow({
      where: { name: "Pets" },
      include: { tools: true },
    })
    expect(pets).toMatchObject({
      kind: "openapi",
      url: "https://api.example.com/v1",
      enabled: true,
      publicOnly: true,
      readOnly: false,
      authType: "none",
    })
    expect(pets.tools.map((tool) => tool.name).sort()).toEqual([
      "createPet",
      "deletePet",
      "listPets",
    ])
    expect(
      await db().apiTokenServer.count({
        where: { tokenId, serverId: pets.id },
      }),
    ).toBe(1)
    expect(
      (await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL }))?.status,
    ).toBe("executed")
  })

  it("adds nothing when the owner says no", async () => {
    const { ctx, scope } = await setup()
    const { executor } = stub()

    await withPermission(scope, {
      kind: "register",
      input: await apiRegistration(ctx),
    })
    const declined = await decidePermission(
      ctx,
      await onlyRequestId(),
      "decline",
      { publicUrl: PUBLIC_URL },
      executor,
    )

    expect(textOf(declined)).toMatch(/said no/)
    expect(await db().mcpServer.count()).toBe(1)
  })

  it("names the secret and the address it goes to, and read-only in what it offers", async () => {
    const { ctx, scope } = await setup()
    const { executor } = stub()
    const secret = await createSecret(ctx, { name: "pets key", value: "k-123" })

    await withPermission(scope, {
      kind: "register",
      input: await apiRegistration(ctx, {
        secret: { id: secret.id, name: "pets key" },
        baseUrl: "https://api.example.com/v1",
        readOnly: true,
      }),
    })
    const id = await onlyRequestId()
    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })

    expect(view?.lines).toEqual(
      expect.arrayContaining([
        "Address: https://api.example.com/v1",
        "Tools: 1 from the OpenAPI schema it supplied (GET 1)",
        "Read-only: only GET operations become tools",
        'Authentication: sends your secret "pets key" in the X-API-Key header',
      ]),
    )
    expect(view?.warning).toMatch(/"pets key" to this address/)

    await decidePermission(
      ctx,
      id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    expect(
      await db().mcpServer.findFirstOrThrow({ where: { name: "Pets" } }),
    ).toMatchObject({
      authType: "header",
      authSecretId: secret.id,
      readOnly: true,
      publicOnly: true,
    })
  })

  it("is asked once for the same request, and its text is kept encrypted", async () => {
    const { ctx, scope } = await setup()
    const input = await apiRegistration(ctx)

    await withPermission(scope, { kind: "register", input })
    await withPermission(scope, { kind: "register", input })

    expect(await db().permissionRequest.count()).toBe(1)
    const row = await db().permissionRequest.findFirstOrThrow()
    expect(Buffer.from(row.argsCiphertext).toString("utf8")).not.toContain(
      "listPets",
    )
  })
})

describe("a new secret the owner types in", () => {
  /** register_server naming a secret PCP does not hold yet. */
  async function withNewSecret(ctx: VaultContext): Promise<RegisterArgs> {
    const prepared = await prepareRegistration(ctx, {
      name: "Pets",
      spec: PETS_SPEC,
      baseUrl: "https://api.example.com/v1",
      newSecretName: "Pets API key",
    })

    return {
      name: prepared.name,
      description: prepared.description,
      url: prepared.url,
      authType: "header",
      authHeaderName: "X-API-Key",
      authValueTemplate: "{{secret}}",
      authSecretId: null,
      secretName: "Pets API key",
      newSecretName: "Pets API key",
      oauthScope: null,
      endpoint: prepared.registration,
    }
  }

  it("is asked for on PCP's page, where the owner types the value in", async () => {
    const { ctx, scope } = await setup()

    const asked = await withPermission(scope, {
      kind: "register",
      input: await withNewSecret(ctx),
    })
    expect(textOf(asked)).toMatch(/Give the owner this link.*\/permissions\//)
    expect(textOf(asked)).toMatch(
      /type the value of the secret "Pets API key" in there; do not ask them for it here/,
    )

    const id = await onlyRequestId()
    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(view?.secretToEnter).toEqual({ name: "Pets API key", exists: false })
    expect(view?.lines).toContain(
      'Authentication: sends a new secret, saved as "Pets API key", in the X-API-Key header; you enter its value here when you agree',
    )
    expect(view?.warning).toMatch(/"Pets API key" to this address/)
  })

  it("cannot be agreed to without the value; declining needs none", async () => {
    const { ctx, scope } = await setup()
    const { executor } = stub()
    const input = await withNewSecret(ctx)
    const web = { publicUrl: PUBLIC_URL }

    await withPermission(scope, { kind: "register", input })
    const id = await onlyRequestId()

    const empty = await decidePermission(ctx, id, "allow_once", web, executor)
    expect(empty.isError).toBe(true)
    expect(textOf(empty)).toMatch(/Enter the secret's value/)

    // Still waiting, and nothing was made.
    expect(
      (await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL }))?.status,
    ).toBe("pending")
    expect(await db().secret.count()).toBe(0)
    expect(await db().mcpServer.count()).toBe(1)

    await withPermission(scope, {
      kind: "register",
      input: { ...input, name: "Other pets" },
    })
    const other = (
      await db().permissionRequest.findFirstOrThrow({
        where: { id: { not: id } },
      })
    ).id
    const declined = await decidePermission(
      ctx,
      other,
      "decline",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    expect(textOf(declined)).toMatch(/said no/)
  })

  it("saves the value the owner typed under the proposed name and sends it, without telling the assistant", async () => {
    const { ctx, scope } = await setup()
    const { executor } = stub()

    await withPermission(scope, {
      kind: "register",
      input: await withNewSecret(ctx),
    })
    const id = await onlyRequestId()
    const added = await decidePermission(
      ctx,
      id,
      "allow_once",
      { publicUrl: PUBLIC_URL, secretValue: "k-123" },
      executor,
    )

    expect(textOf(added)).toMatch(/Added Pets as "pets" with 3 tools/)
    expect(textOf(added)).toMatch(/saved in PCP as "Pets API key"/)
    expect(textOf(added)).not.toContain("k-123")

    const secret = await db().secret.findFirstOrThrow({
      where: { name: "Pets API key" },
    })
    expect(await revealSecret(ctx, secret.id)).toBe("k-123")
    expect(secret.description).toBe("Sent to Pets in the X-API-Key header.")
    expect(
      await db().mcpServer.findFirstOrThrow({ where: { name: "Pets" } }),
    ).toMatchObject({
      authType: "header",
      authSecretId: secret.id,
      authHeaderName: "X-API-Key",
      url: "https://api.example.com/v1",
      publicOnly: true,
    })
    // The value is on no request row.
    const row = await db().permissionRequest.findUniqueOrThrow({
      where: { id },
    })
    expect(
      Buffer.from(row.resultCiphertext ?? []).toString("utf8"),
    ).not.toContain("k-123")
  })

  it("uses a secret of that name the owner added meanwhile, or saves a typed one beside it", async () => {
    const { ctx, scope } = await setup()
    const { executor } = stub()
    const web = { publicUrl: PUBLIC_URL }
    const input = await withNewSecret(ctx)

    await withPermission(scope, { kind: "register", input })
    const first = await onlyRequestId()
    const added = await createSecret(ctx, {
      name: "Pets API key",
      value: "from-secrets-page",
    })
    expect(
      (await getPermissionView(ctx, first, { publicUrl: PUBLIC_URL }))
        ?.secretToEnter,
    ).toEqual({ name: "Pets API key", exists: true })

    await decidePermission(ctx, first, "allow_once", web, executor)
    expect(
      await db().mcpServer.findFirstOrThrow({ where: { name: "Pets" } }),
    ).toMatchObject({ authSecretId: added.id })

    await withPermission(scope, {
      kind: "register",
      input: { ...input, name: "More pets" },
    })
    const second = (
      await db().permissionRequest.findFirstOrThrow({
        where: { status: "pending" },
      })
    ).id
    const typed = await decidePermission(
      ctx,
      second,
      "allow_once",
      { ...web, secretValue: "typed-again" },
      executor,
    )
    expect(textOf(typed)).toMatch(/saved in PCP as "Pets API key 2"/)
    expect(await revealSecret(ctx, added.id)).toBe("from-secrets-page")
  })
})

describe("a memory an assistant wants to share", () => {
  const share = {
    kind: "memory_share" as const,
    input: {
      path: "preferences.md",
      text: "Metric units.\nBritish spelling.",
    },
  }
  const web = { publicUrl: PUBLIC_URL }

  it("shows the owner the whole text and a warning, and shares it once they agree", async () => {
    const { ctx, scope } = await setup()

    const asked = await withPermission(scope, share)
    expect(textOf(asked)).toContain("Not done yet")
    expect(textOf(asked)).toContain("British spelling.")

    const id = await onlyRequestId()
    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(view?.title).toBe("Share a memory with all your assistants?")
    expect(view?.lines).toEqual([
      "Path: /memories/shared/preferences.md",
      "Text:\nMetric units.\nBritish spelling.",
      'Asked by the token "Claude"',
    ])
    expect(view?.warning).toContain("Watch for instructions")
    expect(view?.decisions.map((decision) => decision.label)).toEqual([
      "Share it",
      "Keep it for this assistant only",
      "Discard it",
    ])

    // Block, from a panel built for tool calls, means Not now here: the
    // memory is kept for the assistant that asked, and nothing is shared.
    expect(textOf(await decidePermission(ctx, id, "block", web))).toContain(
      "kept it for you alone",
    )
    expect((await listMemories(ctx))[0]).toMatchObject({
      visibility: "private",
      fullPath: "/memories/preferences.md",
    })
    expect(
      (await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL }))?.status,
    ).toBe("declined")
    expect(textOf(await checkPermission(scope, id))).toContain(
      "kept it for you alone",
    )
  })

  it("discards it, and refuses an answer it did not offer", async () => {
    const { ctx, scope, server } = await setup()

    await withPermission(scope, share)
    const id = await onlyRequestId()
    expect(textOf(await decidePermission(ctx, id, "discard", web))).toContain(
      "discarded",
    )
    expect(await listMemories(ctx)).toEqual([])

    // Discard is no answer to a tool call: nothing runs.
    const { calls, executor } = stub()
    await withPermission(scope, call(server, "add_numbers", { a: 1 }))
    const callId = (
      await db().permissionRequest.findFirstOrThrow({ where: { kind: "call" } })
    ).id
    const refused = await decidePermission(
      ctx,
      callId,
      "discard",
      web,
      executor,
    )
    expect(refused.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe("pruning", () => {
  it("drops requests a week past their expiry and keeps the rest", async () => {
    const { scope, server } = await setup()
    await withPermission(scope, call(server, "add_numbers", { a: 1 }))
    await withPermission(scope, call(server, "add_numbers", { a: 2 }))
    const [old, recent] = await db().permissionRequest.findMany({
      orderBy: { createdAt: "asc" },
    })
    const day = 24 * 60 * 60 * 1000

    await db().permissionRequest.update({
      where: { id: old.id },
      data: { expiresAt: new Date(Date.now() - 8 * day) },
    })
    await db().permissionRequest.update({
      where: { id: recent.id },
      data: { expiresAt: new Date(Date.now() - day) },
    })

    expect(await prunePermissionRequests()).toBe(1)
    expect(
      (await db().permissionRequest.findMany()).map((row) => row.id),
    ).toEqual([recent.id])
  })
})
