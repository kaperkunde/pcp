import { readFileSync } from "node:fs"

import { createHash } from "node:crypto"
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
import { setToolDescription } from "../servers"
import { storeTools } from "../catalogue"
import { openTools } from "../tool-rows"
import { createEndpoint, storedSpec } from "../endpoints"
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

describe("tools", () => {
  async function addTools(id: string) {
    await storeTools(ctx, id, [
      {
        name: "lookup",
        title: "TOOL-TITLE-MARKER",
        description: "TOOL-DESCRIPTION-MARKER",
        inputSchema: {
          type: "object",
          properties: {
            word: { type: "string", description: "SCHEMA-MARKER" },
          },
        },
        outputSchema: { type: "object", description: "OUTPUT-MARKER" },
      },
    ])
  }

  async function tools(id: string) {
    return openTools(
      ctx,
      await db().mcpTool.findMany({ where: { serverId: id } }),
    )
  }

  it("seals a tool's words and schemas, keeps its name plain, and reads them back", async () => {
    const id = await addServer()
    await addTools(id)
    await setToolDescription(ctx, id, "lookup", "OVERRIDE-MARKER")

    for (const marker of [
      "TOOL-TITLE-MARKER",
      "TOOL-DESCRIPTION-MARKER",
      "SCHEMA-MARKER",
      "OUTPUT-MARKER",
      "OVERRIDE-MARKER",
    ]) {
      expect(await onDisk(marker)).toBe(false)
    }

    expect(await tools(id)).toMatchObject([
      {
        name: "lookup",
        title: "TOOL-TITLE-MARKER",
        description: "TOOL-DESCRIPTION-MARKER",
        descriptionOverride: "OVERRIDE-MARKER",
      },
    ])
    expect(
      JSON.parse((await getServer(ctx, id)).tools[0]!.inputSchema),
    ).toMatchObject({ properties: { word: { description: "SCHEMA-MARKER" } } })
    expect(
      await db().$queryRawUnsafe(
        `SELECT "name", "description", "input_schema", "description_override" FROM "mcp_tool"`,
      ),
    ).toEqual([
      {
        name: "lookup",
        description: "",
        input_schema: "",
        description_override: null,
      },
    ])
  })

  it("keeps a tool's id, and the owner's wording, when its server is read again", async () => {
    const id = await addServer()
    await addTools(id)
    await setToolDescription(ctx, id, "lookup", "Mine")
    const [before] = await tools(id)
    await addTools(id)
    const [after] = await tools(id)

    expect(after).toMatchObject({ id: before!.id, descriptionOverride: "Mine" })
  })

  it("reads a tool from before, and seals it on a request", async () => {
    const id = await addServer()
    await addTools(id)
    await db().$executeRawUnsafe(
      `UPDATE "mcp_tool" SET "title" = 'Old title', "description" = 'OLD-TOOL-WORDS', "input_schema" = '{"type":"object"}', "description_override" = 'OLD-OVERRIDE', "about" = NULL, "schema" = NULL, "override" = NULL`,
    )

    expect(await tools(id)).toMatchObject([
      {
        title: "Old title",
        description: "OLD-TOOL-WORDS",
        inputSchema: '{"type":"object"}',
        descriptionOverride: "OLD-OVERRIDE",
      },
    ])
    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("OLD-TOOL-WORDS")).toBe(false)
    expect(await onDisk("OLD-OVERRIDE")).toBe(false)
    expect(await tools(id)).toMatchObject([
      {
        title: "Old title",
        description: "OLD-TOOL-WORDS",
        inputSchema: '{"type":"object"}',
        descriptionOverride: "OLD-OVERRIDE",
      },
    ])
  })
})

describe("schemas", () => {
  const SCHEMA = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "SCHEMA-TITLE-MARKER", version: "1" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          summary: "PATH-SUMMARY-MARKER",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  })

  async function addEndpoint(): Promise<string> {
    return (
      await createEndpoint(ctx, {
        name: "Pets",
        specSource: "upload",
        specText: SCHEMA,
        patches: [{ op: "add", path: "/info/x-note", value: "PATCH-MARKER" }],
        readOnly: false,
        authType: "none",
      })
    ).id
  }

  it("seals an endpoint's schema and edits, with a keyed hash", async () => {
    const id = await addEndpoint()

    expect(await onDisk("SCHEMA-TITLE-MARKER")).toBe(false)
    expect(await onDisk("PATH-SUMMARY-MARKER")).toBe(false)
    expect(await onDisk("PATCH-MARKER")).toBe(false)
    expect((await storedSpec(ctx, id))?.text).toBe(SCHEMA)
    const [raw] = await db().$queryRawUnsafe<
      Array<{ text: string; patches: string; hash: string }>
    >(`SELECT "text", "patches", "hash" FROM "openapi_spec"`)
    expect(raw).toMatchObject({ text: "", patches: "" })
    // Not the plain SHA-256, which would say whether it is a known schema.
    expect(raw!.hash).not.toBe(
      createHash("sha256").update(SCHEMA).digest("hex"),
    )
  })

  it("reads a schema from before, and seals it on a request", async () => {
    const id = await addEndpoint()
    const before = await storedSpec(ctx, id)
    const plainHash = createHash("sha256").update(SCHEMA).digest("hex")
    await db().$executeRawUnsafe(
      `UPDATE "openapi_spec" SET "text" = ?, "patches" = '[]', "hash" = ?, "sealed_text" = NULL, "sealed_patches" = NULL`,
      SCHEMA,
      plainHash,
    )

    // Read as it was, with the keyed hash a sealed row would have.
    expect(await storedSpec(ctx, id)).toMatchObject({
      text: SCHEMA,
      hash: before!.hash,
      patches: [],
    })
    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("SCHEMA-TITLE-MARKER")).toBe(false)
    expect(await storedSpec(ctx, id)).toMatchObject({
      text: SCHEMA,
      hash: before!.hash,
    })
  })
})
