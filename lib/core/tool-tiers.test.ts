import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { storeTools } from "./catalogue"
import type { VaultContext } from "./context"
import { db } from "./db"
import { detachServer } from "./definitions"
import { chooseOwnToolTier, listOwnToolTiers } from "./own-tool-tiers"
import { createServer } from "./servers"
import { scratchDatabase } from "./test-db"
import {
  callEntryFor,
  effectiveTier,
  highestTier,
  loadToolTiers,
  mergeToolTiers,
  readOwnToolTiers,
  runEntryFor,
  setToolTier,
  tierAllows,
  tierAnnotations,
  tierBelowCalls,
  tierFromAnnotations,
  toolTier,
  toolTierInfo,
} from "./tool-tiers"
import { setupVault } from "./vault"

// One truth for how much a tool can do: the owner's choice, else a
// wrapper's calls, else the annotations as MCP reads them, else Destructive.

describe("a tier from annotations", () => {
  it("reads MCP's hints with MCP's defaults: no hints is Destructive", () => {
    expect(tierFromAnnotations(undefined)).toBe("destructive")
    expect(tierFromAnnotations({})).toBe("destructive")
    expect(tierFromAnnotations({ readOnlyHint: true })).toBe("read")
    // destructiveHint means nothing for a tool that only reads.
    expect(
      tierFromAnnotations({ readOnlyHint: true, destructiveHint: true }),
    ).toBe("read")
    expect(tierFromAnnotations({ readOnlyHint: false })).toBe("destructive")
    expect(
      tierFromAnnotations({ readOnlyHint: false, destructiveHint: false }),
    ).toBe("write")
    // readOnlyHint left out is false, as MCP has it.
    expect(tierFromAnnotations({ destructiveHint: false })).toBe("write")
    expect(tierFromAnnotations({ destructiveHint: true })).toBe("destructive")
    expect(tierFromAnnotations("nonsense")).toBe("destructive")
  })

  it("puts the owner's choice first, then what is derived, then the hints", () => {
    expect(
      effectiveTier({
        override: "write",
        derived: "read",
        annotations: { readOnlyHint: true },
      }),
    ).toBe("write")
    expect(
      effectiveTier({
        derived: "destructive",
        annotations: { readOnlyHint: true },
      }),
    ).toBe("destructive")
    expect(effectiveTier({ annotations: { readOnlyHint: true } })).toBe("read")
    expect(effectiveTier({})).toBe("destructive")
  })

  it("orders the tiers, and names each one's entry tools", () => {
    expect(highestTier([])).toBe("read")
    expect(highestTier(["read", "destructive", "write"])).toBe("destructive")
    expect(tierAllows("write", "read")).toBe(true)
    expect(tierAllows("write", "write")).toBe(true)
    expect(tierAllows("write", "destructive")).toBe(false)
    expect(tierAllows("read", "write")).toBe(false)
    expect(callEntryFor("write")).toBe("call_tool_write")
    expect(runEntryFor("read")).toBe("run_code_read")
  })

  it("says a tier as the hints PCP advertises, keeping the other two", () => {
    expect(
      tierAnnotations("read", { idempotentHint: true, openWorldHint: false }),
    ).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
    expect(
      tierAnnotations("write", { idempotentHint: false, openWorldHint: true }),
    ).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(
      tierAnnotations("destructive", {
        idempotentHint: false,
        openWorldHint: true,
      }),
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true })
  })

  it("notices a wrapper tool's choice below its calls only when they came to less before", () => {
    const info = {
      tier: "read" as const,
      derived: "write" as const,
      override: "read" as const,
    }
    expect(tierBelowCalls({ ...info, seen: "read" })).toBe(true)
    expect(tierBelowCalls({ ...info, seen: null })).toBe(true)
    // The owner chose Read while the calls were Write already.
    expect(tierBelowCalls({ ...info, seen: "write" })).toBe(false)
    expect(
      tierBelowCalls({ ...info, override: "destructive", seen: "read" }),
    ).toBe(false)
  })
})

