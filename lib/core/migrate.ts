import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import Database from "better-sqlite3"

import { databaseFile } from "./data-dir"

/**
 * Applies prisma/migrations to the SQLite database at boot.
 *
 * The production image carries no Prisma CLI: `prisma migrate deploy` would
 * need the schema engine and a TypeScript loader for prisma.config.ts, for a
 * job that is "run these SQL files once each". So this does that job itself,
 * keeping the same `_prisma_migrations` bookkeeping the CLI keeps — the same
 * table, the same SHA-256 checksums — so a developer's `prisma migrate dev`
 * and a container's boot see one consistent history.
 *
 * A single-instance product can migrate at boot. A host running several
 * replicas should call this once, from a deploy step, before starting them.
 */

export type MigrationResult = {
  applied: string[]
  alreadyApplied: number
}

const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)`

export function migrationsDir(): string {
  return path.join(process.cwd(), "prisma", "migrations")
}

export function listMigrations(dir = migrationsDir()): string[] {
  if (!existsSync(dir)) {
    throw new Error(`prisma/migrations is missing (${dir})`)
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(path.join(dir, entry.name, "migration.sql")),
    )
    .map((entry) => entry.name)
    .sort()
}

export function applyMigrations({
  file = databaseFile(),
  dir = migrationsDir(),
}: { file?: string; dir?: string } = {}): MigrationResult {
  mkdirSync(path.dirname(file), { recursive: true })

  const sqlite = new Database(file)

  try {
    // WAL lets the web UI read while the gateway writes; a busy timeout
    // covers the rare write/write overlap instead of failing it.
    sqlite.pragma("journal_mode = WAL")
    sqlite.pragma("busy_timeout = 5000")
    sqlite.pragma("foreign_keys = ON")
    sqlite.exec(MIGRATIONS_TABLE)

    const history = sqlite
      .prepare(
        `SELECT migration_name, checksum, finished_at, rolled_back_at
           FROM "_prisma_migrations"`,
      )
      .all() as Array<{
      migration_name: string
      checksum: string
      finished_at: string | null
      rolled_back_at: string | null
    }>

    const failed = history.filter(
      (row) => !row.finished_at && !row.rolled_back_at,
    )

    if (failed.length > 0) {
      throw new Error(
        `migration ${failed.map((row) => row.migration_name).join(", ")} did not finish and has to be resolved by hand (\`prisma migrate resolve\`)`,
      )
    }

    const applied = new Map(
      history
        .filter((row) => row.finished_at && !row.rolled_back_at)
        .map((row) => [row.migration_name, row.checksum]),
    )

    const result: MigrationResult = { applied: [], alreadyApplied: 0 }

    for (const name of listMigrations(dir)) {
      const sql = readFileSync(path.join(dir, name, "migration.sql"))
      const checksum = createHash("sha256").update(sql).digest("hex")
      const known = applied.get(name)

      if (known !== undefined) {
        if (known !== checksum) {
          throw new Error(
            `migration ${name} was changed after it was applied (checksum ${known} in the database, ${checksum} on disk)`,
          )
        }

        result.alreadyApplied++
        continue
      }

      const id = randomUUID()
      const startedAt = new Date().toISOString()

      sqlite
        .prepare(
          `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count)
           VALUES (?, ?, ?, ?, 0)`,
        )
        .run(id, checksum, name, startedAt)

      try {
        sqlite.transaction(() => {
          sqlite.exec(sql.toString("utf8"))
        })()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sqlite
          .prepare(`UPDATE "_prisma_migrations" SET logs = ? WHERE id = ?`)
          .run(message, id)
        throw new Error(`migration ${name} failed: ${message}`)
      }

      sqlite
        .prepare(
          `UPDATE "_prisma_migrations"
              SET finished_at = ?, applied_steps_count = 1
            WHERE id = ?`,
        )
        .run(new Date().toISOString(), id)

      result.applied.push(name)
    }

    return result
  } finally {
    sqlite.close()
  }
}
