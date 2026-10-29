import { createHash } from "node:crypto"

/**
 * What in files about to be pushed to a repository looks like the owner's
 * own: an email address, one of their domains or hosts, an IP address, an
 * id of a server or app, their name, a phone number, a path with a user
 * name in it, or something shaped like a token. Pure: the owner's facts
 * (ownerFactsFrom) come from the caller, read from the vault.
 *
 * It is a heuristic and meant to be quiet: an example address, a loopback
 * or documentation IP, a vendor's public API host the owner merely uses, a
 * nil UUID or the classic example one, a generic user name in a path are
 * not hits. A push to a public repository waits until every hit is fixed
 * or the owner says it is fine to publish (share-review.ts); for a private
 * one the hits are advice.
 */

export type PersonalKind =
  "token" | "email" | "host" | "ip" | "id" | "phone" | "home_path" | "name"

export type PersonalLocation = {
  /** The file, by its path in the repository. */
  path: string
  /** 1-based. */
  line: number
  /** 1-based, in characters. */
  column: number
}

export type PersonalHit = {
  /** Stable for the same kind and text, so a tick survives a reload. */
  id: string
  kind: PersonalKind
  /** The text found, as it is in the file. */
  match: string
  /** What it looks like, in words. */
  label: string
  /** Everywhere it is, in file then line order. */
  locations: PersonalLocation[]
}

/** What the vault knows of its owner, as the detectors read it. */
export type OwnerFacts = {
  /** The owner's own hosts, lowercase: matched whole. */
  hosts: string[]
  /** The owner's own domains, lowercase: they and any host under them. */
  domains: string[]
  /** Distinctive labels of the owner's hosts (a machine's name), lowercase. */
  labels: string[]
  /** The owner's name, word by word, and their user names. */
  names: string[]
  /** The owner's own email addresses, lowercase. */
  emails: string[]
}

export const NO_FACTS: OwnerFacts = {
  hosts: [],
  domains: [],
  labels: [],
  names: [],
  emails: [],
}

const LABELS: Record<PersonalKind, string> = {
  token: "Looks like a secret or token",
  email: "An email address",
  host: "One of your own addresses",
  ip: "An IP address",
  id: "An ID of a server, app or account",
  phone: "A phone number",
  home_path: "A path with a user name in it",
  name: "Your name",
}

// ---- The owner's facts --------------------------------------------------------

/** Domains of providers many people use: never anyone's own. */
const SHARED_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "google.com",
  "googleapis.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "office365.com",
  "microsoft.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "apple.com",
  "yahoo.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "fastmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "aol.com",
  "hey.com",
  "zoho.com",
  "mail.com",
  "github.com",
  "githubusercontent.com",
  "githubcopilot.com",
  "gitlab.com",
  "amazonaws.com",
  "cloudflare.com",
  "anthropic.com",
  "openai.com",
  "atlassian.net",
  "slack.com",
  "notion.so",
  "notion.com",
  "linear.app",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "azurewebsites.net",
  "cloudfront.net",
  "workers.dev",
  "pages.dev",
  "fly.dev",
  "onrender.com",
  "supabase.co",
  "ngrok.io",
  "ngrok-free.app",
  "ts.net",
  "pcp.gg",
  "example.com",
  "example.org",
  "example.net",
])

/** Second levels under which a domain has three labels (example.co.uk). */
const SECOND_LEVELS = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "co.za",
  "com.br",
  "com.mx",
  "co.in",
  "com.tr",
])

/** Words too common to be anyone's in particular, as a host label or a name. */
const COMMON_WORDS = new Set([
  "www",
  "mail",
  "smtp",
  "imap",
  "pop3",
  "caldav",
  "carddav",
  "api",
  "apis",
  "app",
  "apps",
  "cloud",
  "home",
  "server",
  "servers",
  "host",
  "hosts",
  "mcp",
  "dev",
  "prod",
  "production",
  "staging",
  "test",
  "docs",
  "auth",
  "login",
  "admin",
  "portal",
  "panel",
  "dash",
  "dashboard",
  "cool",
  "coolify",
  "proxy",
  "gateway",
  "node",
  "local",
  "status",
  "files",
  "data",
  "user",
  "users",
  "owner",
  "vault",
  "team",
  "info",
  "hello",
  "contact",
  "support",
  "office",
  "postmaster",
  "noreply",
  "no-reply",
  "the",
  "and",
  "my",
  "pcp",
  "will",
  "mark",
  "may",
  "bill",
  "rose",
  "grace",
  "hope",
  "joy",
  "art",
  "ray",
  "dawn",
  "faith",
  "june",
  "april",
  "august",
  "page",
  "chase",
  "hunter",
  "mason",
  "rich",
  "frank",
  "sky",
  "max",
])

