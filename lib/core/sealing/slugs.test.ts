import { readFileSync } from "node:fs"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { cleanupIdle, stopCleanup } from "../cleanup/runtime"
import type { VaultContext } from "../context"
import { databaseFile } from "../data-dir"
import { db } from "../db"
import { definitionOf } from "../definitions"
import { sealJson } from "../sealed"
import {
  createServer,
  getServer,
  getServerBySlug,
  renameServerSlug,
} from "../servers"
import { readServerMeta, SERVER_META_SELECT, writeServer } from "../server-meta"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { forgetVaultUpkeeps } from "../vault-upkeep"
import { ensureSealed, forgetSealedVaults } from "./convert"

// A server's and a definition's short name are sealed at rest (#96, part
// 3): found by a keyed hash, unique by it, and read from the old plain
// column until the vault's rows are sealed.

let cleanup: () => Promise<void>
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  forgetSealedVaults()
  forgetVaultUpkeeps()
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
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

async function addServer(name: string): Promise<string> {
  return (
    await createServer(ctx, {
      name,
      url: "https://slug.example/mcp",
      authType: "none",
    })
  ).id
}

type RawSlug = { slug: string; slug_key: string | null }

describe("short names", () => {
  it("seals a server's and its definition's short name, and finds it by its hash", async () => {
    const id = await addServer("Slugmarker Alpha")

    expect(await onDisk("slugmarker-alpha")).toBe(false)
    expect(
      await db().$queryRawUnsafe<RawSlug[]>(
        `SELECT "slug", "slug_key" FROM "mcp_server"`,
      ),
    ).toEqual([{ slug: "", slug_key: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect(
      await db().$queryRawUnsafe<RawSlug[]>(
        `SELECT "slug", "slug_key" FROM "server_definition"`,
      ),
    ).toEqual([{ slug: "", slug_key: expect.stringMatching(/^[0-9a-f]{64}$/) }])

    expect((await getServer(ctx, id)).slug).toBe("slugmarker-alpha")
    expect((await getServerBySlug(ctx, "slugmarker-alpha"))?.id).toBe(id)
    expect(await getServerBySlug(ctx, "slugmarker")).toBeNull()
    expect((await definitionOf(ctx, id))?.slug).toBe("slugmarker-alpha")
  })

  it("keeps short names unique by their hash", async () => {
    const first = await addServer("Docs")
    const second = await addServer("Docs")

    expect((await getServer(ctx, second)).slug).toBe("docs-2")
    await expect(renameServerSlug(ctx, second, "docs")).rejects.toThrow(
      /already called docs/,
    )
    // Past the checks, the index itself refuses it.
    await expect(writeServer(ctx, second, { slug: "docs" })).rejects.toThrow()
    expect((await getServer(ctx, first)).slug).toBe("docs")

    await renameServerSlug(ctx, second, "notes")
    expect((await getServerBySlug(ctx, "notes"))?.id).toBe(second)
    expect(await getServerBySlug(ctx, "docs-2")).toBeNull()
  })

  it("reads a short name from before, counts it as taken, and seals it on a request", async () => {
    const id = await addServer("Before")
    await db().$executeRawUnsafe(
      `UPDATE "mcp_server" SET "name" = 'Before', "slug" = 'old-slug', "slug_key" = NULL, "url" = 'https://slug.example/mcp', "meta" = NULL WHERE "id" = ?`,
      id,
    )

    expect((await getServerBySlug(ctx, "old-slug"))?.id).toBe(id)
    // A new server does not take the name a row from before still has.
    const other = await addServer("Old slug")
    expect((await getServer(ctx, other)).slug).toBe("old-slug-2")

    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("old-slug")).toBe(false)
    expect((await getServerBySlug(ctx, "old-slug"))?.id).toBe(id)
    expect(
      await db().$queryRawUnsafe<RawSlug[]>(
        `SELECT "slug" FROM "mcp_server" WHERE "id" = ?`,
        id,
      ),
    ).toEqual([{ slug: "" }])
  })

  it("seals the short name of a row whose other values were sealed before it was", async () => {
    const id = await addServer("Midway")
    const row = await db().mcpServer.findUniqueOrThrow({
      where: { id },
      select: SERVER_META_SELECT,
    })
    const { slug: _slug, ...withoutSlug } = readServerMeta(ctx, row)
    await db().mcpServer.update({
      where: { id },
      data: {
        meta: sealJson(ctx.dek, `mcp_server:${id}:meta`, withoutSlug),
        plainSlug: "mid-slug",
        slugKey: null,
      },
    })

    expect(await getServer(ctx, id)).toMatchObject({
      name: "Midway",
      slug: "mid-slug",
    })
    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("mid-slug")).toBe(false)
    expect((await getServerBySlug(ctx, "mid-slug"))?.id).toBe(id)
  })

  it("gives a definition whose short name another took meanwhile the next free one", async () => {
    const first = await addServer("Docs")
    const second = await addServer("Notes")
    const taken = (await definitionOf(ctx, first))!
    const clashing = (await definitionOf(ctx, second))!
    // As a restore with no key leaves it: the plain short name the other,
    // sealed, definition has.
    await db().$executeRawUnsafe(
      `UPDATE "server_definition" SET "name" = 'Notes', "slug" = 'docs', "slug_key" = NULL, "description" = '', "meta" = NULL WHERE "id" = ?`,
      clashing.id,
    )

    expect(await ensureSealed(ctx)).toBe(true)
    expect((await definitionOf(ctx, first))?.slug).toBe(taken.slug)
    expect((await definitionOf(ctx, second))?.slug).toBe("docs-2")
  })

  it("seals the rest of a table when one row of it cannot be", async () => {
    const sealed: string[] = []
    const row =
      (name: string, fails = false) =>
      async () => {
        if (fails) throw new Error(`${name} does not read`)
        sealed.push(name)
        return true
      }

    expect(
      await ensureSealed(ctx, {
        converters: [
          {
            table: "test",
            read: async () => [row("first", true), row("second"), row("third")],
          },
        ],
      }),
    ).toBe(false)
    expect(sealed).toEqual(["second", "third"])
  })
})
