import { readFileSync } from "node:fs"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { storeTools } from "../catalogue"
import { cleanupIdle, stopCleanup } from "../cleanup/runtime"
import type { VaultContext } from "../context"
import { databaseFile } from "../data-dir"
import { db } from "../db"
import { pendingAccessAad } from "../proposed-access"
import { sealJson, openFromText } from "../sealed"
import { readFields } from "../sealed-fields"
import { createSecret } from "../secrets"
import { SERVER_META } from "../server-meta"
import { createServer, extraAuthHeaders, getServer } from "../servers"
import { scratchDatabase } from "../test-db"
import { findTool, openTools } from "../tool-rows"
import { setupVault } from "../vault"
import { forgetVaultUpkeeps } from "../vault-upkeep"
import { ensureSealed, forgetSealedVaults } from "./convert"

// The last values the owner types or an upstream sends, sealed at rest
// (#96): a header's name and template, a server's saved levels waiting for
// its tools, and a tool's icons. Rows from before still read and are sealed
// by a request that holds the key. A service's own values are in
// services/services.test.ts, which has the fake engine they need.

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

describe("auth header names and templates", () => {
  async function headerServer(): Promise<{ id: string; secretId: string }> {
    const { id: secretId } = await createSecret(ctx, {
      name: "key",
      value: "s3cret-value-1234",
    })
    const { id } = await createServer(ctx, {
      name: "Headers",
      url: "https://headers.example.com/mcp",
      authType: "header",
      authSecretId: secretId,
      authHeaderName: "X-Marker-Header",
      authValueTemplate: "Token-marker {{secret}}",
      authExtraHeaders: [
        {
          secretId,
          headerName: "X-Extra-Marker",
          valueTemplate: "Extra-marker {{secret}}",
        },
      ],
    })
    return { id, secretId }
  }

  it("are sealed with the server's other values, and read back", async () => {
    const { id } = await headerServer()

    for (const marker of [
      "X-Marker-Header",
      "Token-marker",
      "X-Extra-Marker",
      "Extra-marker",
    ]) {
      expect(await onDisk(marker)).toBe(false)
    }

    expect(await getServer(ctx, id)).toMatchObject({
      authHeaderName: "X-Marker-Header",
      authValueTemplate: "Token-marker {{secret}}",
    })
    expect(await extraAuthHeaders(ctx, id)).toMatchObject([
      {
        headerName: "X-Extra-Marker",
        valueTemplate: "Extra-marker {{secret}}",
      },
    ])
    const rows = await db().$queryRawUnsafe<
      Array<{ header_name: string; value_template: string; sealed: unknown }>
    >(
      `SELECT "header_name", "value_template", "sealed" IS NOT NULL AS "sealed" FROM "server_auth_header"`,
    )
    expect(rows.map((row) => ({ ...row, sealed: Number(row.sealed) }))).toEqual(
      [{ header_name: "", value_template: "", sealed: 1 }],
    )
  })

  it("from before are read, and sealed by a request", async () => {
    const { id } = await headerServer()
    // The server's own, as it was when only the other values were sealed:
    // its meta has no header, which sits in the plain columns.
    const row = await db().mcpServer.findUniqueOrThrow({ where: { id } })
    const meta: Record<string, unknown> = {
      ...readFields(ctx.dek, SERVER_META, row),
    }
    delete meta.authHeaderName
    delete meta.authValueTemplate
    await db().mcpServer.update({
      where: { id },
      data: {
        meta: sealJson(ctx.dek, SERVER_META.aad(id), meta),
        plainAuthHeaderName: "X-Legacy-Header",
        plainAuthValueTemplate: "Legacy-marker {{secret}}",
      },
    })
    // And a further header in its plain columns.
    await db().serverAuthHeader.updateMany({
      data: {
        sealed: null,
        plainHeaderName: "X-Legacy-Extra",
        plainValueTemplate: "Legacy-extra {{secret}}",
      },
    })

    expect(await getServer(ctx, id)).toMatchObject({
      authHeaderName: "X-Legacy-Header",
      authValueTemplate: "Legacy-marker {{secret}}",
    })
    expect(await extraAuthHeaders(ctx, id)).toMatchObject([
      { headerName: "X-Legacy-Extra" },
    ])
    expect(await onDisk("X-Legacy-Header")).toBe(true)

    expect(await ensureSealed(ctx)).toBe(true)
    for (const marker of [
      "X-Legacy-Header",
      "Legacy-marker",
      "X-Legacy-Extra",
      "Legacy-extra",
    ]) {
      expect(await onDisk(marker)).toBe(false)
    }

    expect(await getServer(ctx, id)).toMatchObject({
      authHeaderName: "X-Legacy-Header",
      authValueTemplate: "Legacy-marker {{secret}}",
    })
    expect(await extraAuthHeaders(ctx, id)).toMatchObject([
      {
        headerName: "X-Legacy-Extra",
        valueTemplate: "Legacy-extra {{secret}}",
      },
    ])
  })
})

