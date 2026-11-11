import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

import { decryptString, encryptString } from "./crypto"
import { logDir } from "./data-dir"
import {
  LOG_PAGE_SIZE,
  LOG_RETRY_MS,
  LOG_SCAN_LINES,
  MAX_LOG_PAGE_SIZE,
} from "./log-limits"

/**
 * One line per gateway call, appended to a daily JSON Lines file under the
 * data directory. Files rather than rows: the log grows with use and does
 * not belong in the database backups. Arguments and results are never
 * written — only what was called, and for a secret the browser typed, which
 * one and at which site.
 *
 * The names on a line (the tool, the server and its tool, an error, the
 * secret and its site, the exit) are sealed under the vault's key (#96): a
 * line's `sealed` is their JSON, AES-256-GCM with the line's vault, id,
 * time and token as associated data, so a sealed part opens only on the
 * line it was written for. What stays plain is what the cleanup and the
 * Log page's paging need without the key: the time, the vault and token
 * ids, the outcome and the permission request's id. Lines from before hold
 * the names in plain text until the vault's next requests seal them
 * (`sealRequestLogDay`, from lib/core/sealing/convert.ts).
 *
 * The Log page reads it back with the vault's key (`readRequestLog`),
 * newest first, a vault's own lines only; the scheduled cleanup
 * (lib/core/cleanup/) deletes the days older than the owner chose to keep
 * by their file names alone (`pruneRequestLog`), with no key.
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
  /**
   * A secret the browser typed for the call (lib/core/browser-secrets.ts):
   * its name and the site (an origin) it was typed at, never its value.
   */
  secret?: string
  origin?: string
  /** The exit the call went out through (lib/core/exits/), by name; never the site. */
  exit?: string
  /**
   * The assistant repeated a call it had made within the duplicate guard's
   * window on purpose (rerun with a reason, lib/core/calls/guard.ts). The
   * reason is its own words and stays out of the log, as arguments do.
   */
  rerun?: boolean
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
export type LogNote = {
  asked?: boolean
  request?: string
  secret?: string
  origin?: string
  exit?: string
  rerun?: boolean
}

const notes = new AsyncLocalStorage<LogNote>()

/** Runs one logged call with a note of its own. */
export function withLogNote<T>(run: (note: LogNote) => Promise<T>): Promise<T> {
  const note: LogNote = {}
  return notes.run(note, () => run(note))
}

/** The note of the logged call under way, if any. */
export function currentLogNote(): LogNote | undefined {
  return notes.getStore()
}

/** The call under way repeats an earlier one on purpose (calls/guard.ts). */
export function noteRerun(): void {
  const note = notes.getStore()

  if (note) {
    note.rerun = true
  }
}

/** The call under way asked the owner (a permission request, by its id). */
export function noteOwnerAsked(request?: string): void {
  const note = notes.getStore()

  if (note) {
    note.asked = true
    note.request ??= request
  }
}

/**
 * The call under way had the browser type one of the owner's secrets: its
 * name and the origin, on the call's own line. A call with no line of its
 * own (one the owner allowed on PCP's page) gets one, as the browser's type.
 */
export function noteSecretTyped(typed: {
  vaultId: string
  /** The vault's key, which seals the line's names. */
  dek: Buffer
  tokenId: string
  server: string
  secret: string
  origin: string
}): void {
  const note = notes.getStore()

  if (note) {
    note.secret = typed.secret
    note.origin = typed.origin
    return
  }

  void appendRequestLog({
    vaultId: typed.vaultId,
    dek: typed.dek,
    tokenId: typed.tokenId,
    tool: "type",
    server: typed.server,
    upstreamTool: "type",
    ok: true,
    ms: 0,
    secret: typed.secret,
    origin: typed.origin,
  })
}

/**
 * The call under way went out through an exit: its name on the call's
 * line, never the site. A call with no line of its own (one the owner
 * allowed on PCP's page) gets one.
 */
export function noteExitUsed(used: {
  vaultId: string
  /** The vault's key, which seals the line's names. */
  dek: Buffer
  tokenId: string
  tool: string
  exit: string
}): void {
  const note = notes.getStore()

  if (note) {
    note.exit = used.exit
    return
  }

  void appendRequestLog({
    vaultId: used.vaultId,
    dek: used.dek,
    tokenId: used.tokenId,
    tool: used.tool,
    ok: true,
    ms: 0,
    exit: used.exit,
  })
}

// ---- Sealing a line's names --------------------------------------------------

/** The names a line keeps sealed. */
const SEALED_KEYS = [
  "tool",
  "server",
  "upstreamTool",
  "error",
  "secret",
  "origin",
  "exit",
] as const

