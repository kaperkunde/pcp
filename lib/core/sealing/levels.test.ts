import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  allowToolFor,
  listTokenAllowances,
  loadToolAllowances,
} from "../allowances"
import { createApiToken } from "../api-tokens"
import { exportVault, readExport, restoreExport } from "../backup"
import { storeTools } from "../catalogue"
import { cleanupIdle, stopCleanup } from "../cleanup/runtime"
import type { VaultContext } from "../context"
import { databaseFile } from "../data-dir"
import { db } from "../db"
import { definitionOf } from "../definitions"
import { levelNameKey } from "../level-names"
import { createServer } from "../servers"
import { scratchDatabase } from "../test-db"
import {
  effectiveAccess,
  listTokenToolAccess,
  loadToolAccess,
  setToolAccess,
  setToolAccessShared,
} from "../tool-access"
import { setToolTier, toolTier } from "../tool-tiers"
import { setupVault } from "../vault"
import { forgetVaultUpkeeps } from "../vault-upkeep"
import { ensureSealed, forgetSealedVaults } from "./convert"

// The tool names on the owner's levels, allowances and tiers are sealed at
// rest (#96): a keyed hash in the old column, the name sealed beside it. Each
// table's rows from before still read, convert on a request that holds the
// key, and survive an export and a restore.

let cleanup: () => Promise<void>
let ctx: VaultContext
let serverId: string
let tokenId: string

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  forgetSealedVaults()
  forgetVaultUpkeeps()
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  ;({ id: serverId } = await createServer(ctx, {
    name: "Postcards",
    url: "https://postcards.example.com/mcp",
    authType: "none",
  }))
  await storeTools(ctx, serverId, [
    { name: "lookup_marker_zeta", inputSchema: { type: "object" } },
    { name: "another_marker_eta", inputSchema: { type: "object" } },
  ])
  ;({ id: tokenId } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    serverIds: [],
  }))
})

afterEach(async () => {
  await stopCleanup()
  await cleanupIdle()
  forgetSealedVaults()
  await cleanup()
})

async function onDisk(text: string): Promise<boolean> {
  await db().$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)")
  return readFileSync(databaseFile()).includes(Buffer.from(text, "utf8"))
}

const HASH = /^[0-9a-f]{64}$/

type Raw = { tool_name: string; sealed: Uint8Array | null }

function raw(table: string): Promise<Raw[]> {
  return db().$queryRawUnsafe<Raw[]>(
    `SELECT "tool_name", "sealed" FROM "${table}" ORDER BY "tool_name"`,
  )
}

const key = (name: string) => `${serverId}/${name}`

describe("a token's own levels", () => {
  it("seal the tool's name, are found by it, and stay one row per tool", async () => {
    await setToolAccess(ctx, tokenId, serverId, "lookup_marker_zeta", "allowed")
    await setToolAccess(ctx, tokenId, serverId, "lookup_marker_zeta", "blocked")

    const rows = await raw("api_token_tool_access")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tool_name).toBe(
      levelNameKey(ctx, serverId, "lookup_marker_zeta"),
    )
    expect(rows[0]!.sealed).not.toBeNull()
    expect(await onDisk("lookup_marker_zeta")).toBe(false)

    const stored = await loadToolAccess(ctx, tokenId)
    expect(effectiveAccess(stored, serverId, "lookup_marker_zeta")).toBe(
      "blocked",
    )
    expect(effectiveAccess(stored, serverId, "another_marker_eta")).toBe("ask")
    expect(
      (await listTokenToolAccess(ctx, tokenId))[0]!.tools.find(
        (tool) => tool.name === "lookup_marker_zeta",
      ),
    ).toMatchObject({ own: "blocked", access: "blocked" })

    // The hash is what is unique: a second row of it is refused.
    await expect(
      db().apiTokenToolAccess.create({
        data: {
          tokenId,
          serverId,
          toolName: levelNameKey(ctx, serverId, "lookup_marker_zeta"),
          access: "allowed",
        },
      }),
    ).rejects.toThrow()
  })

  it("hash the same name on two servers apart", async () => {
    const other = (
      await createServer(ctx, {
        name: "Other",
        url: "https://other.example.com/mcp",
        authType: "none",
      })
    ).id

    expect(levelNameKey(ctx, serverId, "lookup_marker_zeta")).not.toBe(
      levelNameKey(ctx, other, "lookup_marker_zeta"),
    )
  })

  it("read a row from before, which a write replaces and a request seals", async () => {
    await db().apiTokenToolAccess.create({
      data: {
        tokenId,
        serverId,
        toolName: "lookup_marker_zeta",
        access: "blocked",
      },
    })
    await db().apiTokenToolAccess.create({
      data: {
        tokenId,
        serverId,
        toolName: "another_marker_eta",
        access: "allowed",
      },
    })

    let stored = await loadToolAccess(ctx, tokenId)
    expect(stored.own.get(key("lookup_marker_zeta"))).toBe("blocked")
    expect(await onDisk("another_marker_eta")).toBe(true)

    // A write over one from before leaves one row, sealed.
    await setToolAccess(ctx, tokenId, serverId, "lookup_marker_zeta", "allowed")
    expect(await db().apiTokenToolAccess.count()).toBe(2)

    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("another_marker_eta")).toBe(false)
    expect(await onDisk("lookup_marker_zeta")).toBe(false)
    const rows = await raw("api_token_tool_access")
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => HASH.test(row.tool_name) && row.sealed)).toBe(
      true,
    )

    stored = await loadToolAccess(ctx, tokenId)
    expect(stored.own.get(key("lookup_marker_zeta"))).toBe("allowed")
    expect(stored.own.get(key("another_marker_eta"))).toBe("allowed")
  })
})

