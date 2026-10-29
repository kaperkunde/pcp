import { randomUUID } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken, revokeApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import { loadGatewayServers, type GatewayServer } from "./gateway"
import { newId } from "./ids"
import {
  nextPendingRequest,
  ownerQueue,
  queueHref,
  waitingRequestsWhere,
} from "./owner-queue"
import {
  decidePermission,
  listOpenPermissions,
  listPendingRequests,
  withPermission,
  type PermissionExecutor,
} from "./permissions"
import { repoChangeHref } from "./repos/notices"
import { encryptItemData, type RepoItemData } from "./repos/store"
import { createServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// The owner's queue: requests from assistants and changes linked
// repositories left for review, oldest first, and the walk from one
// answered to the next.

let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
})

afterEach(async () => {
  await cleanup()
})

const PUBLIC_URL = "http://localhost:3000"

const executor: PermissionExecutor = {
  callTool: async (_ctx, _server, tool) => ({
    content: [{ type: "text", text: `ran ${tool}` }],
  }),
  syncTools: async () => ({ status: "ok", message: "", toolCount: 1 }),
}

async function setup() {
  const ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  const { id: serverId } = await createServer(ctx, {
    name: "Postcards",
    url: "https://postcards.example.com/mcp",
    authType: "none",
  })
  await db().mcpTool.create({
    data: {
      id: randomUUID(),
      serverId,
      name: "send_postcard",
      description: "Sends a postcard.",
      inputSchema: JSON.stringify({ type: "object" }),
      annotations: JSON.stringify({ destructiveHint: true }),
    },
  })
  const { id: tokenId, token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    serverIds: [],
  })
  const scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  const [server] = await loadGatewayServers(scope)

  return { ctx, scope, tokenId, serverId, server: server! }
}

/** Asks the owner about one postcard, made at `at`; its request's id. */
async function ask(
  scope: Awaited<ReturnType<typeof setup>>["scope"],
  server: GatewayServer,
  to: string,
  at: Date,
): Promise<string> {
  await withPermission(scope, {
    kind: "call",
    server,
    tool: server.tools.find((tool) => tool.name === "send_postcard")!,
    args: { to },
  })
  const row = await db().permissionRequest.findFirstOrThrow({
    orderBy: { createdAt: "desc" },
  })
  await db().permissionRequest.update({
    where: { id: row.id },
    data: { createdAt: at },
  })

  return row.id
}

/** A linked server whose repository's change waits for review since `at`. */
async function repoReview(
  ctx: VaultContext,
  serverId: string,
  at: Date,
): Promise<string> {
  const repoId = newId()
  await db().repo.create({
    data: {
      id: repoId,
      vaultId: ctx.vaultId,
      // Not read here: only the items are.
      ciphertext: new Uint8Array([0]),
    },
  })
  const id = newId()
  const data: RepoItemData = {
    path: "servers/postcards.json",
    remoteSha: null,
    localHash: null,
    pending: {
      kind: "review",
      ref: { kind: "server", name: "postcards" },
      sha: "a".repeat(40),
      hash: "b".repeat(64),
      commit: "c".repeat(40),
      basis: null,
      flags: 0,
      foundAt: at.toISOString(),
    },
    declinedSha: null,
    drafts: {},
    note: null,
  }
  await db().repoItem.create({
    data: {
      id,
      repoId,
      itemKind: "server",
      serverId,
      ciphertext: encryptItemData(ctx, id, data),
      state: "review",
    },
  })

  return id
}

