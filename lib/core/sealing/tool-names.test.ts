import { readFileSync } from "node:fs"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { storeTools } from "../catalogue"
import { cleanupIdle, stopCleanup } from "../cleanup/runtime"
import type { VaultContext } from "../context"
import { databaseFile } from "../data-dir"
import { db } from "../db"
import { sealJson } from "../sealed"
import { createServer, getServer, setToolDescription } from "../servers"
import { scratchDatabase } from "../test-db"
import {
  findTool,
  readToolAbout,
  TOOL_ABOUT_SELECT,
  toolNameKey,
} from "../tool-rows"
import { setupVault } from "../vault"
import { forgetVaultUpkeeps } from "../vault-upkeep"
import { ensureSealed, forgetSealedVaults } from "./convert"

// A tool's name is sealed at rest (#96, part 3): found by a keyed hash of
// its server and the name, unique per server by it, and read from the old
// plain column until the vault's rows are sealed.

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
  const { id } = await createServer(ctx, {
    name,
    url: "https://tools.example/mcp",
    authType: "none",
  })
  await storeTools(ctx, id, [
    { name: "lookup_marker_zeta", inputSchema: { type: "object" } },
    { name: "another_marker_eta", inputSchema: { type: "object" } },
  ])
  return id
}

type RawName = { name: string; name_key: string | null }

describe("tool names", () => {
  it("seals a tool's name, and finds it by its hash", async () => {
    const id = await addServer("Tools")

    expect(await onDisk("lookup_marker_zeta")).toBe(false)
    expect(
      await db().$queryRawUnsafe<RawName[]>(
        `SELECT "name", "name_key" FROM "mcp_tool"`,
      ),
    ).toEqual([
      { name: "", name_key: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { name: "", name_key: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ])
    expect((await getServer(ctx, id)).tools.map((tool) => tool.name)).toEqual([
      "another_marker_eta",
      "lookup_marker_zeta",
    ])
    expect((await findTool(ctx, id, "lookup_marker_zeta"))?.name).toBe(
      "lookup_marker_zeta",
    )
    expect(await findTool(ctx, id, "lookup_marker")).toBeNull()

    // The owner's wording reaches the tool it names, found by its hash.
    await setToolDescription(ctx, id, "lookup_marker_zeta", "Mine")
    expect(
      (await findTool(ctx, id, "lookup_marker_zeta"))?.descriptionOverride,
    ).toBe("Mine")
  })

  it("hashes the same name on two servers apart, and keeps it unique on one", async () => {
    const first = await addServer("First")
    const second = await addServer("Second")
    const keys = await db().mcpTool.findMany({
      select: { nameKey: true },
    })

    expect(new Set(keys.map((row) => row.nameKey)).size).toBe(4)
    expect(toolNameKey(ctx, first, "lookup_marker_zeta")).not.toBe(
      toolNameKey(ctx, second, "lookup_marker_zeta"),
    )

    // A second tool of the same name on the same server is refused by the
    // index itself.
    await expect(
      db().mcpTool.create({
        data: {
          id: "duplicate",
          serverId: first,
          plainName: "",
          nameKey: toolNameKey(ctx, first, "lookup_marker_zeta"),
          plainInputSchema: "",
        },
      }),
    ).rejects.toThrow()

    // Reading the tools again keeps each row and its id.
    const before = await findTool(ctx, first, "lookup_marker_zeta")
    await storeTools(ctx, first, [
      { name: "lookup_marker_zeta", inputSchema: { type: "object" } },
    ])
    expect((await findTool(ctx, first, "lookup_marker_zeta"))?.id).toBe(
      before!.id,
    )
    expect(await findTool(ctx, first, "another_marker_eta")).toBeNull()
  })

  it("reads a tool's name from before, and seals it on a request", async () => {
    const id = await addServer("Before")
    await db().$executeRawUnsafe(
      `UPDATE "mcp_tool" SET "name" = 'old_marker_tool', "name_key" = NULL, "description" = '', "input_schema" = '{"type":"object"}', "about" = NULL, "schema" = NULL WHERE "id" = (SELECT "id" FROM "mcp_tool" ORDER BY "id" LIMIT 1)`,
    )

    expect((await findTool(ctx, id, "old_marker_tool"))?.name).toBe(
      "old_marker_tool",
    )
    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("old_marker_tool")).toBe(false)
    expect((await findTool(ctx, id, "old_marker_tool"))?.name).toBe(
      "old_marker_tool",
    )
  })

  it("seals the name of a tool whose words were sealed before its name was", async () => {
    const id = await addServer("Midway")
    const tool = (await findTool(ctx, id, "lookup_marker_zeta"))!
    const row = await db().mcpTool.findUniqueOrThrow({
      where: { id: tool.id },
      select: TOOL_ABOUT_SELECT,
    })
    const { name: _name, ...withoutName } = readToolAbout(ctx, row as never)
    await db().mcpTool.update({
      where: { id: tool.id },
      data: {
        about: sealJson(ctx.dek, `mcp_tool:${tool.id}:about`, withoutName),
        plainName: "midway_marker",
        nameKey: null,
      },
    })

    expect((await findTool(ctx, id, "midway_marker"))?.id).toBe(tool.id)
    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("midway_marker")).toBe(false)
    expect((await findTool(ctx, id, "midway_marker"))?.id).toBe(tool.id)
  })

  it("seals the name of a tool whose words are from before but whose schemas are not", async () => {
    const id = await addServer("Halfway")
    const tool = (await findTool(ctx, id, "lookup_marker_zeta"))!
    await db().$executeRawUnsafe(
      `UPDATE "mcp_tool" SET "name" = 'halfway_marker', "name_key" = NULL, "title" = NULL, "description" = 'HALFWAY-WORDS', "about" = NULL WHERE "id" = ?`,
      tool.id,
    )

    expect(await findTool(ctx, id, "halfway_marker")).toMatchObject({
      id: tool.id,
      description: "HALFWAY-WORDS",
    })
    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("halfway_marker")).toBe(false)
    expect(await onDisk("HALFWAY-WORDS")).toBe(false)
    expect(await findTool(ctx, id, "halfway_marker")).toMatchObject({
      id: tool.id,
      description: "HALFWAY-WORDS",
      inputSchema: JSON.stringify({ type: "object" }),
    })
  })
})