const PRIVATE_SUFFIXES = [
  ".local",
  ".lan",
  ".home",
  ".internal",
  ".home.arpa",
  ".ts.net",
  ".corp",
  ".intranet",
]

/** The registrable domain of a host, near enough: example.co.uk, kaperkun.de. */
export function domainOf(host: string): string | null {
  const labels = host.toLowerCase().split(".").filter(Boolean)

  if (labels.length < 2 || isIpv4(host) || host.includes(":")) {
    return null
  }

  const lastTwo = labels.slice(-2).join(".")

  return SECOND_LEVELS.has(lastTwo) && labels.length >= 3
    ? labels.slice(-3).join(".")
    : lastTwo
}

function hostOf(address: string): string | null {
  const text = address.trim()

  if (!text) {
    return null
  }

  try {
    const host = new URL(text.includes("://") ? text : `x://${text}`).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
    return host || null
  } catch {
    return null
  }
}

function isPrivateHost(host: string): boolean {
  return (
    !host.includes(".") ||
    isIpv4(host) ||
    host.includes(":") ||
    PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
  )
}

function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("127.") ||
    host === "::1" ||
    host === "0.0.0.0"
  )
}

/**
 * The owner's facts, from what the vault holds: PCP's public address, the
 * addresses of the owner's servers and accounts, the email addresses they
 * sign in with, and their name.
 *
 * - Their domains: the public address's, their email addresses' (not a
 *   mail provider's), and any domain two or more of their servers are
 *   under (not a provider's), e.g. two Coolify hosts at kaperkun.de.
 * - Their hosts: the public address, SSH servers, and any server address
 *   that is a private name or an IP, or under one of their domains. A
 *   vendor's public API the owner merely uses (api.hetzner.cloud) is not.
 * - Labels: the first label of each of their hosts, when it is a name of
 *   its own (gaaf in gaaf.kaperkun.de), not a word like api or mail.
 */