describe("the owner's queue", () => {
  it("is oldest first, repository reviews among the requests by when they started waiting", async () => {
    const { ctx, scope, server, serverId } = await setup()
    const t = Date.now()
    const newer = await ask(scope, server, "Bob", new Date(t - 1_000))
    const older = await ask(scope, server, "Ada", new Date(t - 3_000))
    const item = await repoReview(ctx, serverId, new Date(t - 2_000))

    expect(
      (await ownerQueue(ctx)).map((entry) => [entry.source, entry.id]),
    ).toEqual([
      ["request", older],
      ["repo", item],
      ["request", newer],
    ])

    // Every list of requests agrees: the bell, Home, the token's page.
    expect(
      (await listPendingRequests(ctx, PUBLIC_URL)).requests.map(
        (request) => request.id,
      ),
    ).toEqual([older, newer])
    expect(
      (await listOpenPermissions(ctx, scope.tokenId, PUBLIC_URL)).map(
        (view) => view.id,
      ),
    ).toEqual([older, newer])
  })

  it("leads from the one just answered to the oldest other, and to none when nothing is left", async () => {
    const { ctx, scope, server, serverId } = await setup()
    const t = Date.now()
    const older = await ask(scope, server, "Ada", new Date(t - 3_000))
    const item = await repoReview(ctx, serverId, new Date(t - 2_000))
    const newer = await ask(scope, server, "Bob", new Date(t - 1_000))

    expect(await nextPendingRequest(ctx)).toBe(`/permissions/${older}`)
    // The one just answered may still read as waiting: it is skipped.
    expect(await nextPendingRequest(ctx, older)).toBe(repoChangeHref(item))
    expect(await nextPendingRequest(ctx, item)).toBe(`/permissions/${older}`)

    await decidePermission(
      ctx,
      older,
      "decline",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    expect(await nextPendingRequest(ctx, older)).toBe(repoChangeHref(item))

    // The review answered, the newer request is next.
    await db().repoItem.update({ where: { id: item }, data: { state: "ok" } })
    await db().repoItem.update({
      where: { id: item },
      data: {
        ciphertext: encryptItemData(ctx, item, {
          path: "servers/postcards.json",
          remoteSha: null,
          localHash: null,
          pending: null,
          declinedSha: null,
          drafts: {},
          note: null,
        }),
      },
    })
    expect(await nextPendingRequest(ctx, item)).toBe(`/permissions/${newer}`)
    expect(await nextPendingRequest(ctx, newer)).toBeNull()

    await decidePermission(
      ctx,
      newer,
      "decline",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    expect(await nextPendingRequest(ctx)).toBeNull()
    expect(await ownerQueue(ctx)).toEqual([])
  })

  it("leaves out a dead token's requests, everywhere alike", async () => {
    const { ctx, scope, server } = await setup()
    const id = await ask(scope, server, "Ada", new Date())

    expect(
      await db().permissionRequest.count({ where: waitingRequestsWhere(ctx) }),
    ).toBe(1)

    await revokeApiToken(ctx, scope.tokenId)

    expect(await nextPendingRequest(ctx)).toBeNull()
    expect((await listPendingRequests(ctx, PUBLIC_URL)).total).toBe(0)
    expect(await listOpenPermissions(ctx, scope.tokenId, PUBLIC_URL)).toEqual(
      [],
    )
    expect(queueHref({ source: "request", id })).toBe(`/permissions/${id}`)
  })

  it("answers a hand-over on its tab while the tab is open, and on its page once it is gone", () => {
    expect(
      queueHref({
        source: "request",
        id: "r1",
        kind: "browser_handover",
        tabId: "t 1",
      }),
    ).toBe("/browser?tab=t%201")
    // Its tab is gone (closed, or PCP started again since).
    expect(
      queueHref({
        source: "request",
        id: "r1",
        kind: "browser_handover",
        tabId: null,
      }),
    ).toBe("/permissions/r1")
    expect(
      queueHref({ source: "request", id: "r1", kind: "browser_handover" }),
    ).toBe("/permissions/r1")
    // A tab says nothing for another kind.
    expect(
      queueHref({ source: "request", id: "r1", kind: "browse", tabId: "t1" }),
    ).toBe("/permissions/r1")
  })

  it("leads to a hand-over's own page when no browser holds its tab", async () => {
    const { ctx, scope, serverId } = await setup()
    await withPermission(scope, {
      kind: "browser_handover",
      input: {
        serverId,
        tabId: "gone",
        message: "Please sign in.",
        url: "https://example.com/login",
        title: "Sign in",
      },
    })
    const { id } = await db().permissionRequest.findFirstOrThrow({
      where: { kind: "browser_handover" },
    })

    expect(await ownerQueue(ctx)).toMatchObject([
      { source: "request", id, kind: "browser_handover", tabId: null },
    ])
    expect(await nextPendingRequest(ctx)).toBe(`/permissions/${id}`)
    expect((await listPendingRequests(ctx, PUBLIC_URL)).requests).toEqual([
      expect.objectContaining({ id, href: `/permissions/${id}` }),
    ])
  })
})
