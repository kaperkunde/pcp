import { randomUUID } from "node:crypto"

import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { listTokenAllowances } from "./allowances"
import { createApiToken, resolveApiToken, revokeApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import { prepareRegistration, updateEndpointDetails } from "./endpoint-admin"
import { createEndpoint } from "./endpoints"
import {
  loadGatewayServers,
  type GatewayScope,
  type GatewayServer,
} from "./gateway"
import { listMemories } from "./memories"
import {
  checkPermission,
  decidePermission,
  getPermissionView,
  listPendingRequests,
  prunePermissionRequests,
  runCall,
  withPermission,
  type PermissionExecutor,
  type RegisterArgs,
} from "./permissions"
import { createFakeJmap, type FakeJmap } from "./mail/fake-jmap"
import { startTestApi, type TestApi } from "./openapi/test-api"
import { createSecret, revealSecret } from "./secrets"
import { createServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { OwnerNeeded } from "./browser/types"
import { keepBytes } from "./tool-results"
import { callServerTool, syncServerTools } from "./upstream"
import { copyTokenAccess, writeToolAccess } from "./tool-access"
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
  scope: GatewayScope
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
    // The link comes last, with nothing after it: some apps hide the text
    // written before a tool call, so check_permission waits for the owner.
    expect(textOf(first)).toContain("End your reply with this link")
    expect(textOf(first).split("\n").at(-1)).toBe(
      `${PUBLIC_URL}/permissions/${id}`,
    )
    expect(textOf(first)).toContain(
      `When they say they have answered, call check_permission with id "${id}"`,
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

  it("keeps only the fields the assistant asked for once the owner allows the call", async () => {
    const { ctx, scope, server } = await setup()
    const executor: PermissionExecutor = {
      ...stub().executor,
      callTool: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ data: [{ id: 1, terms: "long" }] }),
          },
        ],
      }),
    }
    const asked = {
      ...call(server, "add_numbers", { a: 1 }),
      fields: ["data.id"],
    }

    await withPermission(scope, asked)
    // Other fields are another request.
    await withPermission(scope, { ...asked, fields: ["data.terms"] })
    expect(await db().permissionRequest.count()).toBe(2)

    const row = await db().permissionRequest.findFirstOrThrow({
      where: { fields: JSON.stringify(["data.id"]) },
    })
    const result = await decidePermission(
      ctx,
      row.id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      executor,
    )

    expect(textOf(result)).toBe('{"data":[{"id":1}]}')
  })

  it("keeps what the assistant asked to once the owner allows the call", async () => {
    const { ctx, scope, server, tokenId } = await setup()
    const executor: PermissionExecutor = {
      ...stub().executor,
      callTool: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              report: `${"x".repeat(300)} THE END`,
              n: 1,
            }),
          },
        ],
      }),
    }
    const asked = {
      ...call(server, "add_numbers", { a: 1 }),
      keep: ["report"],
    }

    await withPermission(scope, asked)
    // Keeping something else is another request.
    await withPermission(scope, { ...asked, keep: ["n"] })
    expect(await db().permissionRequest.count()).toBe(2)

    const row = await db().permissionRequest.findFirstOrThrow({
      where: { keep: JSON.stringify(["report"]) },
    })
    const result = await decidePermission(
      ctx,
      row.id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    const kept = await db().toolResult.findFirstOrThrow()

    expect(kept).toMatchObject({ tokenId, toolName: "add_numbers" })
    expect(textOf(result)).toContain(`report → ${kept.id} (text/plain`)
    expect(textOf(result)).toContain(`"report":{"$result":"${kept.id}"`)
    expect(textOf(result)).not.toContain("THE END")
  })

  it("decodes what the assistant asked to once the owner allows the call", async () => {
    const { ctx, scope, server } = await setup()
    const executor: PermissionExecutor = {
      ...stub().executor,
      callTool: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              body: { data: Buffer.from("Hello").toString("base64url") },
            }),
          },
        ],
      }),
    }
    const asked = {
      ...call(server, "add_numbers", { a: 1 }),
      decode: ["body.data"],
    }

    await withPermission(scope, asked)
    // Decoding elsewhere is another request.
    await withPermission(scope, { ...asked, decode: ["data"] })
    expect(await db().permissionRequest.count()).toBe(2)

    const row = await db().permissionRequest.findFirstOrThrow({
      where: { decode: JSON.stringify(["body.data"]) },
    })
    const result = await decidePermission(
      ctx,
      row.id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      executor,
    )

    expect(textOf(result)).toBe(
      'Decoded from base64: body.data (1).{"body":{"data":"Hello"}}',
    )
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

