import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"

import { logDir } from "./data-dir"

/**
 * One line per gateway call, appended to a daily JSON Lines file under the
 * data directory. Files rather than rows: the log grows with use, is read
 * with grep more often than with SQL, and does not belong in the database
 * backups. Arguments and results are never written — only what was called.
 */

export type RequestLogEntry = {
  ts: string
  vaultId: string
  tokenId: string
  tool: string
  server?: string
  upstreamTool?: string
  ok: boolean
  ms: number
  error?: string
}

let disabled = false

export async function appendRequestLog(
  entry: Omit<RequestLogEntry, "ts">,
): Promise<void> {
  if (disabled) {
    return
  }

  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
  const file = path.join(
    logDir(),
    `mcp-${new Date().toISOString().slice(0, 10)}.jsonl`,
  )

  try {
    await mkdir(logDir(), { recursive: true })
    await appendFile(file, `${line}\n`)
  } catch (error) {
    // A log that cannot be written must not take the gateway down. Say so
    // once, then stop trying for this process.
    disabled = true
    console.error("[request-log] disabled: cannot write", file, error)
  }
}