export function ownerFactsFrom(input: {
  publicUrl?: string | null
  /** Every server's and account's address, of any kind. */
  serverAddresses: string[]
  /** Addresses that are certainly the owner's own machines (SSH servers). */
  ownAddresses?: string[]
  /** Email addresses the owner signs in or sends with. */
  emails: string[]
  ownerName?: string | null
}): OwnerFacts {
  const emails = [
    ...new Set(
      input.emails
        .map((email) => email.trim().toLowerCase())
        .filter((email) => fullMatch(EMAIL, email)),
    ),
  ]
  const domains = new Set<string>()
  const hosts = new Set<string>()
  const addHost = (host: string | null) => {
    if (host && !isLoopback(host)) {
      hosts.add(host)
    }
  }

  const publicHost = input.publicUrl ? hostOf(input.publicUrl) : null

  if (publicHost && !isLoopback(publicHost)) {
    addHost(publicHost)
    const domain = domainOf(publicHost)

    if (domain && !SHARED_DOMAINS.has(domain)) {
      domains.add(domain)
    }
  }

  for (const email of emails) {
    const domain = domainOf(email.slice(email.lastIndexOf("@") + 1))

    if (domain && !SHARED_DOMAINS.has(domain)) {
      domains.add(domain)
    }
  }

  const serverHosts = [
    ...new Set(
      input.serverAddresses
        .map(hostOf)
        .filter((host): host is string => !!host && !isLoopback(host)),
    ),
  ]
  const hostsByDomain = new Map<string, number>()

  for (const host of serverHosts) {
    const domain = domainOf(host)

    if (domain) {
      hostsByDomain.set(domain, (hostsByDomain.get(domain) ?? 0) + 1)
    }
  }

  for (const [domain, count] of hostsByDomain) {
    if (count >= 2 && !SHARED_DOMAINS.has(domain)) {
      domains.add(domain)
    }
  }

  for (const address of input.ownAddresses ?? []) {
    addHost(hostOf(address))
  }

  for (const host of serverHosts) {
    const domain = domainOf(host)

    if (isPrivateHost(host) || (domain && domains.has(domain))) {
      addHost(host)
    }
  }

  const labels = new Set<string>()

  for (const host of hosts) {
    if (isIpv4(host) || host.includes(":")) {
      continue
    }

    const first = host.split(".")[0]!

    if (first.length >= 4 && !COMMON_WORDS.has(first) && /[a-z]/.test(first)) {
      labels.add(first)
    }
  }

  const names = new Set<string>()

  for (const word of (input.ownerName ?? "").split(/[^\p{L}\p{N}'-]+/u)) {
    if (word.length >= 3 && !COMMON_WORDS.has(word.toLowerCase())) {
      names.add(word)
    }
  }

  for (const email of emails) {
    const local = email.slice(0, email.indexOf("@"))

    if (
      local.length >= 4 &&
      !COMMON_WORDS.has(local) &&
      /^[a-z0-9._-]+$/.test(local)
    ) {
      names.add(local)
    }
  }

  return {
    hosts: [...hosts].sort(),
    domains: [...domains].sort(),
    labels: [...labels].sort(),
    names: [...names].sort(),
    emails,
  }
}

// ---- Detectors ----------------------------------------------------------------

const EMAIL =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/

function fullMatch(pattern: RegExp, text: string): boolean {
  const found = new RegExp(`^(?:${pattern.source})$`).exec(text)
  return found !== null
}

function isIpv4(text: string): boolean {
  const parts = text.split(".")
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** An example or placeholder domain: never anyone's. */
function isExampleDomain(domain: string): boolean {
  const lower = domain.toLowerCase()
  return (
    /(^|\.)example(\.[a-z]+)?$/.test(lower) ||
    /\.(example|test|invalid|localhost|local)$/.test(lower) ||
    lower === "localhost"
  )
}

type Found = { start: number; end: number; kind: PersonalKind; text: string }

type Detector = (line: string, facts: OwnerFacts) => Found[]

function all(
  pattern: RegExp,
  line: string,
  kind: PersonalKind,
  keep: (text: string, match: RegExpExecArray) => boolean = () => true,
  group = 0,
): Found[] {
  const found: Found[] = []
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  )

  for (const match of line.matchAll(global)) {
    const text = match[group]

    if (text === undefined || !keep(text, match)) {
      continue
    }

    const start = match.index + (group === 0 ? 0 : match[0].indexOf(text))
    found.push({ start, end: start + text.length, kind, text })
  }

  return found
}

const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-(?:ant-|live-|test-|proj-)?[A-Za-z0-9_-]{16,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

function entropy(text: string): number {
  const counts = new Map<string, number>()

  for (const char of text) {
    counts.set(char, (counts.get(char) ?? 0) + 1)
  }

  let bits = 0

  for (const count of counts.values()) {
    const p = count / text.length
    bits -= p * Math.log2(p)
  }

  return bits
}

/** A long run of mixed case and digits with no shape of a word: a key. */
function looksRandom(text: string): boolean {
  return (
    text.length >= 32 &&
    /[A-Z]/.test(text) &&
    /[a-z]/.test(text) &&
    /\d/.test(text) &&
    // Words in camelCase or snake_case are not keys.
    !/(?:[A-Z][a-z]{3,}){3}/.test(text) &&
    !/(?:[a-z]{4,}_){2}/.test(text) &&
    entropy(text) >= 4.2
  )
}

const detectToken: Detector = (line) => [
  ...TOKEN_PATTERNS.flatMap((pattern) => all(pattern, line, "token")),
  ...all(/[A-Za-z0-9_+/=-]{32,}/, line, "token", looksRandom),
]

const NOREPLY = /^(?:no-?reply|do-?not-?reply|git)$/i

const detectEmail: Detector = (line) =>
  all(EMAIL, line, "email", (text) => {
    const at = text.lastIndexOf("@")
    return (
      !isExampleDomain(text.slice(at + 1)) && !NOREPLY.test(text.slice(0, at))
    )
  })

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const detectHost: Detector = (line, facts) =>
  [
    ...facts.hosts.map(
      (host) =>
        new RegExp(`(?<![A-Za-z0-9-])${escape(host)}(?![A-Za-z0-9-])`, "i"),
    ),
    ...facts.domains.map(
      (domain) =>
        new RegExp(
          `(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\\.)*${escape(domain)}(?![A-Za-z0-9-])`,
          "i",
        ),
    ),
    ...facts.labels.map(
      (label) =>
        new RegExp(`(?<![A-Za-z0-9])${escape(label)}(?![A-Za-z0-9])`, "i"),
    ),
  ].flatMap((pattern) => all(pattern, line, "host"))

const DOCUMENTATION_IPS = [/^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./]
const PUBLIC_RESOLVERS = new Set([
  "1.1.1.1",
  "1.0.0.1",
  "8.8.8.8",
  "8.8.4.4",
  "9.9.9.9",
])

const detectIp: Detector = (line) => [
  ...all(
    /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w]|\.\d)/,
    line,
    "ip",
    (text, match) =>
      isIpv4(text) &&
      !/[vV]$/.test(line.slice(0, match.index)) &&
      !text.startsWith("127.") &&
      !text.startsWith("0.") &&
      !text.startsWith("255.") &&
      !PUBLIC_RESOLVERS.has(text) &&
      !DOCUMENTATION_IPS.some((range) => range.test(text)),
  ),
  ...all(
    /(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4}:?){1,6}(?![\w:])/,
    line,
    "ip",
    (text) =>
      text.split(":").filter(Boolean).length >= 3 &&
      text.split(":").some((group) => group.length >= 3) &&
      !/^2001:db8:/i.test(text) &&
      !/^fe80:/i.test(text),
  ),
]