describe("kept results in a call", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  async function keepFile(
    ctx: VaultContext,
    serverId: string,
    tokenId: string,
  ) {
    return (
      await keepBytes(ctx, {
        tokenId,
        serverId,
        toolName: "get_attachment",
        bytes: PNG,
        mediaType: "image/png",
        name: "dot.png",
      })
    ).id
  }

  it("shows the owner what each handle is, and warns when one is gone", async () => {
    const { ctx, scope, server, tokenId } = await setup()
    const id = await keepFile(ctx, server.id, tokenId)
    await withPermission(
      scope,
      call(server, "send_postcard", {
        attachments: [{ $result: id }, { $result: "gone" }],
      }),
    )

    const view = await getPermissionView(ctx, await onlyRequestId(), {
      publicUrl: PUBLIC_URL,
    })

    expect(view?.lines).toContain(
      `attachments: [{"$result":"${id}"},{"$result":"gone"}]`,
    )
    expect(
      view?.lines.find((line) => line.startsWith(`Kept result ${id}:`)),
    ).toMatch(
      /^Kept result [^:]+: dot\.png, image\/png, 8 bytes, from postcards\/get_attachment, readable until \d{4}-/,
    )
    expect(view?.lines).toContain(
      "Kept result gone: no longer available for this token; the call will fail",
    )
  })

  it("hands the upstream a way to open the token's own results, and no other's", async () => {
    const { ctx, server, tokenId } = await setup()
    const id = await keepFile(ctx, server.id, tokenId)
    const seen: Array<{ own: unknown; other: unknown }> = []
    const executor: PermissionExecutor = {
      callTool: async (_ctx, _server, _tool, _args, options) => {
        const opened = await options.open?.(id)
        seen.push({ own: opened?.bytes().equals(PNG), other: null })

        return { content: [{ type: "text", text: "ok" }] }
      },
      syncTools: async () => ({ status: "ok", message: "", toolCount: 3 }),
    }

    const row = await db().mcpServer.findFirstOrThrow()
    await runCall(
      ctx,
      row,
      "add_numbers",
      {},
      {
        publicUrl: PUBLIC_URL,
        tokenId,
        executor,
      },
    )

    const { id: other } = await createApiToken(ctx, {
      name: "Other",
      allowAllServers: true,
      serverIds: [],
    })
    const foreign: PermissionExecutor = {
      callTool: async (_ctx, _server, _tool, _args, options) => {
        seen.push({ own: null, other: await options.open?.(id) })

        return { content: [{ type: "text", text: "ok" }] }
      },
      syncTools: executor.syncTools,
    }
    await runCall(
      ctx,
      row,
      "add_numbers",
      {},
      {
        publicUrl: PUBLIC_URL,
        tokenId: other,
        executor: foreign,
      },
    )

    expect(seen).toEqual([
      { own: true, other: null },
      { own: null, other: null },
    ])
  })
})