describe("the owner's tiers", () => {
  let cleanup: () => Promise<void>
  let ctx: VaultContext

  beforeEach(async () => {
    ;({ cleanup } = await scratchDatabase())
    ctx = await setupVault({
      name: "Ada",
      password: "correct horse battery staple",
    })
  })

  afterEach(async () => {
    await cleanup()
  })

  async function server(name: string, definitionId?: string | null) {
    const { id } = await createServer(ctx, {
      name,
      url: `https://${name.toLowerCase()}.example.com/mcp`,
      authType: "none",
    })

    if (definitionId) {
      await db().mcpServer.update({ where: { id }, data: { definitionId } })
    }

    await storeTools(ctx, id, [
      {
        name: "list",
        description: "Lists.",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
      { name: "burn", description: "Burns.", inputSchema: { type: "object" } },
    ])

    return id
  }

  async function definitionOf(id: string) {
    return (await db().mcpServer.findUniqueOrThrow({ where: { id } }))
      .definitionId!
  }

  it("is the definition's, so every server of it takes it, and outlives a refresh without the tool", async () => {
    const first = await server("First")
    const second = await server("Second", await definitionOf(first))

    await setToolTier(ctx, second, "burn", "write")
    expect(await toolTier(first, "burn")).toBe("write")
    expect(await toolTier(second, "burn")).toBe("write")
    expect(await toolTierInfo(first, "burn")).toEqual({
      tier: "write",
      derived: "destructive",
      override: "write",
      seen: null,
    })

    // The tool drops out of a refresh and comes back: the choice stays.
    await storeTools(ctx, first, [
      { name: "list", description: "Lists.", inputSchema: { type: "object" } },
    ])
    expect(await db().toolTier.count()).toBe(1)
    await storeTools(ctx, first, [
      { name: "burn", description: "Burns.", inputSchema: { type: "object" } },
    ])
    expect(await toolTier(first, "burn")).toBe("write")

    const tiers = await loadToolTiers(ctx.vaultId, [
      { id: first, tools: [{ name: "burn" }, { name: "gone" }] },
    ])
    expect(tiers.get(`${first}/burn`)?.tier).toBe("write")
    // A tool PCP does not know: Destructive.
    expect(tiers.get(`${first}/gone`)?.tier).toBe("destructive")

    await setToolTier(ctx, first, "burn", null)
    expect(await toolTier(second, "burn")).toBe("destructive")
  })

  it("stays with a server that gets a definition of its own, and merges with the kept one's winning", async () => {
    const first = await server("First")
    const second = await server("Second", await definitionOf(first))
    await setToolTier(ctx, first, "burn", "write")

    await detachServer(ctx, second)
    expect(await toolTier(second, "burn")).toBe("write")
    await setToolTier(ctx, second, "burn", "read")
    await setToolTier(ctx, second, "list", "write")
    expect(await toolTier(first, "burn")).toBe("write")

    await mergeToolTiers(ctx.vaultId, await definitionOf(first), [
      await definitionOf(second),
    ])
    const kept = await db().toolTier.findMany({
      where: { definitionId: await definitionOf(first) },
      orderBy: { toolName: "asc" },
    })
    expect(kept.map((row) => [row.toolName, row.tier])).toEqual([
      ["burn", "write"],
      ["list", "write"],
    ])
  })

  it("refuses a tool the server does not have, and a server of another vault", async () => {
    const id = await server("First")
    await expect(setToolTier(ctx, id, "nothing", "read")).rejects.toThrow(
      /nothing/,
    )
    await expect(
      setToolTier({ ...ctx, vaultId: "elsewhere" }, id, "list", "read"),
    ).rejects.toThrow()
  })

  it("keeps PCP's own tools' tiers in the vault's setting, for tools PCP has", async () => {
    const own = await listOwnToolTiers(ctx)
    const names = own.map((tool) => tool.name)
    expect(names).toEqual(
      expect.arrayContaining([
        "call_tool_read",
        "call_tool_write",
        "call_tool_destructive",
        "run_code_read",
        "run_code_write",
        "run_code_destructive",
        "search",
      ]),
    )
    expect(own.find((tool) => tool.name === "call_tool_destructive")).toEqual(
      expect.objectContaining({ derived: "destructive", override: null }),
    )

    await chooseOwnToolTier(ctx, "call_tool_destructive", "write")
    expect(await readOwnToolTiers(ctx)).toEqual({
      call_tool_destructive: "write",
    })
    expect(
      (await listOwnToolTiers(ctx)).find(
        (tool) => tool.name === "call_tool_destructive",
      ),
    ).toMatchObject({ derived: "destructive", override: "write" })

    await expect(chooseOwnToolTier(ctx, "call_tool", "read")).rejects.toThrow(
      /no tool called call_tool/,
    )
    await chooseOwnToolTier(ctx, "call_tool_destructive", null)
    expect(await readOwnToolTiers(ctx)).toEqual({})
  })
})