describe("levels for all tokens", () => {
  it("seal the tool's name, and untick by it", async () => {
    await setToolAccess(ctx, tokenId, serverId, "lookup_marker_zeta", "allowed")
    await setToolAccessShared(
      ctx,
      tokenId,
      serverId,
      "lookup_marker_zeta",
      true,
    )

    const rows = await raw("vault_tool_access")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tool_name: levelNameKey(ctx, serverId, "lookup_marker_zeta"),
    })
    expect(rows[0]!.sealed).not.toBeNull()
    expect(await onDisk("lookup_marker_zeta")).toBe(false)
    expect(
      (await loadToolAccess(ctx, tokenId)).shared.get(
        key("lookup_marker_zeta"),
      ),
    ).toBe("allowed")

    await setToolAccessShared(
      ctx,
      tokenId,
      serverId,
      "lookup_marker_zeta",
      false,
    )
    expect(await db().vaultToolAccess.count()).toBe(0)
  })

  it("read a row from before, and seal it on a request", async () => {
    await db().vaultToolAccess.create({
      data: {
        vaultId: ctx.vaultId,
        serverId,
        toolName: "lookup_marker_zeta",
        access: "allowed",
      },
    })

    const read = async () =>
      effectiveAccess(
        await loadToolAccess(ctx, tokenId),
        serverId,
        "lookup_marker_zeta",
      )
    expect(await read()).toBe("allowed")

    // Unticking finds the row from before by its plain name too.
    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("lookup_marker_zeta")).toBe(false)
    expect(await read()).toBe("allowed")
    const rows = await raw("vault_tool_access")
    expect(rows[0]!.tool_name).toMatch(HASH)
    expect(rows[0]!.sealed).not.toBeNull()
  })

  it("are unticked from a row from before", async () => {
    await db().vaultToolAccess.create({
      data: {
        vaultId: ctx.vaultId,
        serverId,
        toolName: "lookup_marker_zeta",
        access: "allowed",
      },
    })

    await setToolAccessShared(
      ctx,
      tokenId,
      serverId,
      "lookup_marker_zeta",
      false,
    )
    expect(await db().vaultToolAccess.count()).toBe(0)
    expect(
      (await loadToolAccess(ctx, tokenId)).own.get(key("lookup_marker_zeta")),
    ).toBe("allowed")
  })
})

describe("allowances", () => {
  it("seal the tool's name, list it, and stay one row per tool", async () => {
    const now = new Date()
    await allowToolFor(ctx, tokenId, serverId, "lookup_marker_zeta", 15, now)
    await allowToolFor(ctx, tokenId, serverId, "lookup_marker_zeta", 60, now)

    const rows = await raw("api_token_tool_allowance")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tool_name).toMatch(HASH)
    expect(rows[0]!.sealed).not.toBeNull()
    expect(await onDisk("lookup_marker_zeta")).toBe(false)
    expect([...(await loadToolAllowances(ctx, tokenId, now)).keys()]).toEqual([
      key("lookup_marker_zeta"),
    ])
    expect(await listTokenAllowances(ctx, tokenId, now)).toMatchObject([
      { kind: "tool", toolName: "lookup_marker_zeta", serverId },
    ])
  })

  it("read a row from before, and seal it on a request", async () => {
    const until = new Date(Date.now() + 3_600_000)
    await db().apiTokenToolAllowance.create({
      data: { tokenId, serverId, toolName: "lookup_marker_zeta", until },
    })

    expect([...(await loadToolAllowances(ctx, tokenId)).keys()]).toEqual([
      key("lookup_marker_zeta"),
    ])
    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("lookup_marker_zeta")).toBe(false)
    expect([...(await loadToolAllowances(ctx, tokenId)).keys()]).toEqual([
      key("lookup_marker_zeta"),
    ])
    expect((await raw("api_token_tool_allowance"))[0]!.tool_name).toMatch(HASH)
  })
})

