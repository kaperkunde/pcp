import { createHash, randomUUID } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { resetDb } from "./db"
import { databaseFile } from "./data-dir"
import { applyMigrations, listMigrations, migrationsDir } from "./migrate"
import { forgetResourceLimits } from "./resources/state"
import { forgetSetupState } from "./vault"

let template: string | undefined

/**
 * A database with every migration applied, built once per set of
 * migrations and copied for each scratch database: applying them all again
 * for every test was most of what a test of the core spent. It is named by
 * a hash of the migrations, so a new or changed one builds a new template.
 * migrate.test.ts still applies the migrations themselves.
 */
function migratedTemplate(): string {
  if (template && existsSync(template)) {
    return template
  }

  const dir = migrationsDir()
  const hash = createHash("sha256")

  for (const name of listMigrations(dir)) {
    hash.update(name)
    hash.update(readFileSync(path.join(dir, name, "migration.sql")))
  }

  const file = path.join(
    tmpdir(),
    `pcp-test-template-${hash.digest("hex").slice(0, 16)}.db`,
  )

  if (!existsSync(file)) {
    // Built under a name of its own and renamed into place, so a suite in
    // another worker never copies a half-written one.
    const building = `${file}.${process.pid}.${randomUUID()}`
    applyMigrations({ file: building, dir })
    renameSync(building, file)
  }

  template = file
  return file
}

/**
 * A throwaway database for tests: a fresh directory holding a copy of the
 * migrated template, the client pointed at it. Call `cleanup` when done.
 */
export async function scratchDatabase(): Promise<{
  cleanup: () => Promise<void>
}> {
  const dir = mkdtempSync(path.join(tmpdir(), "pcp-test-"))
  const previous = process.env.PCP_DATA_DIR
  process.env.PCP_DATA_DIR = dir
  await resetDb()
  forgetSetupState()
  forgetResourceLimits()
  copyFileSync(migratedTemplate(), databaseFile())

  return {
    cleanup: async () => {
      await resetDb()
      forgetSetupState()
      forgetResourceLimits()
      if (previous === undefined) {
        delete process.env.PCP_DATA_DIR
      } else {
        process.env.PCP_DATA_DIR = previous
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