/** What binds a line's sealed names to it. */
function lineAad(line: {
  vaultId: string
  id: string
  ts: string
  tokenId: string
}): string {
  return `request_log:${line.vaultId}:${line.id}:${line.ts}:${line.tokenId}`
}

/** A line as it is written: its names sealed, the rest as it is. */
function sealedLine(
  dek: Buffer,
  entry: RequestLogEntry,
  id: string,
): Record<string, unknown> {
  const names: Record<string, unknown> = {}
  const plain: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) {
      continue
    }

    if ((SEALED_KEYS as readonly string[]).includes(key)) {
      names[key] = value
    } else {
      plain[key] = value
    }
  }

  const line = { ts: entry.ts, id, ...plain }

  return {
    ...line,
    sealed: Buffer.from(
      encryptString(dek, JSON.stringify(names), lineAad({ ...entry, id })),
    ).toString("base64"),
  }
}

// ---- Writing ----------------------------------------------------------------

let pausedUntil = 0

/**
 * While a day's file is written again (its lines from before sealed), new
 * lines wait for it, and it waits for the lines already on their way: kept
 * on globalThis, since instrumentation and the routes are bundled apart.
 */
type Writers = {
  rewriting: Promise<void> | null
  appending: Set<Promise<void>>
}

const WRITERS = Symbol.for("pcp.request-log-writers")

function writers(): Writers {
  const holder = globalThis as unknown as { [WRITERS]?: Writers }
  holder[WRITERS] ??= { rewriting: null, appending: new Set() }
  return holder[WRITERS]
}

export async function appendRequestLog(
  entry: Omit<RequestLogEntry, "ts"> & {
    /** The vault's key, which seals the line's names. */
    dek: Buffer
  },
): Promise<void> {
  if (Date.now() < pausedUntil) {
    return
  }

  // Names come from the caller's arguments: cut them, so a request cannot
  // grow the log by what it chooses to send.
  const clamp = (value: string | undefined) => value?.slice(0, 80)
  const now = new Date()
  const { dek, ...rest } = entry
  const line = JSON.stringify(
    sealedLine(
      dek,
      {
        ts: now.toISOString(),
        ...rest,
        server: clamp(rest.server),
        upstreamTool: clamp(rest.upstreamTool),
        request: clamp(rest.request),
        secret: rest.secret?.slice(0, 100),
        origin: rest.origin?.slice(0, 300),
        exit: clamp(rest.exit),
      },
      randomBytes(8).toString("hex"),
    ),
  )
  await appendLine(line, now)
}

async function appendLine(line: string, now = new Date()): Promise<void> {
  if (Date.now() < pausedUntil) {
    return
  }

  const file = fileFor(dayOf(now))
  const state = writers()

  while (state.rewriting) {
    await state.rewriting
  }

  const append = (async () => {
    await mkdir(logDir(), { recursive: true })
    await appendFile(file, `${line}\n`)
  })()
  state.appending.add(append)

  try {
    await append
  } catch (error) {
    // A log that cannot be written must not take the gateway down. Say so
    // once, then leave it alone for a while (a full disk the cleanup frees,
    // a volume remounted) rather than failing every call.
    pausedUntil = Date.now() + LOG_RETRY_MS
    console.error(
      `[request-log] cannot write ${file}; trying again in ${LOG_RETRY_MS / 60_000} minutes`,
      error,
    )
  } finally {
    state.appending.delete(append)
  }
}

/**
 * The calls a request with no vault key logs: a file link's or an upload
 * link's use, whose only credential is the link. Their names are PCP's
 * own, never the owner's, so the line keeps them plain and says so
 * (`keyless`), and no conversion seals it.
 */
export type KeylessTool =
  | "file_link/download"
  | "file_link/upload"
  | "file_link/store_download"
  | "upload_link/upload"
  | "upload_link/done"