describe("the owner's tiers", () => {
  it("seal the tool's name, and are found and replaced by it", async () => {
    await setToolTier(ctx, serverId, "lookup_marker_zeta", "write")
    await setToolTier(ctx, serverId, "lookup_marker_zeta", "destructive")

    const rows = await raw("tool_tier")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tool_name).toMatch(HASH)
    expect(rows[0]!.sealed).not.toBeNull()
    expect(await onDisk("lookup_marker_zeta")).toBe(false)
    expect(await toolTier(ctx, serverId, "lookup_marker_zeta")).toBe(
      "destructive",
    )

    await setToolTier(ctx, serverId, "lookup_marker_zeta", null)
    expect(await db().toolTier.count()).toBe(0)
  })

  it("read a row from before, and seal it on a request", async () => {
    const definitionId = (await definitionOf(ctx, serverId))!.id
    await db().toolTier.create({
      data: {
        id: randomUUID(),
        vaultId: ctx.vaultId,
        definitionId,
        toolName: "lookup_marker_zeta",
        tier: "read",
      },
    })

    expect(await toolTier(ctx, serverId, "lookup_marker_zeta")).toBe("read")
    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("lookup_marker_zeta")).toBe(false)
    expect(await toolTier(ctx, serverId, "lookup_marker_zeta")).toBe("read")

    // Choosing again replaces the converted row.
    await setToolTier(ctx, serverId, "lookup_marker_zeta", "write")
    expect(await db().toolTier.count()).toBe(1)
    expect(await toolTier(ctx, serverId, "lookup_marker_zeta")).toBe("write")
  })
})

describe("an export", () => {
  async function everything() {
    await setToolAccess(ctx, tokenId, serverId, "lookup_marker_zeta", "blocked")
    await setToolAccessShared(
      ctx,
      tokenId,
      serverId,
      "another_marker_eta",
      false,
    )
    await db().vaultToolAccess.create({
      data: {
        vaultId: ctx.vaultId,
        serverId,
        toolName: levelNameKey(ctx, serverId, "another_marker_eta"),
        access: "allowed",
      },
    })
    await setToolTier(ctx, serverId, "lookup_marker_zeta", "write")
  }

  const read = async () => ({
    levels: (await loadToolAccess(ctx, tokenId)).own.get(
      key("lookup_marker_zeta"),
    ),
    tier: await toolTier(ctx, serverId, "lookup_marker_zeta"),
  })

  it("carries the sealed names, never the plain ones, and restores them", async () => {
    await everything()
    const file = await exportVault(ctx, "export password 1234")
    const { payload } = await readExport(file, "export password 1234")

    expect(JSON.stringify(payload)).not.toContain("lookup_marker_zeta")
    expect(payload.tables.apiTokenToolAccess[0]!.sealed).not.toBeNull()
    expect(payload.tables.toolTiers[0]!.sealed).not.toBeNull()

    await restoreExport(
      payload,
      { into: "vault", ctx },
      { restoreHostSettings: false },
    )
    expect(await read()).toEqual({ levels: "blocked", tier: "write" })
  })

  it("from before has no sealed names, which read and convert", async () => {
    await db().apiTokenToolAccess.create({
      data: {
        tokenId,
        serverId,
        toolName: "lookup_marker_zeta",
        access: "blocked",
      },
    })
    await db().toolTier.create({
      data: {
        id: randomUUID(),
        vaultId: ctx.vaultId,
        serverId,
        toolName: "lookup_marker_zeta",
        tier: "write",
      },
    })
    const file = await exportVault(ctx, "export password 1234")
    const { payload } = await readExport(file, "export password 1234")

    // The file as an older PCP wrote it: these rows have no sealed column.
    const tables = payload.tables as unknown as Record<
      string,
      Array<Record<string, unknown>>
    >

    for (const table of [
      "apiTokenToolAccess",
      "vaultToolAccess",
      "toolTiers",
    ]) {
      for (const row of tables[table]!) {
        delete row.sealed
      }
    }

    for (const row of tables.permissionRequests!) {
      delete row.toolSealed
    }

    const older = payload

    await restoreExport(
      older,
      { into: "vault", ctx },
      { restoreHostSettings: false },
    )
    expect(await read()).toEqual({ levels: "blocked", tier: "write" })
    forgetSealedVaults()
    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("lookup_marker_zeta")).toBe(false)
    expect(await read()).toEqual({ levels: "blocked", tier: "write" })
  })
})
