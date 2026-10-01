import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"

import { applyMigrations, listMigrations, migrationsDir } from "./migrate"

let scratch: string

afterEach(() => {
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true })
  }
})

describe("applyMigrations", () => {
  it("applies every migration once and records it the way Prisma does", () => {
    scratch = mkdtempSync(path.join(tmpdir(), "pcp-migrate-"))
    const file = path.join(scratch, "nested", "pcp.db")
    const names = listMigrations()

    const first = applyMigrations({ file })
    expect(first.applied).toEqual(names)
    expect(first.alreadyApplied).toBe(0)

    const second = applyMigrations({ file })
    expect(second.applied).toEqual([])
    expect(second.alreadyApplied).toBe(names.length)

    const sqlite = new Database(file, { readonly: true })
    try {
      const rows = sqlite
        .prepare(
          `SELECT migration_name, checksum, finished_at, applied_steps_count
             FROM "_prisma_migrations" ORDER BY migration_name`,
        )
        .all() as Array<{
        migration_name: string
        checksum: string
        finished_at: string | null
        applied_steps_count: number
      }>

      expect(rows.map((row) => row.migration_name)).toEqual(names)

      for (const row of rows) {
        // The checksum Prisma's own CLI would have written: SHA-256 of the
        // migration file, hex encoded.
        const expected = createHash("sha256")
          .update(
            readFileSync(
              path.join(migrationsDir(), row.migration_name, "migration.sql"),
            ),
          )
          .digest("hex")
        expect(row.checksum).toBe(expected)
        expect(row.finished_at).not.toBeNull()
        expect(row.applied_steps_count).toBe(1)
      }

      const tables = sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((row) => (row as { name: string }).name)
      expect(tables).toEqual(
        expect.arrayContaining([
          "vault",
          "secret",
          "mcp_server",
          "api_token",
          "api_token_tool_access",
          "permission_request",
        ]),
      )
      expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal")
    } finally {
      sqlite.close()
    }
  })

  it("keeps existing servers, tools and token scopes through every migration", () => {
    // A migration that rebuilds a table (Prisma's CREATE new_…, copy, DROP)
    // deletes the rows that reference it: applyMigrations runs inside a
    // transaction, where PRAGMA foreign_keys=OFF does nothing, so the DROP
    // cascades. Seed data under the first migration and apply the rest.
    scratch = mkdtempSync(path.join(tmpdir(), "pcp-migrate-"))
    const file = path.join(scratch, "pcp.db")
    const names = listMigrations()
    const first = path.join(scratch, "first")
    cpSync(path.join(migrationsDir(), names[0]!), path.join(first, names[0]!), {
      recursive: true,
    })
    applyMigrations({ file, dir: first })

    const seed = new Database(file)
    try {
      seed.exec(`
        INSERT INTO vault (id, name, updated_at) VALUES ('v', 'Ada', 0);
        INSERT INTO mcp_server (id, vault_id, name, slug, url, updated_at)
          VALUES ('s', 'v', 'GitHub', 'github', 'https://mcp.example.com', 0);
        INSERT INTO mcp_tool (id, server_id, name, input_schema, updated_at)
          VALUES ('t', 's', 'create_issue', '{}', 0);
        INSERT INTO key_grant (id, vault_id, kind, kdf, kdf_params, wrapped_dek)
          VALUES ('g', 'v', 'api_token', 'hkdf', '{}', x'00');
        INSERT INTO api_token (id, vault_id, grant_id, name, prefix, allow_all_servers)
          VALUES ('k', 'v', 'g', 'Assistant', 'pcp_x', 0);
        INSERT INTO api_token_server (token_id, server_id) VALUES ('k', 's');
      `)
    } finally {
      seed.close()
    }

    expect(applyMigrations({ file }).applied).toEqual(names.slice(1))

    const sqlite = new Database(file, { readonly: true })
    try {
      const count = (table: string) =>
        (
          sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
            n: number
          }
        ).n
      expect(count("mcp_server")).toBe(1)
      expect(count("mcp_tool")).toBe(1)
      expect(count("api_token_server")).toBe(1)
      expect(
        sqlite.prepare(`SELECT kind FROM mcp_server WHERE id = 's'`).get(),
      ).toEqual({ kind: "mcp" })
    } finally {
      sqlite.close()
    }
  })

  it("refuses a migration that was edited after it was applied", () => {
    scratch = mkdtempSync(path.join(tmpdir(), "pcp-migrate-"))
    const file = path.join(scratch, "pcp.db")
    applyMigrations({ file })

    const sqlite = new Database(file)
    try {
      sqlite
        .prepare(`UPDATE "_prisma_migrations" SET checksum = 'deadbeef'`)
        .run()
    } finally {
      sqlite.close()
    }

    expect(() => applyMigrations({ file })).toThrow(/was changed after/)
  })
})
