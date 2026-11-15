import { createHash } from "node:crypto"
import { isIP } from "node:net"
import { domainToASCII } from "node:url"

import { z } from "zod"

import type { VaultContext } from "../context"
import { invalid } from "../errors"
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_COOKIES,
  MAX_IMPORT_ORIGINS,
} from "./limits"
import {
  loadProfile,
  profileSummary,
  writeProfile,
  type StorageState,
} from "./profile"
import { runningBrowser, withBrowserClosed } from "./runtime"

/**
 * The owner's import of a sign-in made in another browser into the vault's
 * browser profile (`browser_profile`, profile.ts), from the Browser page
 * only: never a tool, and nothing of it reaches an assistant. It reads
 * Playwright's storage state, a JSON cookie export (the shape browser
 * extensions such as Cookie-Editor save) or a Netscape cookies.txt, checks
 * each cookie as Chromium would take it (one Chromium refuses would keep
 * the browser from starting), leaves out PCP's own site and this machine,
 * and replaces what the profile held for each site it names. The owner sees
 * a preview first (sites and counts, what is left out and replaced); the
 * import writes what that preview showed (`basis`, the text's hash), with
 * the browser closed so it cannot save over it.
 */

type Cookie = StorageState["cookies"][number]
type Origin = StorageState["origins"][number]

export type ImportFormat = "storage-state" | "cookie-json" | "cookies-txt"

/** Why an entry of the import was left out. */
export type SkipReason = "own" | "address" | "expired" | "invalid" | "indexeddb"

export type ParsedImport = {
  format: ImportFormat
  cookies: Cookie[]
  /** Origins with local storage (IndexedDB is left out). */
  origins: Origin[]
  skipped: Partial<Record<SkipReason, number>>
}

export type ImportPreview = {
  format: ImportFormat
  /** The import's hash: the import writes only what this preview showed. */
  basis: string
  sites: { site: string; cookies: number; storage: number }[]
  cookies: number
  origins: number
  /** What was left out, and why, in the page's words (SKIP_LABELS). */
  skipped: { reason: SkipReason; count: number; label: string }[]
  /** What the profile holds now for these sites, which the import replaces. */
  replaces: { sites: number; cookies: number }
  /** The browser is running: importing closes it, and its tabs. */
  browserOpen: boolean
}

const SKIP_ORDER: SkipReason[] = [
  "own",
  "address",
  "expired",
  "invalid",
  "indexeddb",
]

