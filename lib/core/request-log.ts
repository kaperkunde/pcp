import { AsyncLocalStorage } from "node:async_hooks"
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises"
import path from "node:path"

import { logDir } from "./data-dir"
import {
  LOG_PAGE_SIZE,
  LOG_RETRY_MS,
  LOG_SCAN_LINES,
  MAX_LOG_PAGE_SIZE,
} from "./log-limits"

/**
 * One line per gateway call, appended to a daily JSON Lines file under the
 * data directory. Files rather than rows: the log grows with use, is read
 * with grep more often than with SQL, and does not belong in the database
 * backups. Arguments and results are never written — only what was called.
 *
 * The Log page reads it back (`readRequestLog`), newest first, a vault's own
 * lines only; the scheduled cleanup (lib/core/cleanup/) deletes the days
 * older than the owner chose to keep (`pruneRequestLog`).
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
  /** The call stopped to ask the owner (a permission request, a server to connect). */
  asked?: boolean
  /** The permission request it made or found, for the Log page to link. */
  request?: string
}

const FILE = /^mcp-(\d{4}-\d{2}-\d{2})\.jsonl$/

function fileFor(day: string): string {
  return path.join(logDir(), `mcp-${day}.jsonl`)
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

// ---- What a call did, noted while it runs ---------------------------------

/**
 * What the code under a logged call learned that its result does not carry:
 * whether it asked the owner, and which request. Kept per call in async
 * context, so a result rewritten on its way out (a lead added, a run_code
 * answer built around it) still logs what happened.
 */
export type LogNote = { asked?: boolean; request?: string }

const notes = new AsyncLocalStorage<LogNote>()

/** Runs one logged call with a note of its own. */
export function withLogNote<T>(run: (note: LogNote) => Promise<T>): Promise<T> {
  const note: LogNote = {}
  return notes.run(note, () => run(note))
}

/** The call under way asked the owner (a permission request, by its id). */
export function noteOwnerAsked(request?: string): void {
  const note = notes.getStore()

  if (note) {
    note.asked = true
    note.request ??= request
  }
}

// ---- Writing ----------------------------------------------------------------

let pausedUntil = 0

export async function appendRequestLog(
  entry: Omit<RequestLogEntry, "ts">,
): Promise<void> {
  if (Date.now() < pausedUntil) {
    return
  }

  // Names come from the caller's arguments: cut them, so a request cannot
  // grow the log by what it chooses to send.
  const clamp = (value: string | undefined) => value?.slice(0, 80)
  const now = new Date()
  const line = JSON.stringify({
    ts: now.toISOString(),
    ...entry,
    server: clamp(entry.server),
    upstreamTool: clamp(entry.upstreamTool),
    request: clamp(entry.request),
  })
  const file = fileFor(dayOf(now))

  try {
    await mkdir(logDir(), { recursive: true })
    await appendFile(file, `${line}\n`)
  } catch (error) {
    // A log that cannot be written must not take the gateway down. Say so
    // once, then leave it alone for a while (a full disk the cleanup frees,
    // a volume remounted) rather than failing every call.
    pausedUntil = Date.now() + LOG_RETRY_MS
    console.error(
      `[request-log] cannot write ${file}; trying again in ${LOG_RETRY_MS / 60_000} minutes`,
      error,
    )
  }
}

// ---- Reading ----------------------------------------------------------------

export type LogOutcome = "ok" | "error" | "asked"

export type LoggedCall = RequestLogEntry & {
  /** Where the line is (`day:line`), unique and stable: the files only grow. */
  id: string
  outcome: LogOutcome
}

export type LogQuery = {
  tokenId?: string
  outcome?: LogOutcome
  /** Matches the tool, the server or the server's tool, ignoring case. */
  text?: string
  /** Where the previous page stopped (`next`). */
  cursor?: string
  limit?: number
}

export type LogPage = {
  entries: LoggedCall[]
  /** The cursor for older lines, or null when there are none. */
  next: string | null
}

const CURSOR = /^(\d{4}-\d{2}-\d{2}):(\d{1,9})$/

/** The days with a log file, newest first. */
export async function logDays(): Promise<string[]> {
  let names: string[]

  try {
    names = await readdir(logDir())
  } catch {
    return []
  }

  return names
    .map((name) => FILE.exec(name)?.[1])
    .filter((day): day is string => day !== undefined)
    .sort()
    .reverse()
}

function outcomeOf(entry: RequestLogEntry): LogOutcome {
  return entry.asked ? "asked" : entry.ok ? "ok" : "error"
}

/** A line as written, or null for one that is not (a torn write, a hand edit). */
function parseLine(line: string): RequestLogEntry | null {
  if (line.length === 0) {
    return null
  }

  let value: unknown

  try {
    value = JSON.parse(line)
  } catch {
    return null
  }

  if (typeof value !== "object" || value === null) {
    return null
  }

  const entry = value as Record<string, unknown>
  const text = (key: string) =>
    typeof entry[key] === "string" ? (entry[key] as string) : undefined

  if (
    !text("ts") ||
    !text("vaultId") ||
    !text("tokenId") ||
    !text("tool") ||
    typeof entry.ok !== "boolean"
  ) {
    return null
  }

  return {
    ts: text("ts")!,
    vaultId: text("vaultId")!,
    tokenId: text("tokenId")!,
    tool: text("tool")!,
    server: text("server"),
    upstreamTool: text("upstreamTool"),
    ok: entry.ok,
    ms: typeof entry.ms === "number" ? entry.ms : 0,
    error: text("error"),
    asked: entry.asked === true ? true : undefined,
    request: text("request"),
  }
}

function matches(
  entry: RequestLogEntry,
  vaultId: string,
  query: LogQuery,
): boolean {
  if (entry.vaultId !== vaultId) {
    return false
  }

  if (query.tokenId && entry.tokenId !== query.tokenId) {
    return false
  }

  if (query.outcome && outcomeOf(entry) !== query.outcome) {
    return false
  }

  const needle = query.text?.trim().toLowerCase()

  if (needle) {
    const haystack = [entry.tool, entry.server, entry.upstreamTool]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()

    if (!haystack.includes(needle)) {
      return false
    }
  }

  return true
}

/**
 * A vault's lines, newest first, a page at a time. A page stops after
 * LOG_SCAN_LINES lines read, matching or not, so a filter that matches
 * little never reads every day at once: `next` carries on from there.
 */
export async function readRequestLog(
  vaultId: string,
  query: LogQuery = {},
): Promise<LogPage> {
  const limit = Math.min(
    Math.max(1, Math.floor(query.limit ?? LOG_PAGE_SIZE)),
    MAX_LOG_PAGE_SIZE,
  )
  const cursor = query.cursor ? CURSOR.exec(query.cursor) : null
  const days = (await logDays()).filter((day) => !cursor || day <= cursor[1]!)
  const entries: LoggedCall[] = []
  let scanned = 0

  for (const day of days) {
    let content: string

    try {
      content = await readFile(fileFor(day), "utf8")
    } catch {
      continue
    }

    const lines = content.split("\n")

    // The file ends with a newline: no line after it.
    if (lines.at(-1) === "") {
      lines.pop()
    }

    // A cursor inside this day starts there; any other day from its end.
    let index =
      cursor && day === cursor[1]
        ? Math.min(Number(cursor[2]), lines.length)
        : lines.length

    while (index > 0) {
      if (entries.length >= limit || scanned >= LOG_SCAN_LINES) {
        return { entries, next: `${day}:${index}` }
      }

      index--
      scanned++
      const entry = parseLine(lines[index]!)

      if (entry && matches(entry, vaultId, query)) {
        entries.push({
          ...entry,
          id: `${day}:${index}`,
          outcome: outcomeOf(entry),
        })
      }
    }
  }

  return { entries, next: null }
}

// ---- Keeping it in bounds ---------------------------------------------------

/** How much the log holds on disk, for the settings page. */
export async function logUsage(): Promise<{
  days: number
  bytes: number
  oldest: string | null
}> {
  const days = await logDays()
  let bytes = 0

  for (const day of days) {
    bytes += await stat(fileFor(day)).then(
      (info) => info.size,
      () => 0,
    )
  }

  return { days: days.length, bytes, oldest: days.at(-1) ?? null }
}

/**
 * Deletes the days older than `keepDays` (today counts as one), only files
 * the log itself names: nothing else in the folder is touched.
 */
export async function pruneRequestLog(
  keepDays: number,
  now = new Date(),
): Promise<number> {
  const cutoff = dayOf(new Date(now.getTime() - (keepDays - 1) * 86_400_000))
  let removed = 0

  for (const day of await logDays()) {
    if (day >= cutoff) {
      continue
    }

    try {
      await unlink(fileFor(day))
      removed++
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }
    }
  }

  return removed
}