describe("a site the browser asks about", () => {
  async function allowedNavigate(args: Record<string, unknown>) {
    const { ctx, server, tokenId } = await setup()
    const opened: string[] = []
    const executor: PermissionExecutor = {
      ...stub().executor,
      callTool: async () => {
        throw new OwnerNeeded({
          kind: "browse",
          input: {
            serverId: server.id,
            tabId: null,
            url: "https://hidden.example/",
            toolName: "navigate",
          },
        })
      },
      browse: async (_scope, { url }) => {
        opened.push(url)
        return { content: [{ type: "text", text: "opened" }] }
      },
    }
    const row = await db().mcpServer.findFirstOrThrow()

    await runCall(ctx, row, "navigate", args, {
      publicUrl: PUBLIC_URL,
      tokenId,
      ownerAllowed: true,
      executor,
    }).catch(() => null)

    return opened
  }

  it("opens the address the owner saw in the call they allowed", async () => {
    expect(await allowedNavigate({ url: "https://hidden.example/" })).toEqual([
      "https://hidden.example/",
    ])
  })

  it("asks again when the address was a kept result the owner did not see", async () => {
    expect(await allowedNavigate({ url: { $result: "r1" } })).toEqual([])
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
    expect(textOf(late)).toContain(
      "call check_permission again when they say they have answered",
    )
    expect(textOf(late).split("\n").at(-1)).toBe(
      `${PUBLIC_URL}/permissions/${id}`,
    )

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

describe("what is waiting for the owner", () => {
  it("counts open requests, newest first, and leaves out answered ones and dead tokens", async () => {
    const { ctx, scope, server } = await setup()
    const { executor } = stub()

    expect(await listPendingRequests(ctx, PUBLIC_URL)).toEqual({
      total: 0,
      requests: [],
    })

    await withPermission(scope, call(server, "add_numbers", { a: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await withPermission(scope, call(server, "send_postcard", { to: "Ada" }))

    const both = await listPendingRequests(ctx, PUBLIC_URL)
    expect(both.total).toBe(2)
    expect(both.requests.map((request) => request.title)).toEqual([
      "Allow postcards/send_postcard?",
      "Allow postcards/add_numbers?",
    ])
    expect(both.requests[0]!.tokenName).toBe("Claude")
    // The arguments stay on the request's own page.
    expect(JSON.stringify(both)).not.toContain("Ada")

    const limited = await listPendingRequests(ctx, PUBLIC_URL, { limit: 1 })
    expect(limited.total).toBe(2)
    expect(limited.requests).toHaveLength(1)

    await decidePermission(
      ctx,
      both.requests[1]!.id,
      "decline",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    expect((await listPendingRequests(ctx, PUBLIC_URL)).total).toBe(1)

    // A revoked token's request can no longer be answered.
    await revokeApiToken(ctx, scope.tokenId)
    expect((await listPendingRequests(ctx, PUBLIC_URL)).total).toBe(0)
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

  it("Allow for runs the call once and lets the tool run without asking until the time is up", async () => {
    const { ctx, scope, server, tokenId } = await setup()
    const { calls, executor } = stub()
    await withPermission(scope, call(server, "add_numbers", { a: 1 }))
    const id = await onlyRequestId()
    const levelOf = async (at: Date) =>
      (await loadGatewayServers(scope, at))[0]!.tools.find(
        (tool) => tool.name === "add_numbers",
      )!.access

    const ran = await decidePermission(
      ctx,
      id,
      "allow_for",
      { publicUrl: PUBLIC_URL, minutes: 60 },
      executor,
    )
    expect(textOf(ran)).toBe("ran add_numbers")
    expect(calls).toHaveLength(1)
    // No level is written: the allowance sits beside them.
    expect(
      await db().apiTokenToolAccess.findFirst({ where: { tokenId } }),
    ).toBeNull()
    const [allowance] = await listTokenAllowances(ctx, tokenId)
    expect(allowance).toMatchObject({
      kind: "tool",
      serverName: "Postcards",
      toolName: "add_numbers",
    })
    expect(allowance!.until.getTime() - Date.now()).toBeGreaterThan(59 * 60_000)

    expect(await levelOf(new Date())).toBe("allowed")
    // Only that tool.
    expect(
      (await loadGatewayServers(scope))[0]!.tools.find(
        (tool) => tool.name === "send_postcard",
      )!.access,
    ).toBe("ask")
    expect(await levelOf(new Date(Date.now() + 61 * 60_000))).toBe("ask")
  })

  it("Allow for lifts only ask: a block stays, and a token's own ask returns when it ends", async () => {
    const { ctx, scope, server, tokenId } = await setup()
    const { executor } = stub()
    // All tokens may send postcards; this token's own line asks first.
    await db().vaultToolAccess.create({
      data: {
        vaultId: ctx.vaultId,
        serverId: server.id,
        toolName: "send_postcard",
        access: "allowed",
      },
    })
    await writeToolAccess(tokenId, server.id, "send_postcard", "ask")
    await withPermission(scope, call(server, "send_postcard", { to: "Ada" }))
    await decidePermission(
      ctx,
      await onlyRequestId(),
      "allow_for",
      { publicUrl: PUBLIC_URL, minutes: 15 },
      executor,
    )
    const levelOf = async (at: Date) =>
      (await loadGatewayServers(scope, at))[0]!.tools.find(
        (tool) => tool.name === "send_postcard",
      )!.access

    expect(await levelOf(new Date())).toBe("allowed")
    // Afterwards the token's own ask decides again, not all tokens' allowed.
    expect(await levelOf(new Date(Date.now() + 16 * 60_000))).toBe("ask")

    // A block the owner sets later wins over the allowance.
    await writeToolAccess(tokenId, server.id, "send_postcard", "blocked")
    expect(await levelOf(new Date())).toBe("blocked")
  })

  it("Allow for takes only the times it offers, and is for calls and sites only", async () => {
    const { ctx, scope, server, tokenId } = await setup()
    const { calls, executor } = stub()
    await withPermission(scope, call(server, "add_numbers", { a: 1 }))
    const id = await onlyRequestId()

    await expect(
      decidePermission(
        ctx,
        id,
        "allow_for",
        { publicUrl: PUBLIC_URL, minutes: 7 },
        executor,
      ),
    ).rejects.toThrow(/Allow for one of/)
    await expect(
      decidePermission(
        ctx,
        id,
        "allow_for",
        { publicUrl: PUBLIC_URL },
        executor,
      ),
    ).rejects.toThrow(/Allow for one of/)
    expect(calls).toHaveLength(0)
    expect(await listTokenAllowances(ctx, tokenId)).toEqual([])
    expect(
      (await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL }))?.decisions,
    ).toContainEqual({ value: "allow_for", label: "Allow for" })
  })

  it("copying access replaces what a token was allowed for a while", async () => {
    const { ctx, scope, server, tokenId } = await setup()
    const { executor } = stub()
    await withPermission(scope, call(server, "add_numbers", { a: 1 }))
    await decidePermission(
      ctx,
      await onlyRequestId(),
      "allow_for",
      { publicUrl: PUBLIC_URL, minutes: 15 },
      executor,
    )
    const { id: otherId } = await createApiToken(ctx, {
      name: "Phone",
      allowAllServers: true,
      serverIds: [],
    })

    await copyTokenAccess(ctx, tokenId, otherId)
    expect(await listTokenAllowances(ctx, tokenId)).toEqual([])
  })

  it("keeps a long answer for the token, and says so in the outcome", async () => {
    const { ctx, scope, server, tokenId } = await setup()
    const long = `${"word ".repeat(30_000)}THE END`
    const executor: PermissionExecutor = {
      callTool: async () => ({ content: [{ type: "text", text: long }] }),
      syncTools: async () => ({ status: "ok", message: "", toolCount: 3 }),
    }
    await withPermission(scope, call(server, "add_numbers", { a: 1 }))
    const id = await onlyRequestId()

    const ran = await decidePermission(
      ctx,
      id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    expect(textOf(ran)).not.toContain("THE END")
    expect(textOf(ran)).toContain("PCP kept the whole answer")

    const kept = await db().toolResult.findFirstOrThrow()
    expect(kept).toMatchObject({ tokenId, toolName: "add_numbers" })
    expect(kept.length).toBe(long.length)

    // The stored outcome is shorter still, and still names the result.
    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(view?.outcome).toContain(`as result ${kept.id}`)
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
    expect(textOf(asked)).toMatch(
      /End your reply with this link.*\n.*\/permissions\//,
    )
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

  it("names every secret when the credential has several headers, and adds them all", async () => {
    const { ctx, scope } = await setup()
    const { executor } = stub()
    const key = await createSecret(ctx, { name: "domains key", value: "k" })
    const secretKey = await createSecret(ctx, {
      name: "domains secret key",
      value: "s",
    })

    const extra = {
      secretId: secretKey.id,
      secretName: "domains secret key",
      headerName: "X-Secret-API-Key",
      valueTemplate: "{{secret}}",
    }

    // With the first secret to be typed in by the owner, the stored one is
    // still named as theirs.
    await withPermission(scope, {
      kind: "register",
      input: {
        name: "Typed domains",
        url: "https://domains.example.com/mcp",
        authType: "header",
        authHeaderName: "X-API-Key",
        authValueTemplate: "{{secret}}",
        secretName: "new domains key",
        newSecretName: "new domains key",
        authExtraHeaders: [extra],
      },
    })
    const typed = await onlyRequestId()
    expect(
      (await getPermissionView(ctx, typed, { publicUrl: PUBLIC_URL }))?.lines,
    ).toContain(
      'Authentication: sends a new secret, saved as "new domains key", in the X-API-Key header, and your secret "domains secret key" in the X-Secret-API-Key header; you enter its value here when you agree',
    )
    await db().permissionRequest.deleteMany()

    await withPermission(scope, {
      kind: "register",
      input: {
        name: "Domains",
        url: "https://domains.example.com/mcp",
        authType: "header",
        authSecretId: key.id,
        authHeaderName: "X-API-Key",
        authValueTemplate: "{{secret}}",
        secretName: "domains key",
        authExtraHeaders: [extra],
      },
    })
    const id = await onlyRequestId()
    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(view?.lines).toContain(
      'Authentication: sends your secret "domains key" in the X-API-Key header, and "domains secret key" in the X-Secret-API-Key header',
    )
    expect(view?.warning).toMatch(
      /the secrets "domains key" and "domains secret key"/,
    )

    await decidePermission(
      ctx,
      id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    const added = await db().mcpServer.findFirstOrThrow({
      where: { name: "Domains" },
      include: { authHeaders: true },
    })
    expect(added.authHeaders).toMatchObject([
      {
        position: 1,
        secretId: secretKey.id,
        headerName: "X-Secret-API-Key",
        valueTemplate: "{{secret}}",
      },
    ])
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

describe("a change to an API endpoint of the owner's", () => {
  async function ownersEndpoint(ctx: VaultContext) {
    const secret = await createSecret(ctx, { name: "Pets key", value: "k" })
    const { id } = await createEndpoint(ctx, {
      name: "Pets",
      specSource: "upload",
      specText: PETS_SPEC,
      baseUrl: "https://api.example.com/v1",
      readOnly: false,
      authType: "header",
      authSecretId: secret.id,
      authHeaderName: "X-API-Key",
      authValueTemplate: "{{secret}}",
    })

    return id
  }

  async function asked(scope: Awaited<ReturnType<typeof setup>>["scope"]) {
    const outcome = await updateEndpointDetails(
      { ...scope, serverIds: null },
      "pets",
      {
        addPatches: [{ op: "remove", path: "/paths/~1pets~1{petId}" }],
        toolDescriptions: { listPets: "Every pet in the shop." },
      },
    )
    if (!("ask" in outcome)) throw new Error("not asked")

    return withPermission(scope, {
      kind: "endpoint_change",
      input: outcome.ask,
    })
  }

  it("shows the owner the change and makes it when they agree", async () => {
    const { ctx, scope } = await setup()
    const id = await ownersEndpoint(ctx)

    expect(textOf(await asked(scope))).toContain("Not done yet")
    const request = await db().permissionRequest.findFirstOrThrow({
      where: { kind: "endpoint_change" },
    })
    const view = await getPermissionView(ctx, request.id, {
      publicUrl: PUBLIC_URL,
    })

    expect(view).toMatchObject({
      title: "Change the API endpoint Pets?",
      tool: "update_endpoint",
      serverName: "Pets",
      decisions: [
        { value: "allow_once", label: "Make the change" },
        { value: "decline", label: "Not now" },
      ],
    })
    expect(view!.lines).toEqual(
      expect.arrayContaining([
        "New edit: remove /paths/~1pets~1{petId}",
        "Description of listPets:\nEvery pet in the shop.",
        "Takes out: deletePet",
        'Asked by the token "Claude"',
      ]),
    )

    const done = await decidePermission(ctx, request.id, "allow_once", {
      publicUrl: PUBLIC_URL,
    })
    expect(textOf(done)).toBe("Changed Pets: 2 tools.")

    const tools = await db().mcpTool.findMany({
      where: { serverId: id },
      orderBy: { name: "asc" },
    })
    expect(tools.map((tool) => [tool.name, tool.descriptionOverride])).toEqual([
      ["createPet", null],
      ["listPets", "Every pet in the shop."],
    ])
  })

  it("changes nothing when the owner says no", async () => {
    const { ctx, scope } = await setup()
    const id = await ownersEndpoint(ctx)
    await asked(scope)
    const request = await db().permissionRequest.findFirstOrThrow({
      where: { kind: "endpoint_change" },
    })

    await decidePermission(ctx, request.id, "decline", {
      publicUrl: PUBLIC_URL,
    })

    expect(await db().mcpTool.count({ where: { serverId: id } })).toBe(3)
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
    expect(textOf(asked)).toMatch(
      /End your reply with this link.*\n.*\/permissions\//,
    )
    expect(textOf(asked)).toMatch(
      /type the value of the secret "Pets API key" in there; do not ask them for it here/,
    )

    const id = await onlyRequestId()
    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(view?.secretToEnter).toEqual({
      name: "Pets API key",
      exists: false,
      optional: false,
      clientId: null,
      login: null,
    })
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
    ).toMatchObject({ name: "Pets API key", exists: true })

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

describe("an API that signs in with OAuth", () => {
  const OAUTH_SPEC = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Mail" },
    servers: [{ url: "https://mail.example.com/v1" }],
    components: {
      securitySchemes: {
        oauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://accounts.example.com/authorize",
              tokenUrl: "https://accounts.example.com/token",
              scopes: { "mail.read": "", "mail.send": "" },
            },
          },
        },
      },
    },
    paths: {
      "/me": {
        get: { operationId: "me", security: [{ oauth: ["mail.read"] }] },
      },
    },
  })

  /** register_server with auth_type oauth and the owner's client_id. */
  async function withClient(ctx: VaultContext): Promise<RegisterArgs> {
    const prepared = await prepareRegistration(ctx, {
      name: "Mail",
      spec: OAUTH_SPEC,
      baseUrl: "https://mail.example.com/v1",
      oauth: { scope: null },
    })

    return {
      name: prepared.name,
      description: prepared.description,
      url: prepared.url,
      authType: "oauth",
      oauthClientId: "owner-client",
      oauthClientSecretId: null,
      secretName: "Mail OAuth client secret",
      newSecretName: "Mail OAuth client secret",
      newSecretOptional: true,
      oauthScope: prepared.registration.preview.oauth?.scope ?? null,
      endpoint: prepared.registration,
    }
  }

  it("needs the base URL named, and a schema with a sign-in", async () => {
    const ctx = await setupVault({ name: "Ada", password: PASSWORD })

    await expect(
      prepareRegistration(ctx, {
        name: "Mail",
        spec: OAUTH_SPEC,
        oauth: { scope: null },
      }),
    ).rejects.toThrow(/OAuth token is sent to an address you name/)
    await expect(
      prepareRegistration(ctx, {
        name: "Pets",
        spec: PETS_SPEC,
        baseUrl: "https://api.example.com/v1",
        oauth: { scope: null },
      }),
    ).rejects.toThrow(/declares no OAuth sign-in/)
  })

  it("shows the owner where they sign in, where the client secret goes and the redirect URI", async () => {
    const { ctx, scope } = await setup()

    const asked = await withPermission(scope, {
      kind: "register",
      input: await withClient(ctx),
    })
    expect(textOf(asked)).toMatch(
      /type the client secret of their OAuth client in there/,
    )

    const view = await getPermissionView(ctx, await onlyRequestId(), {
      publicUrl: PUBLIC_URL,
    })
    expect(view?.secretToEnter).toEqual({
      name: "Mail OAuth client secret",
      exists: false,
      optional: true,
      clientId: "owner-client",
      login: null,
    })
    expect(view?.lines).toEqual(
      expect.arrayContaining([
        'Authentication: OAuth with your client "owner-client"; enter its client secret here when you agree (leave it empty for a client without one); you sign in when you connect it (scope mail.read)',
        "Sign-in at: https://accounts.example.com/authorize",
        "Tokens from: https://accounts.example.com/token; your client secret goes there",
        `Redirect URI your client needs: ${PUBLIC_URL}/api/oauth/callback`,
      ]),
    )
    expect(view?.warning).toMatch(/OAuth token for this account/)
  })

  it("adds it with the client and the secret typed in, and asks the owner to connect it", async () => {
    const { ctx, scope } = await setup()
    const { executor } = stub()

    await withPermission(scope, {
      kind: "register",
      input: await withClient(ctx),
    })
    const added = await decidePermission(
      ctx,
      await onlyRequestId(),
      "allow_once",
      { publicUrl: PUBLIC_URL, secretValue: "client-s3cret" },
      executor,
    )

    expect(textOf(added)).toMatch(/Added Mail as "mail"/)
    expect(textOf(added)).not.toContain("client-s3cret")
    const server = await db().mcpServer.findFirstOrThrow({
      where: { name: "Mail" },
    })
    expect(server).toMatchObject({
      kind: "openapi",
      authType: "oauth",
      oauthClientId: "owner-client",
      oauthScope: "mail.read",
      oauthAuthorizationUrl: "https://accounts.example.com/authorize",
      oauthTokenUrl: "https://accounts.example.com/token",
      oauthConnectedAt: null,
    })
    expect(await revealSecret(ctx, server.oauthClientSecretId!)).toBe(
      "client-s3cret",
    )
  })

  it("can be agreed to with the client secret left empty", async () => {
    const { ctx, scope } = await setup()
    const { executor } = stub()

    await withPermission(scope, {
      kind: "register",
      input: await withClient(ctx),
    })
    const added = await decidePermission(
      ctx,
      await onlyRequestId(),
      "allow_once",
      { publicUrl: PUBLIC_URL },
      executor,
    )

    expect(added.isError ?? false).toBe(false)
    expect(
      await db().mcpServer.findFirstOrThrow({ where: { name: "Mail" } }),
    ).toMatchObject({
      oauthClientId: "owner-client",
      oauthClientSecretId: null,
    })
    expect(await db().secret.count()).toBe(0)
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
    expect(view?.memory).toEqual({
      path: "/memories/shared/preferences.md",
      newPath: null,
      text: "Metric units.\nBritish spelling.",
      before: null,
      always: false,
    })
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

  it("reads it in every conversation when the owner ticks that with the answer", async () => {
    const { ctx, scope } = await setup()

    await withPermission(scope, {
      ...share,
      input: { ...share.input, always: true },
    })
    const id = await onlyRequestId()
    expect(
      (await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL }))?.memory
        ?.always,
    ).toBe(true)

    expect(
      textOf(
        await decidePermission(ctx, id, "allow_once", {
          ...web,
          always: true,
        }),
      ),
    ).toContain("It is read in every conversation.")
    expect((await listMemories(ctx))[0]).toMatchObject({
      visibility: "shared",
      always: true,
    })
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

describe("an API with a user name and password", () => {
  /** register_server with auth_type basic, the password typed in on PCP. */
  async function withLogin(ctx: VaultContext): Promise<RegisterArgs> {
    const prepared = await prepareRegistration(ctx, {
      name: "Pets",
      spec: PETS_SPEC,
      baseUrl: "https://api.example.com/v1",
      newSecretName: "Pets password",
      authHeaderNames: ["Authorization"],
    })

    return {
      name: prepared.name,
      description: prepared.description,
      url: prepared.url,
      authType: "basic",
      authUsername: "ada",
      authSecretId: null,
      secretName: "Pets password",
      newSecretName: "Pets password",
      oauthScope: null,
      endpoint: prepared.registration,
    }
  }

  it("tells the owner the user name and where the password goes, and the assistant only that they type it in", async () => {
    const { ctx, scope } = await setup()

    const asked = await withPermission(scope, {
      kind: "register",
      input: await withLogin(ctx),
    })
    expect(textOf(asked)).toMatch(
      /They type the password for ada in there, and it is saved as the secret "Pets password"; do not ask them for it here/,
    )

    const view = await getPermissionView(ctx, await onlyRequestId(), {
      publicUrl: PUBLIC_URL,
    })
    expect(view?.secretToEnter).toEqual({
      name: "Pets password",
      exists: false,
      optional: false,
      clientId: null,
      login: "ada",
    })
    expect(view?.lines).toContain(
      'Authentication: sends a new secret, saved as "Pets password", as the password for ada (HTTP Basic); you enter its value here when you agree',
    )
    expect(view?.warning).toMatch(
      /user name ada and the secret "Pets password" to this address/,
    )
  })

  it("saves the typed password under the proposed name and adds the endpoint with the user name", async () => {
    const { ctx, scope } = await setup()
    const { executor } = stub()

    await withPermission(scope, {
      kind: "register",
      input: await withLogin(ctx),
    })
    const added = await decidePermission(
      ctx,
      await onlyRequestId(),
      "allow_once",
      { publicUrl: PUBLIC_URL, secretValue: "pw-123" },
      executor,
    )

    expect(textOf(added)).toMatch(/Added Pets as "pets"/)
    expect(textOf(added)).not.toContain("pw-123")

    const secret = await db().secret.findFirstOrThrow({
      where: { name: "Pets password" },
    })
    expect(await revealSecret(ctx, secret.id)).toBe("pw-123")
    expect(secret.description).toBe("The password for ada at Pets.")
    expect(
      await db().mcpServer.findFirstOrThrow({ where: { name: "Pets" } }),
    ).toMatchObject({
      kind: "openapi",
      authType: "basic",
      authUsername: "ada",
      authSecretId: secret.id,
      authHeaderName: "Authorization",
      url: "https://api.example.com/v1",
      publicOnly: true,
    })
  })
})

describe("a mail account an assistant proposes", () => {
  const PASSWORD = "app-password-1234"
  const BASIC = `Basic ${Buffer.from(`ada@example.com:${PASSWORD}`).toString("base64")}`
  let api: TestApi
  let fake: FakeJmap

  beforeEach(async () => {
    fake = createFakeJmap({
      authorize: (header) => header === BASIC || header === "Bearer token-1",
    })
    api = await startTestApi((request, res) => {
      const answer = fake.handle(request)
      res.statusCode = answer?.status ?? 404
      res.setHeader("content-type", answer?.type ?? "text/plain")
      res.end(answer?.body ?? "")
    })
  })

  afterEach(async () => {
    await api.close()
  })

  /** What register_server hands the request for a JMAP account. */
  function proposal(overrides: Partial<RegisterArgs> = {}): RegisterArgs {
    return {
      name: "Mail",
      description: "",
      url: `${api.origin}/jmap/session`,
      authType: "basic",
      authUsername: "ada@example.com",
      authSecretId: null,
      secretName: "Mail password",
      newSecretName: "Mail password",
      oauthScope: null,
      mail: {
        protocol: "jmap",
        smtpUrl: null,
        readOnly: false,
        mailFrom: null,
        checked: `A server answers at ${api.origin}/jmap/session and asks for a sign-in (Basic).`,
        privateAddress: null,
      },
      ...overrides,
    }
  }

  const real: PermissionExecutor = {
    callTool: callServerTool,
    syncTools: syncServerTools,
  }
  const web = { publicUrl: PUBLIC_URL }

  it("is asked for with the password typed in on PCP's page, and nothing is contacted or made", async () => {
    const { ctx, scope } = await setup()

    const asked = await withPermission(scope, {
      kind: "register",
      input: proposal(),
    })
    expect(textOf(asked)).toMatch(
      /They type the password for ada@example\.com in there, and it is saved as the secret "Mail password"/,
    )

    const view = await getPermissionView(ctx, await onlyRequestId(), {
      publicUrl: PUBLIC_URL,
    })
    expect(view?.title).toBe("Add the mail account Mail?")
    expect(view?.secretToEnter).toEqual({
      name: "Mail password",
      exists: false,
      optional: false,
      clientId: null,
      login: "ada@example.com",
    })
    expect(view?.lines).toEqual(
      expect.arrayContaining([
        "Protocol: JMAP",
        `Session URL: ${api.origin}/jmap/session`,
        expect.stringMatching(/^Checked: A server answers at /),
        "User name: ada@example.com",
        'Authentication: user name and password; the password is saved as a new secret "Mail password", and you enter it here when you agree',
        expect.stringMatching(/^Can change things: .*never for good/),
        'Asked by the token "Claude"',
      ]),
    )
    expect(view?.warning).toMatch(
      /user name ada@example\.com and the secret "Mail password" to this mail server/,
    )
    // Only the owner's yes starts anything: Postcards is the one server.
    expect(await db().mcpServer.count()).toBe(1)
    expect(fake.requests).toHaveLength(0)
  })

  it("adds it with the typed password, signs in to read its tools and lets a scoped token reach it", async () => {
    const { ctx, scope, tokenId } = await setup({ allowAllServers: false })

    await withPermission(scope, { kind: "register", input: proposal() })
    const id = await onlyRequestId()
    const added = await decidePermission(
      ctx,
      id,
      "allow_once",
      { ...web, secretValue: PASSWORD },
      real,
    )

    expect(textOf(added)).toMatch(/Added Mail as "mail" with 10 tools/)
    expect(textOf(added)).toMatch(/saved in PCP as "Mail password"/)
    expect(textOf(added)).not.toContain(PASSWORD)

    const secret = await db().secret.findFirstOrThrow({
      where: { name: "Mail password" },
    })
    expect(await revealSecret(ctx, secret.id)).toBe(PASSWORD)
    expect(secret.description).toBe("The password for ada@example.com at Mail.")
    const account = await db().mcpServer.findFirstOrThrow({
      where: { name: "Mail" },
    })
    expect(account).toMatchObject({
      kind: "jmap",
      authType: "basic",
      authUsername: "ada@example.com",
      authSecretId: secret.id,
      status: "ok",
      mailAccountId: "acct-1",
    })
    expect(fake.requests[0]!.authorization).toBe(BASIC)
    expect(
      await db().apiTokenServer.count({
        where: { tokenId, serverId: account.id },
      }),
    ).toBe(1)
    // The value is on no request row.
    const row = await db().permissionRequest.findUniqueOrThrow({
      where: { id },
    })
    expect(
      Buffer.from(row.resultCiphertext ?? []).toString("utf8"),
    ).not.toContain(PASSWORD)
  })

  it("cannot be agreed to without the password, and nothing is made", async () => {
    const { ctx, scope } = await setup()

    await withPermission(scope, { kind: "register", input: proposal() })
    const refused = await decidePermission(
      ctx,
      await onlyRequestId(),
      "allow_once",
      web,
      real,
    )

    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatch(/Enter/)
    expect(await db().secret.count()).toBe(0)
    expect(await db().mcpServer.count()).toBe(1)
    expect(fake.requests).toHaveLength(0)
  })

  it("uses a password the owner already stored, by its name", async () => {
    const { ctx, scope } = await setup()
    const stored = await createSecret(ctx, {
      name: "Mail password",
      value: PASSWORD,
    })

    await withPermission(scope, {
      kind: "register",
      input: proposal({
        authSecretId: stored.id,
        newSecretName: undefined,
      }),
    })
    const view = await getPermissionView(ctx, await onlyRequestId(), web)
    expect(view?.secretToEnter).toBeNull()
    expect(view?.lines).toContain(
      'Authentication: user name and your secret "Mail password" as the password',
    )

    const added = await decidePermission(
      ctx,
      await onlyRequestId(),
      "allow_once",
      web,
      real,
    )
    expect(textOf(added)).toMatch(/Added Mail as "mail" with 10 tools/)
    expect(fake.requests[0]!.authorization).toBe(BASIC)
  })

  it("takes a bearer token and a read-only account, with the reading tools only", async () => {
    const { ctx, scope } = await setup()

    await withPermission(scope, {
      kind: "register",
      input: proposal({
        authType: "header",
        authUsername: undefined,
        secretName: "Mail token",
        newSecretName: "Mail token",
        authHeaderName: "Authorization",
        authValueTemplate: "Bearer {{secret}}",
        mail: { ...proposal().mail!, readOnly: true },
      }),
    })
    const id = await onlyRequestId()
    const view = await getPermissionView(ctx, id, web)
    expect(view?.lines).toEqual(
      expect.arrayContaining([
        'Authentication: a bearer token, saved as a new secret "Mail token"; you enter it here when you agree',
        "Read-only: only the tools that read mail",
      ]),
    )

    const added = await decidePermission(
      ctx,
      id,
      "allow_once",
      { ...web, secretValue: "token-1" },
      real,
    )
    expect(textOf(added)).toMatch(/Added Mail as "mail" with 6 tools/)
    expect(fake.requests[0]!.authorization).toBe("Bearer token-1")
    expect(
      await db().mcpServer.findFirstOrThrow({ where: { name: "Mail" } }),
    ).toMatchObject({
      kind: "jmap",
      authType: "header",
      readOnly: true,
      authValueTemplate: "Bearer {{secret}}",
    })
  })

  it("answers an OAuth account with the link to connect it, and contacts nothing before that", async () => {
    const { ctx, scope } = await setup()

    await withPermission(scope, {
      kind: "register",
      input: proposal({
        authType: "oauth",
        authUsername: undefined,
        secretName: null,
        newSecretName: undefined,
        oauthScope: "urn:ietf:params:oauth:scope:mail offline_access",
      }),
    })
    const id = await onlyRequestId()
    const view = await getPermissionView(ctx, id, web)
    expect(view?.lines).toEqual(
      expect.arrayContaining([
        "Authentication: OAuth; you sign in when you connect it (scope urn:ietf:params:oauth:scope:mail offline_access)",
        expect.stringMatching(/^Sign-in: PCP finds where the mail server/),
      ]),
    )
    expect(view?.warning).toMatch(
      /OAuth token for this account to this mail server/,
    )

    const added = await decidePermission(ctx, id, "allow_once", web, real)

    expect(textOf(added)).toMatch(/Added Mail as "mail"/)
    expect(
      (added.structuredContent as { kind?: string } | undefined)?.kind,
    ).toBe("connect")
    expect(
      await db().mcpServer.findFirstOrThrow({ where: { name: "Mail" } }),
    ).toMatchObject({
      kind: "jmap",
      authType: "oauth",
      oauthConnectedAt: null,
      oauthScope: "urn:ietf:params:oauth:scope:mail offline_access",
    })
    expect(fake.requests).toHaveLength(0)
  })

  it("says so after it is added when the server cannot be reached", async () => {
    const { ctx, scope } = await setup()

    await withPermission(scope, {
      kind: "register",
      input: proposal({
        url: "imaps://127.0.0.1:1",
        mail: {
          protocol: "imap",
          smtpUrl: null,
          readOnly: false,
          mailFrom: null,
          checked: null,
          privateAddress: null,
        },
      }),
    })
    const id = await onlyRequestId()
    const view = await getPermissionView(ctx, id, web)
    expect(view?.lines).toEqual(
      expect.arrayContaining([
        "Protocol: IMAP (it cannot send: no SMTP server was named)",
        "IMAP server: imaps://127.0.0.1:1",
      ]),
    )

    const added = await decidePermission(
      ctx,
      id,
      "allow_once",
      { ...web, secretValue: PASSWORD },
      real,
    )
    expect(textOf(added)).toMatch(
      /Added Mail as "mail", but its tools could not be read yet/,
    )
    expect(
      await db().mcpServer.findFirstOrThrow({ where: { name: "Mail" } }),
    ).toMatchObject({ kind: "imap", status: "error" })
  })

  it("notes a private address that PCP did not look at, for the owner to weigh", async () => {
    const { ctx, scope } = await setup()

    await withPermission(scope, {
      kind: "register",
      input: proposal({
        mail: {
          ...proposal().mail!,
          checked: null,
          privateAddress:
            "127.0.0.1 is, or resolves to, a private or local address, so PCP did not look at it from here.",
        },
      }),
    })

    const view = await getPermissionView(ctx, await onlyRequestId(), web)
    expect(view?.lines).toContain(
      "127.0.0.1 is, or resolves to, a private or local address, so PCP did not look at it from here. If you agree, PCP signs in there from your own network.",
    )
    expect(view?.lines.some((line) => line.startsWith("Checked:"))).toBe(false)
  })
})