const EXAMPLE_UUIDS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "123e4567-e89b-12d3-a456-426614174000",
  "123e4567-e89b-12d3-a456-426655440000",
  "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "550e8400-e29b-41d4-a716-446655440000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
])

const detectId: Detector = (line) => [
  ...all(
    /(?<![0-9A-Fa-f-])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Fa-f-])/,
    line,
    "id",
    (text) => !EXAMPLE_UUIDS.has(text.toLowerCase()),
  ),
  // Coolify's resource ids (cuid2) and other 24-character ids: lowercase
  // letters and digits, both.
  ...all(
    /(?<![A-Za-z0-9_-])[a-z0-9]{24}(?![A-Za-z0-9_-])/,
    line,
    "id",
    (text) =>
      (text.match(/\d/g)?.length ?? 0) >= 2 &&
      (text.match(/[a-z]/g)?.length ?? 0) >= 2,
  ),
]

const detectPhone: Detector = (line) => [
  ...all(/(?<![\w+])\+\d[\d\s().-]{6,18}\d(?![\w])/, line, "phone", (text) => {
    const digits = text.replace(/\D/g, "").length
    return digits >= 8 && digits <= 15 && !/\.\d+\./.test(text)
  }),
  ...all(/(?<![\w])\(\d{3}\)\s?\d{3}[-.\s]\d{4}(?![\w])/, line, "phone"),
]

const GENERIC_USERS = new Set([
  "user",
  "username",
  "you",
  "me",
  "runner",
  "ubuntu",
  "root",
  "node",
  "app",
  "admin",
  "example",
  "name",
  "yourname",
  "your-name",
  "your_name",
  "pi",
  "vscode",
  "coder",
  "jovyan",
  "default",
  "public",
  "shared",
  "guest",
  "linuxbrew",
])

const detectHomePath: Detector = (line) =>
  all(
    /(?:\/home\/|\/Users\/|[A-Za-z]:[\\/]Users[\\/])([A-Za-z0-9._-]+)/,
    line,
    "home_path",
    (_text, match) => !GENERIC_USERS.has(match[1]!.toLowerCase()),
  )

const detectName: Detector = (line, facts) =>
  facts.names.flatMap((name) =>
    all(
      new RegExp(
        `(?<![\\p{L}\\p{N}_])${escape(name)}(?![\\p{L}\\p{N}_])`,
        // A short name counts only as it is written; a longer one in any case.
        name.length >= 4 ? "iu" : "u",
      ),
      line,
      "name",
    ),
  )

/** In order: what an earlier one finds, a later one does not find again. */
const DETECTORS: Detector[] = [
  detectToken,
  detectEmail,
  detectHost,
  detectIp,
  detectId,
  detectPhone,
  detectHomePath,
  detectName,
]

export function hitId(kind: PersonalKind, match: string): string {
  return createHash("sha256")
    .update(`${kind}\n${match.toLowerCase()}`)
    .digest("hex")
    .slice(0, 16)
}

/**
 * Every hit in the files, one per kind and text with every place it is,
 * in the order they first appear. Pure.
 */
export function findPersonalData(
  files: Record<string, string>,
  facts: OwnerFacts = NO_FACTS,
): PersonalHit[] {
  const hits = new Map<string, PersonalHit>()

  for (const path of Object.keys(files).sort()) {
    const lines = files[path]!.replace(/\r\n?/g, "\n").split("\n")

    lines.forEach((line, index) => {
      const taken: Array<[number, number]> = []

      for (const detect of DETECTORS) {
        for (const found of detect(line, facts).sort(
          (a, b) => a.start - b.start || b.end - a.end,
        )) {
          if (
            taken.some(([start, end]) => found.start < end && found.end > start)
          ) {
            continue
          }

          taken.push([found.start, found.end])
          const id = hitId(found.kind, found.text)
          const location = { path, line: index + 1, column: found.start + 1 }
          const hit = hits.get(id)

          if (hit) {
            hit.locations.push(location)
          } else {
            hits.set(id, {
              id,
              kind: found.kind,
              match: found.text,
              label: LABELS[found.kind],
              locations: [location],
            })
          }
        }
      }
    })
  }

  return [...hits.values()]
}