export async function appendKeylessLog(entry: {
  vaultId: string
  tokenId: string
  tool: KeylessTool
  ok: boolean
  ms: number
}): Promise<void> {
  await appendLine(
    JSON.stringify({ ts: new Date().toISOString(), ...entry, keyless: true }),
  )
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

/** What reads a vault's lines: its id, and its key to open their names. */
export type LogReader = { vaultId: string; dek: Buffer }

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

/** A line's JSON, or null for one that is not (a torn write, a hand edit). */
function lineJson(line: string): Record<string, unknown> | null {
  if (line.length === 0) {
    return null
  }

  try {
    const value: unknown = JSON.parse(line)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * A vault's line as written, its names opened; null for one that is not,
 * another vault's, or one whose names do not open under the key.
 */
function parseLine(line: string, reader: LogReader): RequestLogEntry | null {
  const json = lineJson(line)

  if (!json) {
    return null
  }

  let entry = json

  if (typeof json.sealed === "string") {
    if (
      json.vaultId !== reader.vaultId ||
      typeof json.id !== "string" ||
      typeof json.ts !== "string" ||
      typeof json.tokenId !== "string"
    ) {
      return null
    }

    try {
      const names = JSON.parse(
        decryptString(
          reader.dek,
          Buffer.from(json.sealed, "base64"),
          lineAad({
            vaultId: json.vaultId,
            id: json.id,
            ts: json.ts,
            tokenId: json.tokenId,
          }),
        ),
      ) as Record<string, unknown>
      entry = { ...json, ...names }
    } catch {
      return null
    }
  }

  const text = (key: string) =>
    typeof entry[key] === "string" ? (entry[key] as string) : undefined

  if (
    !text("ts") ||
    text("vaultId") !== reader.vaultId ||
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
    secret: text("secret"),
    origin: text("origin"),
    exit: text("exit"),
    rerun: entry.rerun === true ? true : undefined,
  }
}

function matches(entry: RequestLogEntry, query: LogQuery): boolean {
  if (query.tokenId && entry.tokenId !== query.tokenId) {
    return false
  }

  if (query.outcome && outcomeOf(entry) !== query.outcome) {
    return false
  }

  const needle = query.text?.trim().toLowerCase()

  if (needle) {
    const haystack = [
      entry.tool,
      entry.server,
      entry.upstreamTool,
      entry.secret,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()

    if (!haystack.includes(needle)) {
      return false
    }
  }

  return true
}

/** A line's vault, read without opening anything. */
function lineVault(line: string): string | undefined {
  const vaultId = lineJson(line)?.vaultId
  return typeof vaultId === "string" ? vaultId : undefined
}

/**
 * A vault's lines, newest first, a page at a time, their names opened with
 * the vault's key. A page stops after LOG_SCAN_LINES lines read, matching
 * or not, so a filter that matches little never reads every day at once:
 * `next` carries on from there.
 */
export async function readRequestLog(
  reader: LogReader,
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
      const line = lines[index]!
      const entry =
        lineVault(line) === reader.vaultId ? parseLine(line, reader) : null

      if (entry && matches(entry, query)) {
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

// ---- Sealing the lines from before ------------------------------------------

/**
 * The days whose file holds a line of the vault's from before its names
 * were sealed, oldest first.
 */
export async function unsealedLogDays(vaultId: string): Promise<string[]> {
  const found: string[] = []

  for (const day of (await logDays()).reverse()) {
    let content: string

    try {
      content = await readFile(fileFor(day), "utf8")
    } catch {
      continue
    }

    if (
      content.split("\n").some((line) => {
        const json = lineJson(line)
        return (
          json !== null &&
          json.vaultId === vaultId &&
          typeof json.sealed !== "string" &&
          json.keyless !== true
        )
      })
    ) {
      found.push(day)
    }
  }

  return found
}

/**
 * Writes a day's file again with the vault's lines from before sealed, each
 * where it was, so a line's place (the Log page's id and cursor) stays.
 * New lines wait while it is written. Answers whether a line was sealed.
 */
export async function sealRequestLogDay(
  reader: LogReader,
  day: string,
): Promise<boolean> {
  const state = writers()

  while (state.rewriting) {
    await state.rewriting
  }

  let done!: () => void
  state.rewriting = new Promise((resolve) => {
    done = resolve
  })

  try {
    await Promise.allSettled([...state.appending])
    const file = fileFor(day)
    let content: string

    try {
      content = await readFile(file, "utf8")
    } catch {
      return false
    }

    let sealed = 0
    const lines = content.split("\n").map((line) => {
      const json = lineJson(line)

      if (
        !json ||
        json.vaultId !== reader.vaultId ||
        typeof json.sealed === "string" ||
        json.keyless === true
      ) {
        return line
      }

      const entry = parseLine(line, reader)

      if (!entry) {
        return line
      }

      sealed++
      return JSON.stringify(
        sealedLine(reader.dek, entry, randomBytes(8).toString("hex")),
      )
    })

    if (sealed === 0) {
      return false
    }

    const part = `${file}.${randomBytes(6).toString("hex")}.part`

    try {
      await writeFile(part, lines.join("\n"), { mode: 0o600 })
      await rename(part, file)
    } catch (error) {
      await unlink(part).catch(() => {})
      throw error
    }

    return true
  } finally {
    state.rewriting = null
    done()
  }
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

/** Deletes every day of the log: for the vault being deleted. */
export async function deleteRequestLog(): Promise<void> {
  for (const day of await logDays()) {
    try {
      await unlink(fileFor(day))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }
    }
  }
}
