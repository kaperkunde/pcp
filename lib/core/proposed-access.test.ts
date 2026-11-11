import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, revokeApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import { createEndpoint } from "./endpoints"
import {
  applyPendingAccess,
  checkChosenAccess,
  proposeToolAccess,
  resolveAccessRules,
  settleChosenAccess,
} from "./proposed-access"
import { getServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { writeToolAccess } from "./tool-access"
import { toolTier } from "./tool-tiers"
import { syncServerTools } from "./upstream"
import { setupVault } from "./vault"

// Levels and tiers an assistant proposes with a new or changed server: read
// against its tools where they are known, kept as patterns where they are
// not, and written only as the owner left them, at once or on the first
// read of its tools.

const TOOLS = [
  { name: "list_pets" },
  { name: "get_pet" },
  { name: "add_pet" },
  { name: "delete_pet" },
]

describe("proposeToolAccess", () => {
  it("is nothing when the assistant sent nothing", () => {
    expect(proposeToolAccess(undefined, { tools: TOOLS, label: "X" })).toBe(
      null,
    )
  })

  it("resolves names and patterns to one rule per known tool, later entries winning field by field", () => {
    expect(
      proposeToolAccess(
        [
          { access: "ask", tier: "write" },
          { tools: ["list_*", "get_pet"], access: "allowed", tier: "read" },
          { tools: ["delete_pet"], tier: "destructive" },
        ],
        { tools: TOOLS, label: "The API Pets" },
      ),
    ).toEqual({
      tools: TOOLS,
      rules: [
        { pattern: "list_pets", access: "allowed", tier: "read" },
        { pattern: "get_pet", access: "allowed", tier: "read" },
        { pattern: "add_pet", access: "ask", tier: "write" },
        { pattern: "delete_pet", access: "ask", tier: "destructive" },
      ],
    })
  })

  it("refuses a name that matches none of its tools, and one the token has blocked", () => {
    expect(() =>
      proposeToolAccess([{ tools: ["send_*"], access: "allowed" }], {
        tools: TOOLS,
        label: "The API Pets",
      }),
    ).toThrow(/The API Pets has no tool matching "send_\*"/)
    expect(() =>
      proposeToolAccess([{ tools: ["delete_pet"], access: "allowed" }], {
        tools: TOOLS,
        hidden: new Set(["delete_pet"]),
        label: "The wrapper",
      }),
    ).toThrow(/no tool matching "delete_pet"/)
    // A pattern never reaches a blocked tool.
    expect(
      proposeToolAccess([{ access: "allowed" }], {
        tools: TOOLS,
        hidden: new Set(["delete_pet"]),
        label: "The wrapper",
      })?.rules.map((rule) => rule.pattern),
    ).toEqual(["list_pets", "get_pet", "add_pet"])
  })

  it("keeps patterns as they are where the tools are not known yet", () => {
    expect(
      proposeToolAccess(
        [
          { tools: ["search_*", "get_issue"], access: "allowed" },
          { tools: ["get_issue"], tier: "read" },
        ],
        { label: "The server Linear" },
      ),
    ).toEqual({
      rules: [
        { pattern: "search_*", access: "allowed" },
        { pattern: "get_issue", access: "allowed", tier: "read" },
      ],
    })
  })

  it("refuses an entry that sets nothing, and a name with spaces", () => {
    expect(() => proposeToolAccess([{ tools: ["x"] }], { label: "X" })).toThrow(
      /an access level, a tier, or both/,
    )
    expect(() =>
      proposeToolAccess([{ tools: ["two words"], access: "ask" }], {
        label: "X",
      }),
    ).toThrow(/one word/)
  })
})

describe("checkChosenAccess", () => {
  it("takes only the request's tools where they are known, dropping rows that set nothing", () => {
    const proposal = { tools: TOOLS, rules: [] }

    expect(
      checkChosenAccess(proposal, [
        { pattern: "list_pets", access: "allowed" },
        { pattern: "add_pet", access: "", tier: "" },
        { pattern: "delete_pet", tier: "destructive" },
      ]),
    ).toEqual([
      { pattern: "list_pets", access: "allowed" },
      { pattern: "delete_pet", tier: "destructive" },
    ])
    expect(() =>
      checkChosenAccess(proposal, [{ pattern: "list_*", access: "allowed" }]),
    ).toThrow(/not one of its tools/)
    expect(() =>
      checkChosenAccess(proposal, [{ pattern: "list_pets", access: "root" }]),
    ).toThrow()
    expect(() => checkChosenAccess(proposal, "all")).toThrow(/as a list/)
  })

  it("takes the owner's own patterns where the tools are not known", () => {
    expect(
      checkChosenAccess({ rules: [] }, [
        { pattern: " read_* ", access: "allowed", tier: "read" },
      ]),
    ).toEqual([{ pattern: "read_*", access: "allowed", tier: "read" }])
  })
})

describe("resolveAccessRules", () => {
  it("lets an exact name override a pattern before it", () => {
    expect(
      resolveAccessRules(
        [
          { pattern: "*", access: "allowed" },
          { pattern: "delete_pet", access: "ask", tier: "destructive" },
        ],
        ["list_pets", "delete_pet"],
      ),
    ).toEqual(
      new Map([
        ["list_pets", { access: "allowed" }],
        ["delete_pet", { access: "ask", tier: "destructive" }],
      ]),
    )
  })
})

describe("writing what the owner saved", () => {
  let cleanup: () => Promise<void>
  let ctx: VaultContext
  let tokenId: string
  const PETS = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Pets" },
    servers: [{ url: "https://api.example.com/v1" }],
    paths: {
      "/pets": {
        get: { operationId: "listPets" },
        post: { operationId: "addPet" },
      },
    },
  })

  beforeEach(async () => {
    ;({ cleanup } = await scratchDatabase())
    ctx = await setupVault({
      name: "Ada",
      password: "correct horse battery staple",
    })
    ;({ id: tokenId } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
      serverIds: [],
    }))
  })

  afterEach(async () => {
    await cleanup()
  })

  async function endpoint() {
    const { id } = await createEndpoint(ctx, {
      name: "Pets",
      baseUrl: "https://api.example.com/v1",
      specSource: "upload",
      specText: PETS,
      readOnly: false,
      authType: "none",
    })
    return id
  }

  async function levels(serverId: string) {
    return (
      await db().apiTokenToolAccess.findMany({
        where: { tokenId, serverId },
        orderBy: { toolName: "asc" },
      })
    ).map((row) => [row.toolName, row.access])
  }

  it("writes the token's levels and the tiers at once to a server that has its tools", async () => {
    const id = await endpoint()

    const told = await settleChosenAccess(ctx, {
      serverId: id,
      tokenId,
      rules: [
        { pattern: "list*", access: "allowed", tier: "read" },
        { pattern: "addPet", access: "blocked" },
      ],
    })

    expect(await levels(id)).toEqual([
      ["addPet", "blocked"],
      ["listPets", "allowed"],
    ])
    expect(await toolTier(ctx, id, "listPets")).toBe("read")
    expect(told).toMatch(/set this token's level for 2 tools/)
    expect(
      (await db().mcpServer.findUniqueOrThrow({ where: { id } })).pendingAccess,
    ).toBeNull()
  })

  it("keeps the rules for a server with no tools yet, and applies them once on the first read that finds some", async () => {
    const id = await endpoint()
    await db().mcpTool.deleteMany({ where: { serverId: id } })

    const told = await settleChosenAccess(ctx, {
      serverId: id,
      tokenId,
      rules: [{ pattern: "*", access: "allowed" }],
    })

    expect(told).toMatch(/apply once, to the tools PCP first reads/)
    expect(await levels(id)).toEqual([])

    await syncServerTools(ctx, await getServer(ctx, id), {
      publicUrl: "http://localhost:3000",
    })

    expect(await levels(id)).toEqual([
      ["addPet", "allowed"],
      ["listPets", "allowed"],
    ])
    expect(
      (await db().mcpServer.findUniqueOrThrow({ where: { id } })).pendingAccess,
    ).toBeNull()

    // Applied once: a level the owner changes since is left alone.
    await writeToolAccess(tokenId, id, "addPet", "ask")
    await syncServerTools(ctx, await getServer(ctx, id), {
      publicUrl: "http://localhost:3000",
    })
    expect(await levels(id)).toEqual([["listPets", "allowed"]])
  })

  it("leaves a tool the token has blocked since, and gives a revoked token nothing", async () => {
    const id = await endpoint()
    await db().mcpServer.update({
      where: { id },
      data: {
        pendingAccess: JSON.stringify({
          tokenId,
          rules: [{ pattern: "*", access: "allowed" }],
        }),
      },
    })
    await writeToolAccess(tokenId, id, "addPet", "blocked")

    await applyPendingAccess(ctx, id)

    expect(await levels(id)).toEqual([
      ["addPet", "blocked"],
      ["listPets", "allowed"],
    ])

    const other = await endpoint()
    await db().mcpServer.update({
      where: { id: other },
      data: {
        pendingAccess: JSON.stringify({
          tokenId,
          rules: [{ pattern: "*", access: "allowed" }],
        }),
      },
    })
    await revokeApiToken(ctx, tokenId)

    await applyPendingAccess(ctx, other)

    expect(await levels(other)).toEqual([])
    expect(
      (await db().mcpServer.findUniqueOrThrow({ where: { id: other } }))
        .pendingAccess,
    ).toBeNull()
  })
})
