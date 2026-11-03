import type { CallToolResult } from "@modelcontextprotocol/server"
import type { CDPSession, Page } from "patchright-core"

import { makeRedactor } from "../openapi/redact"
import { handleOf, type BytesKeeper, type ResultKeeper } from "../tool-results"
import { familyError, textAnswer } from "../tools/family"
import { heldValues, maskTyped, typedInto } from "./held"
import {
  ACTION_TIMEOUT_MS,
  DEFAULT_LOG_LIMIT,
  MAX_CONSOLE_ENTRIES,
  MAX_CONSOLE_TEXT_CHARS,
  MAX_HEADER_VALUE_CHARS,
  MAX_LOG_URL_CHARS,
  MAX_NETWORK_BODY_BYTES,
  MAX_NETWORK_ENTRIES,
  NETWORK_BUFFER_BYTES,
} from "./limits"
import { bounded } from "./queue"
import type { Tab } from "./runtime"
import { secretMask } from "./snapshot"

/**
 * A tab's logs, for console_log and network_log: what the tab's own
 * DevTools session saw, as events, and nothing run in the page. Each is a
 * ring of its newest entries (limits.ts), in memory, kept with the tab's
 * page: a tab reset or closed starts from nothing, and nothing of it is
 * saved anywhere.
 *
 * The console has the browser's own messages from the start (the Log
 * domain: a load that failed, a request it blocked, an intervention), which
 * a page cannot tell are read. The page's console calls and its uncaught
 * errors need the Runtime domain, which a page can tell is on (it is how
 * sites spot DevTools, and why the browser leaves it off: patchright never
 * enables it), so it is turned on for a tab only by the first console_log
 * on it (startConsole); Chromium then hands over the calls it kept since
 * the page loaded.
 *
 * The network log keeps each request's method, address, status, type,
 * size and timing, and its headers less every credential: Cookie,
 * Set-Cookie, Authorization, Proxy-Authorization and any header whose name
 * says token, key, secret, auth, session, password or credential are left
 * out; a value in an address that looks like a token (by its name or its
 * shape) is masked, and so is the user name and password part. Bodies are
 * read off Chromium only when asked for (network_log's body), and handed
 * back as kept results (call.ts), never inline.
 *
 * What PCP typed as a secret in the tab shows as [secret: name] in every
 * text here (held.ts maskTyped), wherever the page repeated it.
 */

export type ConsoleLevel = "error" | "warning" | "info" | "debug"

export type ConsoleEntry = {
  id: string
  /** Epoch milliseconds. */
  at: number
  level: ConsoleLevel
  /** console (a call of the page's), exception, or the browser's source. */
  source: string
  text: string
  url?: string
  line?: number
}

export type NetworkEntry = {
  id: string
  /** Chromium's id for it, for its body: never shown. */
  requestId: string
  method: string
  url: string
  type: string
  /** Epoch milliseconds. */
  at: number
  /** Chromium's monotonic seconds, for the timing. */
  started: number
  requestHeaders: Record<string, string>
  hasBody: boolean
  status?: number
  statusText?: string
  mimeType?: string
  responseHeaders?: Record<string, string>
  fromCache?: boolean
  durationMs?: number
  /** Bytes as they came over the network. */
  size?: number
  failed?: string
  redirectedTo?: string
}

type Logs = {
  page: Page
  console: ConsoleEntry[]
  network: NetworkEntry[]
  /** The newest entry per Chromium request id, until it ends. */
  open: Map<string, NetworkEntry>
  nextConsole: number
  nextNetwork: number
  /** The page's console calls and errors are listened to. */
  runtime: boolean
}

const KEY = "devtools"

function logsOf(tab: Tab): Logs | null {
  const logs = tab.extra.get(KEY) as Logs | undefined
  return logs && logs.page === tab.page ? logs : null
}

