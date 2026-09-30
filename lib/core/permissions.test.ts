import { randomUUID } from "node:crypto"

import {
  isInputRequiredResult,
  type CallToolResult,
} from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken, revokeApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import { loadGatewayServers, type GatewayServer } from "./gateway"
import {
  checkPermission,
  decidePermission,
  getPermissionView,
  prunePermissionRequests,
  withPermission,
  type PermissionExecutor,
  type PermissionScope,
} from "./permissions"
import { UI_EXTENSION } from "./permission-rules"
import { createSecret } from "./secrets"
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

    const first = await withPermission(scope, asked, {})
    const id = await onlyRequestId()

    expect(textOf(first)).toContain("Not done yet")
    expect(textOf(first)).toContain(`${PUBLIC_URL}/permissions/${id}`)
    expect((first as CallToolResult).structuredContent).toMatchObject({
      kind: "permission",
    })

    const row = await db().permissionRequest.findUniqueOrThrow({
      where: { id },
    })
    expect(Buffer.from(row.argsCiphertext).toString("latin1")).not.toContain(
      "Ada",
    )

    // The same request again finds the same row; other arguments do not.
    await withPermission(scope, asked, {})
    expect(await db().permissionRequest.count()).toBe(1)
    await withPermission(
      scope,
      call(server, "send_postcard", { to: "Bob", message: "Hi" }),
      {},
    )
    expect(await db().permissionRequest.count()).toBe(2)
  })

  it("shows the owner what the call does, with a warning for destructive tools", async () => {
    const { ctx, scope, server } = await setup()
    await withPermission(
      scope,
      call(server, "send_postcard", { to: "Ada" }),
      {},
    )

    const view = await getPermissionView(ctx, await onlyRequestId(), {
      publicUrl: PUBLIC_URL,
    })

    expect(view?.title).toBe("Allow postcards/send_postcard?")
    expect(view?.lines).toContain("to: Ada")
    expect(view?.lines).toContain('Asked by the token "Claude"')
    expect(view?.warning).toMatch(/destructive/)
  })

  it("runs a form prompt's answer once, bound to the call it was asked for", async () => {
    const { scope, server, tokenId } = await setup()
    const { calls, executor } = stub()
    const form = { clientCapabilities: { elicitation: { form: {} } } }
    const asked = call(server, "add_numbers", { a: 1, b: 2 })

    const prompt = await withPermission(scope, asked, form, { executor })
    expect(isInputRequiredResult(prompt)).toBe(true)
    const requestState = (prompt as { requestState?: string }).requestState!
    expect(requestState).toBe(await onlyRequestId())

    // An answer carried on a different call is refused.
    const mismatched = await withPermission(
      scope,
      call(server, "add_numbers", { a: 9, b: 9 }),
      {
        ...form,
        requestState,
        inputResponses: {
          decision: { action: "accept", content: { decision: "allow_once" } },
        },
      },
      { executor },
    )
    expect((mismatched as CallToolResult).isError).toBe(true)
    expect(calls).toHaveLength(0)

    const ran = await withPermission(
      scope,
      asked,
      {
        ...form,
        requestState,
        inputResponses: {
          decision: { action: "accept", content: { decision: "allow_once" } },
        },
      },
      { executor },
    )
    expect(textOf(ran)).toBe("ran add_numbers")
    expect(calls).toEqual([{ tool: "add_numbers", args: { a: 1, b: 2 } }])
    // Allow once leaves the tool asking.
    expect(await db().apiTokenToolAccess.count({ where: { tokenId } })).toBe(0)

    // Replaying the answer does not run it again.
    const replay = await withPermission(
      scope,
      asked,
      {
        ...form,
        requestState,
        inputResponses: {
          decision: { action: "accept", content: { decision: "allow_once" } },
        },
      },
      { executor },
    )
    expect(textOf(replay)).toContain("allowed it and it ran")
    expect(calls).toHaveLength(1)
  })

  it("treats a declined prompt as no", async () => {
    const { scope, server } = await setup()
    const { calls, executor } = stub()
    const form = { clientCapabilities: { elicitation: { form: {} } } }
    const asked = call(server, "add_numbers", { a: 1, b: 2 })

    const prompt = await withPermission(scope, asked, form, { executor })
    const declined = await withPermission(
      scope,
      asked,
      {
        ...form,
        requestState: (prompt as { requestState?: string }).requestState,
        inputResponses: { decision: { action: "decline" } },
      },
      { executor },
    )

    expect(textOf(declined)).toContain("said no")
    expect(calls).toHaveLength(0)
    expect((await db().permissionRequest.findFirstOrThrow()).status).toBe(
      "declined",
    )
  })
})

