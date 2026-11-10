import { readFileSync } from "node:fs"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { cleanupIdle, stopCleanup } from "../cleanup/runtime"
import type { VaultContext } from "../context"
import { databaseFile } from "../data-dir"
import { db } from "../db"
import { definitionOf } from "../definitions"
import { exportVault, readExport, restoreExport } from "../backup"
import {
  createServer,
  getServer,
  listServers,
  setServerStatus,
} from "../servers"
import { writeServer } from "../server-meta"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { forgetVaultUpkeeps } from "../vault-upkeep"
import { ensureSealed, forgetSealedVaults, SEAL_CONVERTERS } from "./convert"

// What a server is and where it is, and a definition's name, are sealed at
// rest (#96, part 2): what the rows store, that every reader takes the old
// plain form too, and that a vault from before is sealed by its requests.

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

/** Whether the text is anywhere in the database's files. */
async function onDisk(text: string): Promise<boolean> {
  await db().$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)")
  return readFileSync(databaseFile()).includes(Buffer.from(text, "utf8"))
}

async function addServer(): Promise<string> {
  return (
    await createServer(ctx, {
      name: "SERVER-NAME-MARKER",
      description: "SERVER-DESCRIPTION-MARKER",
      url: "https://server-url-marker.example/mcp",
      authType: "none",
    })
  ).id
}

describe("servers", () => {
  it("seals a server's name, description and address, and reads them back", async () => {
    const id = await addServer()

    expect(await onDisk("SERVER-NAME-MARKER")).toBe(false)
    expect(await onDisk("SERVER-DESCRIPTION-MARKER")).toBe(false)
    expect(await onDisk("server-url-marker")).toBe(false)
    expect(await getServer(ctx, id)).toMatchObject({
      name: "SERVER-NAME-MARKER",
      description: "SERVER-DESCRIPTION-MARKER",
      url: "https://server-url-marker.example/mcp",
    })
    expect(await listServers(ctx)).toMatchObject([
      { id, name: "SERVER-NAME-MARKER" },
    ])
    // Its definition's name and description are sealed too.
    expect((await definitionOf(ctx, id))?.description).toBe(
      "SERVER-DESCRIPTION-MARKER",
    )

    const raw = await db().$queryRawUnsafe<
      Array<{ name: string; description: string; url: string; meta: unknown }>
    >(`SELECT "name", "description", "url", "meta" FROM "mcp_server"`)
    expect(raw).toEqual([
      { name: "", description: "", url: "", meta: expect.anything() },
    ])
    expect(
      await db().$queryRawUnsafe(
        `SELECT "name", "description" FROM "server_definition"`,
      ),
    ).toEqual([{ name: "", description: "" }])
  })

  it("seals what its status says", async () => {
    const id = await addServer()
    await setServerStatus(ctx, id, "error", "STATUS-MARKER went wrong")

    expect(await onDisk("STATUS-MARKER")).toBe(false)
    expect(await getServer(ctx, id)).toMatchObject({
      status: "error",
      statusMessage: "STATUS-MARKER went wrong",
    })
  })

  it("keeps every write of two that come at once", async () => {
    const id = await addServer()

    await Promise.all([
      writeServer(ctx, id, { description: "Both" }),
      setServerStatus(ctx, id, "ok", "Kept too"),
      writeServer(ctx, id, { sshHostKey: "ssh-ed25519 AAAA" }),
    ])

    expect(await getServer(ctx, id)).toMatchObject({
      name: "SERVER-NAME-MARKER",
      description: "Both",
      statusMessage: "Kept too",
      sshHostKey: "ssh-ed25519 AAAA",
    })
  })

  it("reads a server and definition from before, and seals them on a request", async () => {
    const id = await addServer()
    const { id: definitionId } = (await definitionOf(ctx, id))!
    await db().$executeRawUnsafe(
      `UPDATE "mcp_server" SET "name" = 'Old server', "description" = 'OLD-DESCRIPTION', "url" = 'https://old-url.example/mcp', "status_message" = 'Old status', "meta" = NULL WHERE "id" = ?`,
      id,
    )
    await db().$executeRawUnsafe(
      `UPDATE "server_definition" SET "name" = 'Old definition', "description" = 'OLD-DESCRIPTION', "meta" = NULL WHERE "id" = ?`,
      definitionId,
    )

    expect(await getServer(ctx, id)).toMatchObject({
      name: "Old server",
      description: "OLD-DESCRIPTION",
      url: "https://old-url.example/mcp",
      statusMessage: "Old status",
    })
    expect(await definitionOf(ctx, id)).toMatchObject({
      name: "Old definition",
    })

    expect(await ensureSealed(ctx)).toBe(true)

    expect(await onDisk("OLD-DESCRIPTION")).toBe(false)
    expect(await onDisk("old-url")).toBe(false)
    expect(await getServer(ctx, id)).toMatchObject({
      name: "Old server",
      description: "OLD-DESCRIPTION",
      url: "https://old-url.example/mcp",
      statusMessage: "Old status",
    })
    expect(await definitionOf(ctx, id)).toMatchObject({
      name: "Old definition",
      description: "OLD-DESCRIPTION",
    })
  })

  it("seals a row from before whole on its first write, and the conversion leaves it", async () => {
    const id = await addServer()
    await db().$executeRawUnsafe(
      `UPDATE "mcp_server" SET "name" = 'Before', "url" = 'https://before.example/mcp', "meta" = NULL WHERE "id" = ?`,
      id,
    )
    const read = await SEAL_CONVERTERS.find(
      (converter) => converter.table === "mcp_server",
    )!.read(ctx, 10)

    // The owner, between the conversion's read and its write.
    await writeServer(ctx, id, { description: "Changed since" })

    for (const write of read) {
      expect(await write()).toBe(false)
    }

    expect(await getServer(ctx, id)).toMatchObject({
      name: "Before",
      url: "https://before.example/mcp",
      description: "Changed since",
    })
    expect(await onDisk("before.example")).toBe(false)
  })

  it("restores a file whose servers are sealed, and seals one from before", async () => {
    const id = await addServer()
    const file = await exportVault(ctx, "export password 1234")
    const { payload } = await readExport(file, "export password 1234")
    // The file carries the sealed values, never the plain ones.
    expect(JSON.stringify(payload)).not.toContain("SERVER-NAME-MARKER")

    await restoreExport(
      payload,
      { into: "vault", ctx },
      { restoreHostSettings: false },
    )
    expect((await getServer(ctx, id)).name).toBe("SERVER-NAME-MARKER")
  })
})