function push<T>(list: T[], entry: T, max: number): void {
  list.push(entry)
  if (list.length > max) list.splice(0, list.length - max)
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (cut short)` : text
}

/** Header names that carry a credential, or name one. */
const CREDENTIAL_HEADER =
  /cookie|authori[sz]ation|token|key|secret|auth|session|password|passwd|credential/i

/** Query and fragment names whose value is a credential. */
const CREDENTIAL_PARAM =
  /token|key|secret|auth|sig|signature|session|sid|pass|pwd|credential|code|jwt|ticket|nonce|state|otp/i

/** A value shaped like a token: long, of token characters, letters and digits mixed. */
function looksLikeToken(value: string): boolean {
  if (value.length < 20 || !/^[A-Za-z0-9._~+/=%-]+$/.test(value)) {
    return false
  }

  return /[A-Za-z]/.test(value) && /\d/.test(value)
}

const MASK = "[masked]"

function maskParams(params: URLSearchParams): boolean {
  let changed = false

  for (const [name, value] of [...params.entries()]) {
    if (value && (CREDENTIAL_PARAM.test(name) || looksLikeToken(value))) {
      params.set(name, MASK)
      changed = true
    }
  }

  return changed
}

/**
 * An address as the logs show it: its user name and password left out,
 * and the values of its query and fragment that look like credentials
 * masked.
 */
export function maskUrl(raw: string): string {
  let url: URL

  try {
    url = new URL(raw)
  } catch {
    return cut(raw, MAX_LOG_URL_CHARS)
  }

  if (url.protocol === "data:" || url.protocol === "blob:") {
    return cut(`${url.protocol}…`, MAX_LOG_URL_CHARS)
  }

  url.username = ""
  url.password = ""
  const query = new URLSearchParams(url.search)

  if (maskParams(query)) {
    url.search = query.toString()
  }

  if (url.hash.includes("=")) {
    const fragment = new URLSearchParams(url.hash.slice(1))
    if (maskParams(fragment)) url.hash = fragment.toString()
  } else if (looksLikeToken(url.hash.slice(1))) {
    url.hash = MASK
  }

  return cut(url.href, MAX_LOG_URL_CHARS)
}

/** A value that is an address (Referer, Location), masked as one. */
const ADDRESS_HEADER = /^(referer|location|content-location|origin)$/i

/** Headers as the logs show them: no credential, each value cut. */
export function safeHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string> {
  const safe: Record<string, string> = {}

  for (const [name, raw] of Object.entries(headers ?? {})) {
    if (CREDENTIAL_HEADER.test(name)) {
      continue
    }

    const value = String(raw)
    safe[name.toLowerCase()] = cut(
      ADDRESS_HEADER.test(name) ? maskUrl(value) : value,
      MAX_HEADER_VALUE_CHARS,
    )
  }

  return safe
}

type RemoteObject = {
  type?: string
  subtype?: string
  value?: unknown
  unserializableValue?: string
  description?: string
}

/** A console call's argument in words, as DevTools prints it. */
function argText(arg: RemoteObject): string {
  if (arg.unserializableValue !== undefined) return arg.unserializableValue
  if (arg.type === "string") return String(arg.value)
  if (arg.type === "undefined") return "undefined"
  if (arg.value !== undefined) {
    try {
      return JSON.stringify(arg.value) ?? String(arg.value)
    } catch {
      return String(arg.value)
    }
  }
  return arg.description ?? arg.type ?? ""
}

function consoleLevel(type: string): ConsoleLevel {
  switch (type) {
    case "error":
    case "assert":
      return "error"
    case "warning":
      return "warning"
    case "debug":
    case "trace":
    case "verbose":
      return "debug"
    default:
      return "info"
  }
}

/**
 * Starts a tab's logs on its page's DevTools session: the browser's console
 * messages and the network, both domains a page cannot tell are on. Called
 * for every page a tab gets (runtime.ts listen), so a reopened tab starts
 * empty. `mine` says whether the page is still the tab's.
 */
export async function watchLogs(
  tab: Tab,
  page: Page,
  mine: () => boolean,
): Promise<void> {
  const cdp: CDPSession = tab.cdp
  const logs: Logs = {
    page,
    console: [],
    network: [],
    open: new Map(),
    nextConsole: 1,
    nextNetwork: 1,
    runtime: false,
  }
  tab.extra.set(KEY, logs)

  const addConsole = (entry: Omit<ConsoleEntry, "id">) => {
    if (!mine()) return
    push(
      logs.console,
      {
        ...entry,
        id: `c${logs.nextConsole++}`,
        text: cut(entry.text, MAX_CONSOLE_TEXT_CHARS),
        ...(entry.url ? { url: maskUrl(entry.url) } : {}),
      },
      MAX_CONSOLE_ENTRIES,
    )
  }

  cdp.on(
    "Log.entryAdded",
    ({
      entry,
    }: {
      entry: {
        source: string
        level: string
        text: string
        timestamp: number
        url?: string
        lineNumber?: number
      }
    }) =>
      addConsole({
        at: entry.timestamp,
        level: consoleLevel(entry.level),
        source: entry.source,
        text: entry.text,
        ...(entry.url ? { url: entry.url } : {}),
        ...(entry.lineNumber !== undefined ? { line: entry.lineNumber } : {}),
      }),
  )
  cdp.on(
    "Runtime.consoleAPICalled",
    (event: {
      type: string
      args: RemoteObject[]
      timestamp: number
      stackTrace?: { callFrames: Array<{ url: string; lineNumber: number }> }
    }) => {
      const frame = event.stackTrace?.callFrames[0]
      addConsole({
        at: event.timestamp,
        level: consoleLevel(event.type),
        source: "console",
        text: event.args.map(argText).join(" "),
        ...(frame?.url ? { url: frame.url, line: frame.lineNumber } : {}),
      })
    },
  )
  cdp.on(
    "Runtime.exceptionThrown",
    ({
      timestamp,
      exceptionDetails,
    }: {
      timestamp: number
      exceptionDetails: {
        text: string
        url?: string
        lineNumber?: number
        exception?: { description?: string }
      }
    }) =>
      addConsole({
        at: timestamp,
        level: "error",
        source: "exception",
        text: exceptionDetails.exception?.description ?? exceptionDetails.text,
        ...(exceptionDetails.url
          ? { url: exceptionDetails.url, line: exceptionDetails.lineNumber }
          : {}),
      }),
  )

  const finish = (requestId: string, done: Partial<NetworkEntry>) => {
    const entry = logs.open.get(requestId)
    if (!entry) return
    Object.assign(entry, done)
    logs.open.delete(requestId)
  }

  cdp.on(
    "Network.requestWillBeSent",
    (event: {
      requestId: string
      request: {
        url: string
        method: string
        headers: Record<string, unknown>
        hasPostData?: boolean
      }
      timestamp: number
      wallTime: number
      type?: string
      redirectResponse?: { status: number; statusText: string }
    }) => {
      if (!mine()) return

      // A redirect ends the request before it, under the same id.
      if (event.redirectResponse) {
        const before = logs.open.get(event.requestId)
        finish(event.requestId, {
          status: event.redirectResponse.status,
          statusText: event.redirectResponse.statusText,
          durationMs: before
            ? Math.round((event.timestamp - before.started) * 1000)
            : undefined,
          redirectedTo: maskUrl(event.request.url),
        })
      }

      const entry: NetworkEntry = {
        id: `n${logs.nextNetwork++}`,
        requestId: event.requestId,
        method: event.request.method,
        url: maskUrl(event.request.url),
        type: event.type ?? "Other",
        at: Math.round(event.wallTime * 1000),
        started: event.timestamp,
        requestHeaders: safeHeaders(event.request.headers),
        hasBody: event.request.hasPostData === true,
      }
      push(logs.network, entry, MAX_NETWORK_ENTRIES)
      logs.open.set(event.requestId, entry)

      if (logs.open.size > MAX_NETWORK_ENTRIES) {
        const oldest = logs.open.keys().next().value
        if (oldest !== undefined) logs.open.delete(oldest)
      }
    },
  )
  cdp.on(
    "Network.responseReceived",
    (event: {
      requestId: string
      type?: string
      response: {
        status: number
        statusText: string
        headers: Record<string, unknown>
        mimeType: string
        fromDiskCache?: boolean
        fromServiceWorker?: boolean
      }
    }) => {
      const entry = logs.open.get(event.requestId)
      if (!entry) return
      entry.status = event.response.status
      entry.statusText = event.response.statusText
      entry.mimeType = event.response.mimeType
      entry.responseHeaders = safeHeaders(event.response.headers)
      if (event.type) entry.type = event.type
      if (event.response.fromDiskCache) entry.fromCache = true
    },
  )
  cdp.on(
    "Network.loadingFinished",
    (event: {
      requestId: string
      timestamp: number
      encodedDataLength: number
    }) => {
      const entry = logs.open.get(event.requestId)
      if (!entry) return
      finish(event.requestId, {
        durationMs: Math.round((event.timestamp - entry.started) * 1000),
        size: Math.round(event.encodedDataLength),
      })
    },
  )
  cdp.on(
    "Network.loadingFailed",
    (event: {
      requestId: string
      timestamp: number
      errorText: string
      canceled?: boolean
      blockedReason?: string
    }) => {
      const entry = logs.open.get(event.requestId)
      if (!entry) return
      finish(event.requestId, {
        durationMs: Math.round((event.timestamp - entry.started) * 1000),
        failed: event.canceled
          ? "canceled"
          : event.blockedReason
            ? `blocked (${event.blockedReason})`
            : event.errorText,
      })
    },
  )

  await cdp.send("Log.enable")
  // Again after the icon's (favicon.ts), for room enough for a body: the
  // icon still takes only one no larger than MAX_FAVICON_BYTES.
  await cdp.send("Network.enable", {
    maxResourceBufferSize: MAX_NETWORK_BODY_BYTES,
    maxTotalBufferSize: NETWORK_BUFFER_BYTES,
    maxPostDataSize: MAX_NETWORK_BODY_BYTES,
  })
}

/**
 * Turns on the page's console calls and errors for the tab: the Runtime
 * domain, which a page can tell is on. True the first time, when Chromium
 * hands over what it kept since the page loaded.
 */
export async function startConsole(tab: Tab): Promise<boolean> {
  const logs = logsOf(tab)

  if (!logs || logs.runtime) {
    return false
  }

  logs.runtime = true

  try {
    await bounded(tab.cdp.send("Runtime.enable"), ACTION_TIMEOUT_MS, "console")
  } catch (error) {
    logs.runtime = false
    throw error
  }

  // What it kept arrives as events right after: give them a moment.
  await new Promise((resolve) => setTimeout(resolve, 50))
  return true
}

export type LogFilter = {
  text?: string
  since?: number
  limit?: number
}

function newest<T extends { at: number }>(
  entries: T[],
  keep: (entry: T) => boolean,
  { since, limit = DEFAULT_LOG_LIMIT }: LogFilter,
): { entries: T[]; matched: number } {
  const matching = entries.filter(
    (entry) => (since === undefined || entry.at >= since) && keep(entry),
  )
  return { entries: matching.slice(-limit), matched: matching.length }
}

/** The console's entries a call asks for, oldest first, typed secrets masked. */
export function consoleEntries(
  tab: Tab,
  filter: LogFilter & { level?: ConsoleLevel },
): { entries: ConsoleEntry[]; matched: number; listening: boolean } {
  const logs = logsOf(tab)

  if (!logs) {
    return { entries: [], matched: 0, listening: false }
  }

  const masked = logs.console.map((entry) => ({
    ...entry,
    text: maskTyped(tab.page, entry.text),
    ...(entry.url ? { url: maskTyped(tab.page, entry.url) } : {}),
  }))
  const text = filter.text?.toLowerCase()
  const found = newest(
    masked,
    (entry) =>
      (!filter.level || entry.level === filter.level) &&
      (!text || entry.text.toLowerCase().includes(text)),
    filter,
  )

  return { ...found, listening: logs.runtime }
}

/** The network's entries a call asks for, oldest first, typed secrets masked. */
export function networkEntries(
  tab: Tab,
  filter: LogFilter,
): { entries: NetworkEntry[]; matched: number } {
  const logs = logsOf(tab)

  if (!logs) {
    return { entries: [], matched: 0 }
  }

  const page = tab.page
  const masked = logs.network.map((entry) => ({
    ...entry,
    url: maskTyped(page, entry.url),
    ...(entry.redirectedTo
      ? { redirectedTo: maskTyped(page, entry.redirectedTo) }
      : {}),
    requestHeaders: maskValues(page, entry.requestHeaders),
    ...(entry.responseHeaders
      ? { responseHeaders: maskValues(page, entry.responseHeaders) }
      : {}),
  }))
  const text = filter.text?.toLowerCase()

  return newest(
    masked,
    (entry) => !text || entry.url.toLowerCase().includes(text),
    filter,
  )
}

function maskValues(
  page: Page,
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      maskTyped(page, value),
    ]),
  )
}

/** A network entry as an answer lists it: no Chromium id. */
export function shownEntry(
  entry: NetworkEntry,
): Omit<NetworkEntry, "requestId" | "started" | "at"> & { at: string } {
  const shown: Partial<NetworkEntry> = { ...entry }
  delete shown.requestId
  delete shown.started
  delete shown.at
  return {
    ...(shown as Omit<NetworkEntry, "requestId" | "started" | "at">),
    at: new Date(entry.at).toISOString(),
  }
}

/** An entry by the id network_log gave it, while the log still has it. */
export function networkEntry(tab: Tab, id: string): NetworkEntry | null {
  return logsOf(tab)?.network.find((entry) => entry.id === id) ?? null
}

export type Body = { bytes: Buffer; text: boolean }

/** A request's body as Chromium kept it; null when it kept none. */
export async function requestBody(
  tab: Tab,
  entry: NetworkEntry,
): Promise<Body | null> {
  if (!entry.hasBody) {
    return null
  }

  const found = await bounded(
    tab.cdp.send("Network.getRequestPostData", {
      requestId: entry.requestId,
    }),
    ACTION_TIMEOUT_MS,
    "request body",
  ).catch(() => null)

  if (!found) {
    return null
  }

  const bytes = Buffer.from(found.postData, "utf8")
  return bytes.length > MAX_NETWORK_BODY_BYTES ? null : { bytes, text: true }
}

/** A response's body as Chromium kept it; null when it kept none. */
export async function responseBody(
  tab: Tab,
  entry: NetworkEntry,
): Promise<Body | null> {
  if (entry.status === undefined || entry.redirectedTo) {
    return null
  }

  const found = await bounded(
    tab.cdp.send("Network.getResponseBody", { requestId: entry.requestId }),
    ACTION_TIMEOUT_MS,
    "response body",
  ).catch(() => null)

  if (!found) {
    return null
  }

  const bytes = found.base64Encoded
    ? Buffer.from(found.body, "base64")
    : Buffer.from(found.body, "utf8")

  return bytes.length > MAX_NETWORK_BODY_BYTES
    ? null
    : { bytes, text: !found.base64Encoded }
}

function sinceOf(args: Record<string, unknown>): number | undefined {
  return typeof args.since === "string" ? Date.parse(args.since) : undefined
}

/** console_log: the tab's console entries, as JSON. */
export async function consoleLog(
  tab: Tab,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const started = await startConsole(tab)
  const { entries, matched, listening } = consoleEntries(tab, {
    text: args.text as string | undefined,
    level: args.level as ConsoleLevel | undefined,
    since: sinceOf(args),
    limit: args.limit as number | undefined,
  })

  return textAnswer(
    JSON.stringify(
      {
        tab: tab.id,
        total: matched,
        entries: entries.map(({ at, ...entry }) => ({
          ...entry,
          at: new Date(at).toISOString(),
        })),
        ...(started
          ? {
              note: "The page's console calls and uncaught errors are listened to from now on in this tab (with what Chromium kept of them since the page loaded); a site can tell, as it can tell DevTools is open.",
            }
          : !listening
            ? {
                note: "Only the browser's own messages: the page's console calls could not be listened to.",
              }
            : {}),
        ...(matched > entries.length
          ? {
              more: `Only the newest ${entries.length} of ${matched}: give since, text or level, or a larger limit.`,
            }
          : {}),
      },
      null,
      2,
    ),
  )
}

/** A body as kept for the token: text as text, anything else as bytes. */
async function keepBody(
  tab: Tab,
  entry: NetworkEntry,
  which: "request" | "response",
  body: Body,
  keepers: NetworkKeepers,
): Promise<unknown> {
  const held = (await heldValues(tab.page)).values
  const mediaType =
    which === "response"
      ? (entry.mimeType ?? "application/octet-stream")
      : (entry.requestHeaders["content-type"] ?? "text/plain")
  const name = `${entry.id}-${which}`

  if (body.text) {
    let text = maskTyped(tab.page, body.bytes.toString("utf8"))
    for (const { name: secret, value } of held) {
      text = makeRedactor([value], { replacement: secretMask(secret) }).text(
        text,
      )
    }

    if (!keepers.keep) return null
    return handleOf(
      await keepers.keep({
        text,
        mediaType,
        name,
        serverId: keepers.serverId,
        toolName: "network_log",
      }),
    )
  }

  if (!keepers.keepBytes) return null
  let bytes = body.bytes
  for (const { value } of held) bytes = withoutBytes(bytes, value)

  return handleOf(
    await keepers.keepBytes({
      bytes,
      mediaType,
      name,
      serverId: keepers.serverId,
      toolName: "network_log",
    }),
  )
}

/** The bytes with every copy of a value's UTF-8 left out. */
function withoutBytes(bytes: Buffer, value: string): Buffer {
  const needle = Buffer.from(value, "utf8")
  if (needle.length === 0) return bytes
  const parts: Buffer[] = []
  let from = 0

  for (
    let at = bytes.indexOf(needle, from);
    at !== -1;
    at = bytes.indexOf(needle, from)
  ) {
    parts.push(bytes.subarray(from, at))
    from = at + needle.length
  }

  parts.push(bytes.subarray(from))
  return parts.length === 1 ? bytes : Buffer.concat(parts)
}

export type NetworkKeepers = {
  serverId: string
  keep?: ResultKeeper
  keepBytes?: BytesKeeper
}

/** network_log: the tab's requests as JSON, or one entry's bodies as handles. */
export async function networkLog(
  tab: Tab,
  args: Record<string, unknown>,
  keepers: NetworkKeepers,
): Promise<CallToolResult> {
  if (typeof args.body === "string") {
    const entry = networkEntry(tab, args.body)

    if (!entry) {
      return familyError(
        `Tab ${tab.id}'s network log has no entry ${args.body}: it is older than what the log keeps, or the tab was reset since. List the requests again.`,
        "state",
      )
    }

    // A request a page sent after PCP typed a secret in it may carry that
    // secret in a way no word of it shows (encoded): not given.
    const withheld = entry.hasBody && typedInto(tab.page)
    const request = withheld ? null : await requestBody(tab, entry)
    const response = await responseBody(tab, entry)
    const [requestHandle, responseHandle] = [
      request ? await keepBody(tab, entry, "request", request, keepers) : null,
      response
        ? await keepBody(tab, entry, "response", response, keepers)
        : null,
    ]

    return textAnswer(
      JSON.stringify(
        {
          tab: tab.id,
          entry: shownEntry(
            networkEntries(tab, {}).entries.find(
              (one) => one.id === entry.id,
            ) ?? entry,
          ),
          request_body: requestHandle,
          response_body: responseHandle,
          note: [
            withheld
              ? "The request's body is not given: PCP typed a secret into this tab, and the body could carry it."
              : !request && entry.hasBody
                ? "The browser kept no request body for it (or one too large)."
                : null,
            !response
              ? "The browser kept no response body for it (a redirect, a failure, one too large, or gone from what it keeps)."
              : null,
            requestHandle || responseHandle
              ? 'Each body is kept for you: read it with read_result, or pass {"$result": id} where a tool takes a file.'
              : null,
          ]
            .filter(Boolean)
            .join(" "),
        },
        null,
        2,
      ),
    )
  }

  const { entries, matched } = networkEntries(tab, {
    text: args.url as string | undefined,
    since: sinceOf(args),
    limit: args.limit as number | undefined,
  })

  return textAnswer(
    JSON.stringify(
      {
        tab: tab.id,
        total: matched,
        entries: entries.map(shownEntry),
        note: "Headers that carry a credential are left out, and values in addresses that look like tokens masked. body: an entry's id keeps its bodies for you.",
        ...(matched > entries.length
          ? {
              more: `Only the newest ${entries.length} of ${matched}: give since or url, or a larger limit.`,
            }
          : {}),
      },
      null,
      2,
    ),
  )
}
