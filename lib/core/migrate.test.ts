import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
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
        expect.arrayContaining(["vault", "secret", "mcp_server", "api_token"]),
      )
      expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal")
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