// What Chromium takes of a cookie (net/cookies/parsed_cookie.cc,
// canonical_cookie.cc): no control characters or ";" anywhere, no "=" in
// the name, name and value together at most 4096 bytes, an attribute at
// most 1024.
const MAX_NAME_VALUE_BYTES = 4096
const MAX_ATTRIBUTE_BYTES = 1024
const CONTROL_OR_SEMICOLON = /[\u0000-\u001f\u007f;]/
const HOST_LABEL = "[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?"
const HOST = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})+$`)

/** A JSON cookie: Playwright's, or a browser extension's (chrome.cookies). */
const JsonCookie = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string().optional(),
  expires: z.number().optional(),
  expirationDate: z.number().optional(),
  session: z.boolean().optional(),
  hostOnly: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.string().nullable().optional(),
})

const JsonOrigin = z.object({
  origin: z.string(),
  localStorage: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .optional(),
  indexedDB: z.array(z.unknown()).optional(),
})

/** A cookie as read, before it is checked. */
type RawCookie = {
  name: string
  value: string
  domain: string
  path: string
  /** Seconds since the epoch; -1 for a session cookie. */
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: Cookie["sameSite"]
  /** Whether the domain was named host-only (true) or for subdomains (false). */
  hostOnly?: boolean
}

type Context = {
  /** PCP's own host (its public address's), refused with its subdomains. */
  ownHost: string | null
  /** Seconds since the epoch. */
  now: number
}

/** A host's name as Chromium keeps it: lowercase, ASCII, no trailing dot. */
function normalHost(host: string): string {
  const lower = host.trim().toLowerCase().replace(/\.$/, "")
  return /^[\x00-\x7f]*$/.test(lower) ? lower : domainToASCII(lower)
}

/** Whether one host is the other or a subdomain of it, either way. */
function related(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

function isLoopbackName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost")
}

/** Why a host is no site to import for, or null when it is one. */
function hostProblem(host: string, context: Context): SkipReason | null {
  const bare = host.replace(/^\[|\]$/g, "")
  if (isIP(bare)) return "address"
  if (isLoopbackName(host)) return "own"
  if (!HOST.test(host) || host.length > 253) return "invalid"
  if (context.ownHost && related(host, context.ownHost)) return "own"
  return null
}

function sameSiteOf(value: string | null | undefined): Cookie["sameSite"] {
  switch (value?.toLowerCase()) {
    case "none":
    case "no_restriction":
      return "None"
    case "strict":
      return "Strict"
    default:
      // "lax", "unspecified" or none at all: Chrome's own default is Lax.
      return "Lax"
  }
}

/** A cookie checked as Chromium takes it, or why it is left out. */
function checkCookie(raw: RawCookie, context: Context): Cookie | SkipReason {
  let domain = normalHost(raw.domain)
  if (raw.hostOnly === true) domain = domain.replace(/^\./, "")
  if (raw.hostOnly === false && !domain.startsWith(".")) domain = `.${domain}`
  const host = domain.replace(/^\./, "")

  const problem = hostProblem(host, context)
  if (problem) return problem

  const { name, value } = raw
  const path = raw.path || "/"

  if (
    CONTROL_OR_SEMICOLON.test(name) ||
    name.includes("=") ||
    CONTROL_OR_SEMICOLON.test(value) ||
    (!name && !value) ||
    Buffer.byteLength(name) + Buffer.byteLength(value) > MAX_NAME_VALUE_BYTES
  ) {
    return "invalid"
  }

  if (
    !path.startsWith("/") ||
    CONTROL_OR_SEMICOLON.test(path) ||
    Buffer.byteLength(path) > MAX_ATTRIBUTE_BYTES
  ) {
    return "invalid"
  }

  if (!Number.isFinite(raw.expires)) return "invalid"
  const expires = raw.expires <= 0 ? -1 : raw.expires
  if (expires !== -1 && expires <= context.now) return "expired"

  // Chromium refuses SameSite=None without Secure; such a cookie (from a
  // browser that keeps them) is Lax, as Chrome treats one without the flag.
  const sameSite = raw.sameSite === "None" && !raw.secure ? "Lax" : raw.sameSite

  if (name.startsWith("__Secure-") && !raw.secure) return "invalid"
  if (
    name.startsWith("__Host-") &&
    (!raw.secure || path !== "/" || domain.startsWith("."))
  ) {
    return "invalid"
  }

  return {
    name,
    value,
    domain,
    path,
    expires,
    httpOnly: raw.httpOnly,
    secure: raw.secure,
    sameSite,
  }
}

function fromJsonCookie(entry: unknown): RawCookie | null {
  const parsed = JsonCookie.safeParse(entry)
  if (!parsed.success) return null
  const cookie = parsed.data

  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? "/",
    expires: cookie.session
      ? -1
      : (cookie.expires ?? cookie.expirationDate ?? -1),
    httpOnly: cookie.httpOnly ?? false,
    secure: cookie.secure ?? false,
    sameSite: sameSiteOf(cookie.sameSite),
    hostOnly: cookie.hostOnly,
  }
}

/**
 * A Netscape cookies.txt line: domain, subdomains (TRUE/FALSE), path,
 * secure, expiry (0 for a session), name, value; "#HttpOnly_" in front of
 * the domain for an HttpOnly cookie. Null for a line that is none.
 */
function fromCookiesTxtLine(line: string): RawCookie | null {
  let text = line
  let httpOnly = false

  if (text.startsWith("#HttpOnly_")) {
    httpOnly = true
    text = text.slice("#HttpOnly_".length)
  }

  const fields = text.split("\t")
  if (fields.length !== 6 && fields.length !== 7) return null
  const [domain, subdomains, path, secure, expiry, name, value = ""] = fields
  const flag = (field: string | undefined) => field?.toUpperCase() === "TRUE"
  if (!/^-?\d+(\.\d+)?$/.test(expiry ?? "")) return null

  return {
    name: name ?? "",
    value,
    domain: domain ?? "",
    path: path || "/",
    expires: Number(expiry),
    httpOnly,
    secure: flag(secure),
    // cookies.txt does not carry it.
    sameSite: "Lax",
    hostOnly: !flag(subdomains),
  }
}

function tooMany(): never {
  throw invalid(
    `The import holds more than ${MAX_IMPORT_COOKIES.toLocaleString("en-US")} cookies, more than the browser keeps.`,
  )
}

/** The import's entries, by format, before they are checked. */
function readEntries(text: string): {
  format: ImportFormat
  cookies: (RawCookie | null)[]
  origins: unknown[]
} {
  const trimmed = text.replace(/^﻿/, "").trim()

  if (!trimmed) {
    throw invalid("Paste a cookie export or choose its file.")
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let json: unknown

    try {
      json = JSON.parse(trimmed)
    } catch {
      throw invalid("That is not JSON PCP can read.")
    }

    if (Array.isArray(json)) {
      if (json.length > MAX_IMPORT_COOKIES) tooMany()
      return {
        format: "cookie-json",
        cookies: json.map(fromJsonCookie),
        origins: [],
      }
    }

    const state = z
      .object({
        cookies: z.array(z.unknown()).optional(),
        origins: z.array(z.unknown()).optional(),
      })
      .safeParse(json)

    if (!state.success || (!state.data.cookies && !state.data.origins)) {
      throw invalid(
        "That JSON is neither Playwright's storage state nor a list of cookies.",
      )
    }

    const cookies = state.data.cookies ?? []
    const origins = state.data.origins ?? []
    if (cookies.length > MAX_IMPORT_COOKIES) tooMany()

    if (origins.length > MAX_IMPORT_ORIGINS) {
      throw invalid(
        `The import holds storage for more than ${MAX_IMPORT_ORIGINS} sites.`,
      )
    }

    return {
      format: "storage-state",
      cookies: cookies.map(fromJsonCookie),
      origins,
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.trim() !== "" &&
        (!line.startsWith("#") || line.startsWith("#HttpOnly_")),
    )

  if (!lines.some((line) => line.includes("\t"))) {
    throw invalid(
      "That is not a cookie export PCP reads: Playwright's storage state, a JSON list of cookies, or a cookies.txt file.",
    )
  }

  if (lines.length > MAX_IMPORT_COOKIES) tooMany()
  return {
    format: "cookies-txt",
    cookies: lines.map(fromCookiesTxtLine),
    origins: [],
  }
}

function checkOrigin(
  entry: unknown,
  context: Context,
  skip: (reason: SkipReason) => void,
): Origin | null {
  const parsed = JsonOrigin.safeParse(entry)
  if (!parsed.success) {
    skip("invalid")
    return null
  }

  let url: URL
  try {
    url = new URL(parsed.data.origin)
  } catch {
    skip("invalid")
    return null
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    skip("invalid")
    return null
  }

  const problem = hostProblem(normalHost(url.hostname), context)
  if (problem) {
    skip(problem)
    return null
  }

  if (parsed.data.indexedDB?.length) skip("indexeddb")
  const localStorage = parsed.data.localStorage ?? []
  if (!localStorage.length) return null

  return {
    origin: url.origin,
    localStorage: localStorage.map(({ name, value }) => ({ name, value })),
  }
}

/** PCP's own host, from its public address. */
function ownHostOf(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null
  try {
    return normalHost(new URL(publicUrl).hostname)
  } catch {
    return null
  }
}

/**
 * Reads and checks an import. Throws for one PCP cannot read at all, or
 * with nothing in it to import; an entry it cannot use is counted and left
 * out. The same cookie twice is the last one.
 */
export function parseSignIns(
  text: string,
  {
    publicUrl,
    now = Date.now(),
  }: { publicUrl?: string | null; now?: number } = {},
): ParsedImport {
  if (Buffer.byteLength(text) > MAX_IMPORT_BYTES) {
    throw invalid(
      `The import is over ${MAX_IMPORT_BYTES / 1024 / 1024} MB, more than the browser keeps.`,
    )
  }

  const context: Context = { ownHost: ownHostOf(publicUrl), now: now / 1000 }
  const { format, cookies: raw, origins: rawOrigins } = readEntries(text)
  const skipped: Partial<Record<SkipReason, number>> = {}
  const skip = (reason: SkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  const cookies = new Map<string, Cookie>()

  for (const entry of raw) {
    const checked = entry ? checkCookie(entry, context) : "invalid"

    if (typeof checked === "string") {
      skip(checked)
      continue
    }

    cookies.set(
      `${checked.name}\u0000${checked.domain}\u0000${checked.path}`,
      checked,
    )
  }

  const origins = new Map<string, Origin>()

  for (const entry of rawOrigins) {
    const origin = checkOrigin(entry, context, skip)
    if (origin) origins.set(origin.origin, origin)
  }

  if (!cookies.size && !origins.size) {
    const left = SKIP_ORDER.filter((reason) => skipped[reason])
    throw invalid(
      left.length
        ? `Nothing in it can be imported: ${left.map((reason) => `${skipped[reason]} ${SKIP_LABELS[reason]}`).join(", ")}.`
        : "Nothing in it can be imported: it holds no cookies or local storage.",
    )
  }

  return {
    format,
    cookies: [...cookies.values()],
    origins: [...origins.values()],
    skipped,
  }
}

/** What the Browser page says of each reason, after its count. */
export const SKIP_LABELS: Record<SkipReason, string> = {
  own: "for PCP's own site or this machine",
  address: "for an IP address rather than a site's name",
  expired: "expired",
  invalid: "that Chromium would not take",
  indexeddb: "sites' IndexedDB, which is not imported",
}

function cookieHost(cookie: { domain: string }): string {
  return normalHost(cookie.domain).replace(/^\./, "")
}

function originHost(origin: { origin: string }): string | null {
  try {
    return normalHost(new URL(origin.origin).hostname)
  } catch {
    return null
  }
}

/** The hosts an import names: its cookies' domains and its origins'. */
function sitesOfImport(imported: ParsedImport): Set<string> {
  const sites = new Set(imported.cookies.map(cookieHost))
  for (const origin of imported.origins) {
    const host = originHost(origin)
    if (host) sites.add(host)
  }
  return sites
}

/**
 * The profile with the import in it: for every site the import names
 * (a host, its subdomains and the domains above it), what the profile held
 * goes, cookies, local storage and IndexedDB alike, and the import's takes
 * its place. Every other site stays as it was.
 */
export function mergeSignIns(
  existing: StorageState | null,
  imported: ParsedImport,
): StorageState {
  const sites = [...sitesOfImport(imported)]
  const covered = (host: string | null) =>
    host !== null && sites.some((site) => related(host, site))

  return {
    cookies: [
      ...(existing?.cookies ?? []).filter(
        (cookie) => !covered(cookieHost(cookie)),
      ),
      ...imported.cookies,
    ],
    origins: [
      ...(existing?.origins ?? []).filter(
        (origin) => !covered(originHost(origin)),
      ),
      ...imported.origins,
    ],
  }
}

/** What the import replaces in the profile: its sites and cookies there. */
function replacedBy(
  existing: StorageState | null,
  imported: ParsedImport,
): ImportPreview["replaces"] {
  if (!existing) return { sites: 0, cookies: 0 }
  const sites = [...sitesOfImport(imported)]
  const hosts = new Set<string>()
  let cookies = 0

  for (const cookie of existing.cookies) {
    const host = cookieHost(cookie)
    if (sites.some((site) => related(host, site))) {
      hosts.add(host)
      cookies++
    }
  }

  for (const origin of existing.origins) {
    const host = originHost(origin)
    if (host && sites.some((site) => related(host, site))) hosts.add(host)
  }

  return { sites: hosts.size, cookies }
}

function basisOf(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** The Browser page's preview of an import, before anything is written. */
export async function previewSignInImport(
  ctx: VaultContext,
  text: string,
  { publicUrl }: { publicUrl?: string | null } = {},
): Promise<ImportPreview> {
  const imported = parseSignIns(text, { publicUrl })
  const bySite = new Map<string, { cookies: number; storage: number }>()
  const entry = (site: string) => {
    const found = bySite.get(site) ?? { cookies: 0, storage: 0 }
    bySite.set(site, found)
    return found
  }

  for (const cookie of imported.cookies) entry(cookieHost(cookie)).cookies++
  for (const origin of imported.origins) {
    entry(originHost(origin) ?? origin.origin).storage++
  }

  return {
    format: imported.format,
    basis: basisOf(text),
    sites: [...bySite.entries()]
      .map(([site, counts]) => ({ site, ...counts }))
      .sort((a, b) => a.site.localeCompare(b.site)),
    cookies: imported.cookies.length,
    origins: imported.origins.length,
    skipped: SKIP_ORDER.filter((reason) => imported.skipped[reason]).map(
      (reason) => ({
        reason,
        count: imported.skipped[reason]!,
        label: SKIP_LABELS[reason],
      }),
    ),
    replaces: replacedBy(await loadProfile(ctx), imported),
    browserOpen: runningBrowser(ctx.vaultId) !== null,
  }
}

/**
 * Imports what the preview showed (`basis`) into the profile, with the
 * browser closed (its profile saved first) so it cannot save over it; the
 * next page it opens starts from the merged profile.
 */
export async function importSignIns(
  ctx: VaultContext,
  text: string,
  basis: string,
  { publicUrl }: { publicUrl?: string | null } = {},
): Promise<{ sites: number; cookies: number }> {
  if (basisOf(text) !== basis) {
    throw invalid("The import is not the one previewed. Preview it again.")
  }

  const imported = parseSignIns(text, { publicUrl })

  await withBrowserClosed(ctx, async () => {
    const [existing, summary] = await Promise.all([
      loadProfile(ctx),
      profileSummary(ctx.vaultId),
    ])
    await writeProfile(ctx, mergeSignIns(existing, imported), {
      partial: summary?.partial ?? false,
    })
  })

  return {
    sites: sitesOfImport(imported).size,
    cookies: imported.cookies.length,
  }
}