describe("levels saved for a server's tools", () => {
  const pending = JSON.stringify({
    tokenId: "t1",
    rules: [{ pattern: "pending_marker_*", access: "allowed" }],
  })

  async function server(): Promise<string> {
    return (
      await createServer(ctx, {
        name: "Pending",
        url: "https://pending.example.com/mcp",
        authType: "none",
      })
    ).id
  }

  it("from before are sealed, as the text they were, by a request", async () => {
    const id = await server()
    await db().mcpServer.update({
      where: { id },
      data: { pendingAccess: pending },
    })
    expect(await onDisk("pending_marker_")).toBe(true)

    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("pending_marker_")).toBe(false)
    const { pendingAccess } = await db().mcpServer.findUniqueOrThrow({
      where: { id },
    })
    expect(pendingAccess).toMatch(/^pcp-sealed:/)
    expect(openFromText(ctx.dek, pendingAccessAad(id), pendingAccess!)).toBe(
      pending,
    )
  })

  it("are not sealed over a value saved or cleared since it was read", async () => {
    const id = await server()
    await db().mcpServer.update({
      where: { id },
      data: { pendingAccess: pending },
    })
    const converter = (await import("./convert")).SEAL_CONVERTERS.find(
      (entry) => entry.table === "mcp_server_pending_access",
    )!
    const writes = await converter.read(ctx, 10)

    // Cleared between the read and the write: it stays cleared.
    await db().mcpServer.update({
      where: { id },
      data: { pendingAccess: null },
    })
    for (const write of writes) {
      expect(await write()).toBe(false)
    }

    expect(
      (await db().mcpServer.findUniqueOrThrow({ where: { id } })).pendingAccess,
    ).toBeNull()
  })
})

describe("a tool's icons", () => {
  const icons = [{ src: "https://icons.example.com/icons-marker.png" }]

  async function tool() {
    const { id } = await createServer(ctx, {
      name: "Icons",
      url: "https://icons.example.com/mcp",
      authType: "none",
    })
    await storeTools(ctx, id, [
      { name: "with_icons", inputSchema: { type: "object" }, icons },
    ])
    return id
  }

  it("are sealed with the tool's words, and read back", async () => {
    const id = await tool()

    expect(await onDisk("icons-marker")).toBe(false)
    expect(
      await db().$queryRawUnsafe(`SELECT "icons" FROM "mcp_tool"`),
    ).toEqual([{ icons: null }])
    expect((await findTool(ctx, id, "with_icons"))?.icons).toBe(
      JSON.stringify(icons),
    )
  })

  it("from before are read, and sealed by a request", async () => {
    const id = await tool()
    // A tool sealed before its icons were: they sit in the plain column.
    const row = await db().mcpTool.findFirstOrThrow({ where: { serverId: id } })
    const opened = openTools(ctx, [row])[0]!
    const about = {
      name: opened.name,
      title: opened.title,
      description: opened.description,
      annotationsTitle: null,
    }
    await db().mcpTool.update({
      where: { id: row.id },
      data: {
        about: sealJson(ctx.dek, `mcp_tool:${row.id}:about`, about),
        plainIcons: JSON.stringify([
          { src: "https://old.example.com/old-icons-marker.png" },
        ]),
      },
    })

    expect((await findTool(ctx, id, "with_icons"))?.icons).toContain(
      "old-icons-marker",
    )
    expect(await onDisk("old-icons-marker")).toBe(true)

    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("old-icons-marker")).toBe(false)
    expect((await findTool(ctx, id, "with_icons"))?.icons).toContain(
      "old-icons-marker",
    )
    expect(
      await db().$queryRawUnsafe(`SELECT "icons" FROM "mcp_tool"`),
    ).toEqual([{ icons: null }])
  })
})
