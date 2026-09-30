import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { resetDb } from "./db"
import { applyMigrations } from "./migrate"
import { forgetSetupState } from "./vault"

/**
 * A throwaway database for tests: a fresh directory, the migrations
 * applied, the client pointed at it. Call `cleanup` when done.
 */
export async function scratchDatabase(): Promise<{
  cleanup: () => Promise<void>
}> {
  const dir = mkdtempSync(path.join(tmpdir(), "pcp-test-"))
  const previous = process.env.PCP_DATA_DIR
  process.env.PCP_DATA_DIR = dir
  await resetDb()
  forgetSetupState()
  applyMigrations()

  return {
    cleanup: async () => {
      await resetDb()
      forgetSetupState()
      if (previous === undefined) {
        delete process.env.PCP_DATA_DIR
      } else {
        process.env.PCP_DATA_DIR = previous
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