describe("the owner's answer", () => {
  it("Always allow runs the call once and allows the tool from then on", async () => {
    const { ctx, scope, server, tokenId } = await setup()
    const { calls, executor } = stub()
    await withPermission(scope, call(server, "add_numbers", { a: 1 }), {})
    const id = await onlyRequestId()

    const ran = await decidePermission(
      ctx,
      id,
      "always",
      { via: "web", publicUrl: PUBLIC_URL },
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
      { via: "app", publicUrl: PUBLIC_URL },
      executor,
    )
    expect(textOf(again)).toContain("allowed it and it ran")
    expect(calls).toHaveLength(1)
  })

  it("runs once however many answers race for it", async () => {
    const { ctx, scope, server } = await setup()
    const { calls, executor } = stub()
    await withPermission(scope, call(server, "add_numbers", { a: 1 }), {})
    const id = await onlyRequestId()
    const answer = () =>
      decidePermission(
        ctx,
        id,
        "allow_once",
        { via: "web", publicUrl: PUBLIC_URL },
        executor,
      )

    await Promise.all([answer(), answer(), answer()])

    expect(calls).toHaveLength(1)
  })

  it("Block declines without running and blocks the tool for the token", async () => {
    const { ctx, scope, server, tokenId } = await setup()
    const { calls, executor } = stub()
    await withPermission(
      scope,
      call(server, "send_postcard", { to: "Ada" }),
      {},
    )
    const id = await onlyRequestId()

    const blocked = await decidePermission(
      ctx,
      id,
      "block",
      { via: "app", publicUrl: PUBLIC_URL, tokenId },
      executor,
    )

    expect(textOf(blocked)).toContain("blocked postcards/send_postcard")
    expect(calls).toHaveLength(0)
    expect(
      await db().apiTokenToolAccess.findFirst({ where: { tokenId } }),
    ).toMatchObject({ toolName: "send_postcard", access: "blocked" })
    expect((await checkPermission(scope, id)).structuredContent).toMatchObject({
      kind: "done",
    })
  })

  it("does not run expired requests, other tokens' requests, or revoked tokens' requests", async () => {
    const { ctx, scope, server, tokenId } = await setup()
    const { calls, executor } = stub()
    const web = { via: "web" as const, publicUrl: PUBLIC_URL }

    await withPermission(scope, call(server, "add_numbers", { a: 1 }), {})
    const expired = await onlyRequestId()
    await db().permissionRequest.update({
      where: { id: expired },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    expect(
      textOf(await decidePermission(ctx, expired, "allow_once", web, executor)),
    ).toContain("expired")

    await withPermission(scope, call(server, "add_numbers", { a: 2 }), {})
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

    const asked = await withPermission(
      scope,
      {
        kind: "register",
        input: {
          name: "Linear",
          url: "https://mcp.linear.example/mcp",
          description: "Issues.",
          authType: "oauth",
          oauthScope: "read",
        },
      },
      // A client that shows panels, calling a tool that shows one.
      {
        clientCapabilities: {
          extensions: { [UI_EXTENSION]: { mimeTypes: ["text/html"] } },
        } as never,
      },
      { toolShowsPanel: true },
    )
    expect(textOf(asked)).toContain("answer in the panel above")
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
      { via: "web", publicUrl: PUBLIC_URL },
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
  })

  it("names the secret a header server would get, and reads its tools once added", async () => {
    const { ctx, scope } = await setup()
    const { executor } = stub()
    const secret = await createSecret(ctx, { name: "weather key", value: "k" })

    await withPermission(
      scope,
      {
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
      },
      {},
    )
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
      { via: "web", publicUrl: PUBLIC_URL },
      executor,
    )
    expect(textOf(added)).toMatch(/Added Weather as "weather" with 3 tools/)
    expect(
      await db().mcpServer.findFirstOrThrow({ where: { name: "Weather" } }),
    ).toMatchObject({ authType: "header", authSecretId: secret.id })
  })
})

describe("pruning", () => {
  it("drops requests a week past their expiry and keeps the rest", async () => {
    const { scope, server } = await setup()
    await withPermission(scope, call(server, "add_numbers", { a: 1 }), {})
    await withPermission(scope, call(server, "add_numbers", { a: 2 }), {})
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
