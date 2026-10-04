import { randomUUID } from "node:crypto"

import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  describeSavedAccess,
  listAccessLevels,
  MAX_LISTED_TOOLS,
  resolveAccessChanges,
  type AccessServer,
} from "./access-requests"
import { createApiToken, resolveApiToken, revokeApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import { loadGatewayServers, type GatewayScope } from "./gateway"
import {
  applyAccessRequest,
  checkPermission,
  decidePermission,
  getAccessProposal,
  getPermissionView,
  withPermission,
} from "./permissions"
import { createServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { listTokenToolAccess } from "./tool-access"
import { setupVault } from "./vault"

// Tool levels an assistant proposes for its own token: resolved from names
// and patterns, asked about only through PCP's page, and written only when
// the owner saves there, as they left them.

describe("resolveAccessChanges", () => {
  const servers: AccessServer[] = [
    {
      id: "s1",
      slug: "billing",
      tools: [
        { name: "list_invoices", access: "ask" },
        { name: "list_clients", access: "allowed" },
        { name: "delete_invoice", access: "ask" },
        { name: "secret_admin", access: "blocked" },
      ],
    },
    {
      id: "s2",
      slug: "blog",
      tools: [
        { name: "read_post", access: "ask" },
        { name: "publish_post", access: "ask" },
      ],
    },
  ]

  it("sets many tools across servers, later changes winning", () => {
    expect(
      resolveAccessChanges(servers, [
        { server: "billing", access: "allowed" },
        { server: "billing", tools: ["delete_*"], access: "blocked" },
        { server: "blog", tools: ["read_post"], access: "allowed" },
      ]),
    ).toEqual([
      { serverId: "s1", tool: "delete_invoice", access: "blocked" },
      { serverId: "s1", tool: "list_invoices", access: "allowed" },
      { serverId: "s2", tool: "read_post", access: "allowed" },
    ])
  })

  it("leaves out tools that already have the level", () => {
    expect(
      resolveAccessChanges(servers, [
        { server: "billing", tools: ["list_clients"], access: "allowed" },
      ]),
    ).toEqual([])
  })

  it("cannot reach a blocked tool, by name or by pattern", () => {
    expect(() =>
      resolveAccessChanges(servers, [
        { server: "billing", tools: ["secret_admin"], access: "allowed" },
      ]),
    ).toThrow(/no tool matching "secret_admin"/)
    expect(
      resolveAccessChanges(servers, [
        { server: "billing", tools: ["*"], access: "allowed" },
      ]).map((level) => level.tool),
    ).not.toContain("secret_admin")
  })

  it("names what it could not find", () => {
    expect(() =>
      resolveAccessChanges(servers, [{ server: "mail", access: "allowed" }]),
    ).toThrow(/No server called mail\. Servers: billing, blog/)
    expect(() =>
      resolveAccessChanges(servers, [
        { server: "blog", tools: ["edit_*"], access: "allowed" },
      ]),
    ).toThrow(/"edit_\*"/)
    expect(() =>
      resolveAccessChanges(servers, [
        { server: "blog", access: "everything" as never },
      ]),
    ).toThrow()
    expect(() => resolveAccessChanges(servers, [])).toThrow()
  })

  it("treats pattern characters other than * literally", () => {
    expect(() =>
      resolveAccessChanges(servers, [
        { server: "blog", tools: ["read.post"], access: "allowed" },
      ]),
    ).toThrow()
  })
})

describe("listAccessLevels", () => {
  const servers = [
    { id: "s1", slug: "billing" },
    { id: "s2", slug: "blog" },
  ]

  it("names each tool that would change, by server and level", () => {
    expect(
      listAccessLevels(
        [
          { serverId: "s1", tool: "delete_invoice", access: "blocked" },
          { serverId: "s1", tool: "list_invoices", access: "allowed" },
          { serverId: "s1", tool: "list_clients", access: "allowed" },
          { serverId: "s2", tool: "read_post", access: "allowed" },
        ],
        servers,
      ).split("\n"),
    ).toEqual([
      "Tools that would change (those already at the level you asked for are left out):",
      "- billing, to Blocked: delete_invoice",
      "- billing, to Allowed: list_invoices, list_clients",
      "- blog, to Allowed: read_post",
    ])
  })

  it("stops naming them past the limit and says how many more", () => {
    const levels = Array.from({ length: MAX_LISTED_TOOLS + 3 }, (_, i) => ({
      serverId: "s1",
      tool: `tool_${i}`,
      access: "ask" as const,
    }))
    const listed = listAccessLevels(levels, servers)

    expect(listed).toContain("tool_0, tool_1")
    expect(listed).not.toContain(`tool_${MAX_LISTED_TOOLS},`)
    expect(listed).toContain("- and 3 more, shown to the owner on the page")
  })
})

describe("describeSavedAccess", () => {
  const proposed = [
    { serverId: "s", tool: "a", access: "allowed" as const },
    { serverId: "s", tool: "b", access: "allowed" as const },
  ]

  it("says what was taken, left out and added", () => {
    expect(describeSavedAccess(proposed, proposed)).toBe(
      "The owner saved new levels for 2 tools: 2 to Allowed. Every level you proposed was saved.",
    )
    expect(
      describeSavedAccess(proposed, [
        { serverId: "s", tool: "a", access: "allowed" },
        { serverId: "s", tool: "b", access: "blocked" },
        { serverId: "s", tool: "c", access: "blocked" },
      ]),
    ).toBe(
      "The owner saved new levels for 3 tools: 1 to Allowed, 2 to Blocked. They did not take 1 of the 2 levels you proposed. They also changed 1 tool you did not name.",
    )
  })
})

describe("proposing tool levels", () => {
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ cleanup } = await scratchDatabase())
  })

  afterEach(async () => {
    await cleanup()
  })

  const PUBLIC_URL = "http://localhost:3000"

  function textOf(result: unknown): string {
    return ((result as CallToolResult).content ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
  }

  async function addServer(ctx: VaultContext, name: string, tools: string[]) {
    const { id } = await createServer(ctx, {
      name,
      url: `https://${name.toLowerCase()}.example.com/mcp`,
      authType: "none",
    })

    for (const tool of tools) {
      await db().mcpTool.create({
        data: {
          id: randomUUID(),
          serverId: id,
          name: tool,
          description: `${tool} does one thing.`,
          inputSchema: JSON.stringify({ type: "object" }),
        },
      })
    }

    return id
  }

  async function setup() {
    const ctx = await setupVault({
      name: "Ada",
      password: "correct horse battery staple",
    })
    const billing = await addServer(ctx, "Billing", [
      "list_invoices",
      "list_clients",
      "delete_invoice",
    ])
    const blog = await addServer(ctx, "Blog", ["read_post", "publish_post"])
    const { id: tokenId, token } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })
    const resolved = (await resolveApiToken(token))!
    const scope: GatewayScope = { ...resolved, publicUrl: PUBLIC_URL }

    return { ctx, scope, tokenId, billing, blog }
  }

  async function propose(scope: GatewayScope) {
    const servers = await loadGatewayServers(scope)
    const levels = resolveAccessChanges(servers, [
      { server: "billing", tools: ["list_*"], access: "allowed" },
      { server: "billing", tools: ["delete_invoice"], access: "blocked" },
      { server: "blog", tools: ["read_post"], access: "allowed" },
    ])

    return withPermission(scope, { kind: "access", input: { levels } })
  }

  async function levelsOf(ctx: VaultContext, tokenId: string) {
    return Object.fromEntries(
      (await listTokenToolAccess(ctx, tokenId)).flatMap((server) =>
        server.tools.map((tool) => [
          `${server.slug}/${tool.name}`,
          tool.access,
        ]),
      ),
    )
  }

  it("hands out the page's link and changes nothing", async () => {
    const { ctx, scope, tokenId } = await setup()

    const asked = await propose(scope)
    const row = await db().permissionRequest.findFirstOrThrow()
    expect(row.kind).toBe("access")
    expect(row.toolName).toBe("propose_tool_access")
    expect(textOf(asked)).toContain(`${PUBLIC_URL}/permissions/${row.id}`)
    expect(textOf(asked)).toContain("4 tools would change")
    // The assistant can check what its patterns caught, and the link is
    // still last.
    expect(textOf(asked)).toContain(
      "- billing, to Allowed: list_clients, list_invoices",
    )
    expect(textOf(asked)).toContain("- billing, to Blocked: delete_invoice")
    expect(textOf(asked)).toContain("- blog, to Allowed: read_post")
    expect(textOf(asked).trimEnd()).toMatch(/permissions\/[\w-]+\S*$/)

    // The same proposal again finds the same request.
    await propose(scope)
    expect(await db().permissionRequest.count()).toBe(1)

    const checked = await checkPermission(scope, row.id, { waitMs: 0 })
    expect(textOf(checked)).toContain("Still waiting")

    expect(Object.values(await levelsOf(ctx, tokenId))).toEqual(
      Array(5).fill("ask"),
    )
  })

  it("takes no answer but no outside its page", async () => {
    const { ctx, scope, tokenId } = await setup()
    await propose(scope)
    const id = (await db().permissionRequest.findFirstOrThrow()).id

    for (const decision of ["allow_once", "always"] as const) {
      const result = await decidePermission(ctx, id, decision, {
        publicUrl: PUBLIC_URL,
        tokenId,
      })
      expect(result.isError).toBe(true)
    }

    expect(Object.values(await levelsOf(ctx, tokenId))).toEqual(
      Array(5).fill("ask"),
    )
    expect(
      (await db().permissionRequest.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe("pending")
  })

  it("writes what the owner saved on the page, once", async () => {
    const { ctx, scope, tokenId, billing, blog } = await setup()
    await propose(scope)
    const id = (await db().permissionRequest.findFirstOrThrow()).id

    const proposal = await getAccessProposal(ctx, id)
    expect(proposal?.tokenId).toBe(tokenId)
    expect(proposal?.proposed).toHaveLength(4)
    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(view?.title).toBe("Change which tools an assistant may run?")
    expect(view?.warning).toMatch(/allow 3 tools/)

    // The owner keeps two, says blocked instead of allowed for one, and
    // also blocks a tool the assistant did not name.
    const saved = await applyAccessRequest(
      ctx,
      id,
      [
        { serverId: billing, tool: "list_invoices", access: "allowed" },
        { serverId: billing, tool: "list_clients", access: "blocked" },
        { serverId: billing, tool: "delete_invoice", access: "blocked" },
        { serverId: blog, tool: "publish_post", access: "blocked" },
      ],
      { publicUrl: PUBLIC_URL },
    )

    expect(saved.isError).toBeUndefined()
    expect(await levelsOf(ctx, tokenId)).toEqual({
      "billing/delete_invoice": "blocked",
      "billing/list_clients": "blocked",
      "billing/list_invoices": "allowed",
      "blog/publish_post": "blocked",
      "blog/read_post": "ask",
    })

    const outcome = textOf(await checkPermission(scope, id))
    expect(outcome).toContain("They did not take 2 of the 4 levels")
    expect(outcome).toContain("They also changed 1 tool")

    await expect(
      applyAccessRequest(ctx, id, [], { publicUrl: PUBLIC_URL }),
    ).rejects.toThrow(/already answered/)
    expect(await getAccessProposal(ctx, id)).toBeNull()
  })

  it("refuses a tool the token does not reach, and saves nothing", async () => {
    const { ctx, scope, tokenId, billing } = await setup()
    await propose(scope)
    const id = (await db().permissionRequest.findFirstOrThrow()).id
    const other = await addServer(ctx, "Elsewhere", ["anything"])
    await db().apiToken.update({
      where: { id: tokenId },
      data: {
        allowAllServers: false,
        servers: { create: [{ serverId: billing }] },
      },
    })

    await expect(
      applyAccessRequest(
        ctx,
        id,
        [
          { serverId: billing, tool: "list_invoices", access: "allowed" },
          { serverId: other, tool: "anything", access: "allowed" },
        ],
        { publicUrl: PUBLIC_URL },
      ),
    ).rejects.toThrow(/no longer reaches anything/)
    expect(await db().apiTokenToolAccess.count()).toBe(0)

    // Still open: the page leaves out what the token no longer reaches.
    const proposal = await getAccessProposal(ctx, id)
    expect(proposal?.gone).toBe(1)
    expect(proposal?.proposed).toHaveLength(3)
  })

  it("closes on a no, and for a revoked token", async () => {
    const { ctx, scope, tokenId, billing } = await setup()
    await propose(scope)
    const id = (await db().permissionRequest.findFirstOrThrow()).id

    const declined = await decidePermission(ctx, id, "decline", {
      publicUrl: PUBLIC_URL,
    })
    expect(textOf(declined)).toContain("no tool's level changed")
    expect(textOf(await checkPermission(scope, id))).toContain(
      "no tool's level changed",
    )

    await propose(scope)
    const second = (
      await db().permissionRequest.findFirstOrThrow({
        where: { status: "pending" },
      })
    ).id
    await revokeApiToken(ctx, tokenId)

    await expect(
      applyAccessRequest(
        ctx,
        second,
        [{ serverId: billing, tool: "list_invoices", access: "allowed" }],
        { publicUrl: PUBLIC_URL },
      ),
    ).rejects.toThrow(/no longer valid/)
    expect(
      (
        await db().permissionRequest.findUniqueOrThrow({
          where: { id: second },
        })
      ).status,
    ).toBe("declined")
  })
})
