/**
 * Values shared with client components. Nothing here may import anything:
 * a client bundle that reaches lib/core proper would drag Prisma in.
 */

export const MIN_PASSWORD_LENGTH = 10

/**
 * What PCP answers when the Mac app hands over a Touch ID key that no longer
 * opens anything (lib/core/device-keys.ts). The page tells the app to forget
 * its copy when it sees this.
 */
export const TOUCH_ID_REJECTED =
  "Touch ID is no longer set up for PCP. Use your password."

export const DEFAULT_HEADER_NAME = "Authorization"
export const DEFAULT_VALUE_TEMPLATE = "Bearer {{secret}}"
export const SECRET_PLACEHOLDER = "{{secret}}"
/**
 * The most headers a server's credential goes in, the first included: an API
 * that takes a key and a secret key, each in its own header, needs two.
 */
export const MAX_AUTH_HEADERS = 5

/**
 * The secret picker's choice for one typed into the form there and then,
 * saved as a new secret when the form is.
 */
export const NEW_SECRET = "new"

/**
 * The largest sign-in import the Browser page takes (a cookie export or
 * Playwright's storage state), as the browser's profile is at most.
 */
export const MAX_SIGN_IN_IMPORT_BYTES = 8 * 1024 * 1024

/** The largest OpenAPI schema PCP reads, uploaded or downloaded. */
export const MAX_SPEC_BYTES = 5 * 1024 * 1024
export const SPEC_FILE_ACCEPT =
  ".json,.yaml,.yml,application/json,application/yaml,text/yaml"

/**
 * An export of everything PCP holds (lib/core/backup.ts): the file's
 * extension, and the most PCP reads of one. The file is a JSON envelope
 * around compressed, encrypted rows; the second limit is what those rows
 * may unpack to, well under what V8 lets one string hold.
 */
export const EXPORT_FILE_SUFFIX = ".pcpexport"
export const EXPORT_FILE_ACCEPT = EXPORT_FILE_SUFFIX
export const MAX_EXPORT_FILE_BYTES = 64 * 1024 * 1024
export const MAX_EXPORT_PAYLOAD_BYTES = 256 * 1024 * 1024

/**
 * What one API token may do with one tool. `ask` is the default: the owner
 * is asked the first time, and decides then for the calls after it.
 */
export const TOOL_ACCESS_LEVELS = ["allowed", "ask", "blocked"] as const

export type ToolAccess = (typeof TOOL_ACCESS_LEVELS)[number]

export const DEFAULT_TOOL_ACCESS: ToolAccess = "ask"

export const TOOL_ACCESS_LABELS: Record<ToolAccess, string> = {
  allowed: "Allowed",
  ask: "Ask you first",
  blocked: "Blocked",
}

/**
 * How much a tool can do (lib/core/tool-tiers.ts): read, change (write) or
 * change or delete for good (destructive). Each tier has its own entry
 * tools (call_tool_<tier>, run_code_<tier>), which run tools at or below
 * it, so a client can let Read through without asking each time.
 */
export const TOOL_TIERS = ["read", "write", "destructive"] as const

export type ToolTier = (typeof TOOL_TIERS)[number]

export const TOOL_TIER_LABELS: Record<ToolTier, string> = {
  read: "Read",
  write: "Write",
  destructive: "Destructive",
}

/** What each tier means, in a line, for the owner's pages. */
export const TOOL_TIER_HINTS: Record<ToolTier, string> = {
  read: "Only reads.",
  write: "Changes things, but deletes nothing for good.",
  destructive: "Can change or delete things for good.",
}

/**
 * How the owner can answer an assistant's request. Each kind offers some of
 * them (lib/core/permission-rules.ts); "discard" is only for a memory an
 * assistant wants to share, and "allow_for" (for one of ALLOW_FOR_MINUTES)
 * only where "always" is offered.
 */
export const PERMISSION_DECISIONS = [
  "allow_once",
  "allow_for",
  "always",
  "block",
  "decline",
  "discard",
] as const

export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

/**
 * How long "Allow for" lets a tool, or a site, run without asking the owner
 * (lib/core/allowances.ts), in minutes.
 */
export const ALLOW_FOR_MINUTES = [15, 60, 480] as const

export type AllowForMinutes = (typeof ALLOW_FOR_MINUTES)[number]

/** What the owner's page offers first. */
export const DEFAULT_ALLOW_FOR_MINUTES: AllowForMinutes = 60

/**
 * How long "Allow for" lets the browser type a secret at a site
 * (lib/core/browser-secrets.ts): an hour, not a choice.
 */
export const SECRET_ALLOW_MINUTES = 60

/**
 * A password PCP makes for a secret (lib/core/generate-password.ts), from
 * request_secret's `generate` or the Generate switch on its page: how long,
 * which kinds of character, and which characters to leave out.
 */
export type PasswordRecipe = {
  length: number
  lowercase: boolean
  uppercase: boolean
  digits: boolean
  symbols: boolean
  /** Characters left out, for a site that refuses some. */
  exclude: string
}

export const MIN_GENERATED_LENGTH = 8
export const MAX_GENERATED_LENGTH = 128
export const MAX_GENERATE_EXCLUDE = 64
/** The symbols a made password draws from: printable ASCII, no quote, backslash or space. */
export const PASSWORD_SYMBOLS = "!#$%&()*+,-./:;<=>?@[]^_{|}~"

export const DEFAULT_PASSWORD_RECIPE: PasswordRecipe = {
  length: 24,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: true,
  exclude: "",
}

export function allowForLabel(minutes: number): string {
  return minutes < 60
    ? `${minutes} minutes`
    : minutes === 60
      ? "1 hour"
      : `${minutes / 60} hours`
}

export type PermissionKind =
  | "call"
  | "register"
  | "memory_share"
  | "memory_change"
  | "access"
  | "endpoint_change"
  | "fetch"
  | "browse"
  | "browser_handover"
  | "secret_use"
  | "secret_request"
  | "secret_sites_change"
  | "exit_use"
  | "script_use"
  | "wrapper_change"
  | "skill_change"
  | "repo_change"
  | "repo_share"
  | "note_change"
  | "service_change"

/**
 * The HTTP methods web_fetch has a level for. Each is the default for a
 * site without a level of its own; OTHER covers every other method it
 * sends (HEAD, OPTIONS and the rest).
 */
export const FETCH_METHOD_GROUPS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OTHER",
] as const

export type FetchMethodGroup = (typeof FETCH_METHOD_GROUPS)[number]

export const FETCH_METHOD_LABELS: Record<
  FetchMethodGroup,
  { label: string; hint: string }
> = {
  GET: { label: "GET", hint: "Reading a page." },
  POST: { label: "POST", hint: "Sending a form or data." },
  PUT: { label: "PUT", hint: "Putting something at the address." },
  PATCH: { label: "PATCH", hint: "Changing part of something." },
  DELETE: { label: "DELETE", hint: "Deleting something." },
  OTHER: { label: "Other methods", hint: "HEAD, OPTIONS and the rest." },
}

/** A site's level: one of the tool levels, or whatever its method has. */
export const FETCH_SITE_LEVELS = ["default", ...TOOL_ACCESS_LEVELS] as const

export type FetchSiteLevel = (typeof FETCH_SITE_LEVELS)[number]

export const FETCH_SITE_LABELS: Record<FetchSiteLevel, string> = {
  default: "Use the method settings",
  ...TOOL_ACCESS_LABELS,
}

/**
 * Whether web_fetch and the browser may reach private addresses (the
 * owner's own network): blocked unless the owner allows it; never asked.
 */
export const FETCH_PRIVATE_LEVELS = ["blocked", "allowed"] as const

export const FETCH_PRIVATE_LABELS: Record<
  (typeof FETCH_PRIVATE_LEVELS)[number],
  string
> = {
  blocked: "Blocked",
  allowed: "Allowed",
}

/** The size every browser tab renders at, in CSS pixels. */
export const BROWSER_VIEWPORT = { width: 1280, height: 800 } as const

/** How often the live view sends the owner's input, in milliseconds. */
export const BROWSER_INPUT_EVERY_MS = 40

/** The longest memory, in characters. */
export const MAX_MEMORY_CHARS = 10_000

/**
 * The longest shared memory: short enough that the owner reads all of it
 * when an assistant asks to share it.
 */
export const MAX_SHARED_MEMORY_CHARS = 2_000

/**
 * The longest instructions the owner gives one assistant
 * (lib/core/instructions.ts): short enough to sit at the start of every
 * conversation.
 */
export const MAX_INSTRUCTIONS_CHARS = 4_000

/** The longest memory path, without the leading /memories/. */
export const MAX_MEMORY_PATH = 200

/**
 * Skills (lib/core/skills.ts): procedures the owner approved. The longest
 * name (a slug, as an Agent Skill's), description and body, how many
 * reference files one carries and how long each is, how many tools it
 * names, and how many skills a vault keeps. Short enough that the owner
 * reads a whole skill before agreeing to an assistant's change.
 */
export const MAX_SKILL_NAME = 64
export const MAX_SKILL_DESCRIPTION = 300
export const MAX_SKILL_BODY = 20_000
export const MAX_SKILL_FILES = 10
export const MAX_SKILL_FILE_CHARS = 20_000
export const MAX_SKILL_FILE_PATH = 100
export const MAX_SKILL_TOOLS = 30
export const MAX_SKILLS = 200
/**
 * How many skills one token keeps for itself (/skills/mine/), of the
 * vault's MAX_SKILLS: written without asking, so one token cannot fill the
 * vault.
 */
export const MAX_OWN_SKILLS = 50

/**
 * The owner's own note on a server or skill (lib/core/definitions.ts): one
 * line, short enough that it sits beside the description in what an
 * assistant reads.
 */
export const MAX_PERSONAL_NOTE = 300

/**
 * Dynamic DNS services PCP can keep pointed at this machine
 * (lib/core/network/ddns.ts). DuckDNS is the one the setup page suggests:
 * free, and a single token.
 */
export const DDNS_PROVIDERS = [
  "duckdns",
  "dyndns2",
  "cloudflare",
  "custom",
] as const

export type DdnsProvider = (typeof DDNS_PROVIDERS)[number]

export const DDNS_PROVIDER_LABELS: Record<
  DdnsProvider,
  { label: string; hint: string }
> = {
  duckdns: {
    label: "DuckDNS",
    hint: "Free, and the easiest: a name and a token.",
  },
  dyndns2: {
    label: "No-IP, Dynu and others",
    hint: "Services that speak the common dyndns2 update protocol, with a username and password.",
  },
  cloudflare: {
    label: "Cloudflare",
    hint: "A domain you own on Cloudflare, with an API token that may edit its DNS.",
  },
  custom: {
    label: "Another service (an update URL)",
    hint: "Any service that updates when PCP opens a URL.",
  },
}

/** Where the owner signs in to DuckDNS, adds a name and finds the token. */
export const DUCKDNS_URL = "https://www.duckdns.org/"

const DUCKDNS_TOKEN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const DUCKDNS_NAME =
  /(?:[?&]domains=([a-z0-9-]+)|\b(?!www\.)([a-z0-9-]+)\.duckdns\.org)/i

/**
 * The token, and the name if it is there, in whatever the owner pasted from
 * duckdns.org: the token alone, or a whole update line from its install
 * page (…/update?domains=name&token=…). DuckDNS has no way to hand a token
 * over but the screen, and copying exactly the token from it is fiddly,
 * on a phone above all. Shared by the form and lib/core/network/ddns.ts.
 */
export function readDuckDnsPaste(text: string): {
  token: string | null
  subdomain: string | null
} {
  const name = DUCKDNS_NAME.exec(text)

  return {
    token: DUCKDNS_TOKEN.exec(text)?.[0].toLowerCase() ?? null,
    subdomain: (name?.[1] ?? name?.[2])?.toLowerCase() ?? null,
  }
}

/** dyndns2 services PCP knows the update address of. */
export const DYNDNS2_SERVERS: Record<string, string> = {
  "dynupdate.no-ip.com": "No-IP",
  "api.dynu.com": "Dynu",
}

/** Let's Encrypt's agreements, which turning HTTPS on accepts. */
export const LETS_ENCRYPT_TERMS_URL = "https://letsencrypt.org/repository/"

/** Where the owner signs in to pcp.gg, picks a name and copies a key. */
export const PCPGG_URL = "https://pcp.gg/"

/**
 * The anchor of the "Public addresses only" switch on a server's page (an
 * MCP server's or an API endpoint's): where a refusal of a private address,
 * and the approval of a server at one, send the owner.
 */
export const PUBLIC_ONLY_ANCHOR = "public-only"

/**
 * Where search's embeddings come from (lib/core/embeddings/), as Settings
 * offers them: Voyage AI, any OpenAI-compatible /v1/embeddings address, or
 * an API endpoint a service registered (text-embeddings-inference from
 * PCP's common items).
 */
export const EMBEDDING_PROVIDERS = ["voyage", "openai", "endpoint"] as const

export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number]

/** What search may send a provider to embed. */
export type EmbeddedKinds = {
  /** Tools' names and descriptions, PCP's own included. */
  tools: boolean
  skills: boolean
  memories: boolean
}

/** Voyage AI's embeddings address, and the model Settings starts with. */
export const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings"
export const VOYAGE_DEFAULT_MODEL = "voyage-3.5-lite"
export const OPENAI_DEFAULT_MODEL = "text-embedding-3-small"

/**
 * Whether an address reads as the owner's own machine or network: a name
 * with no dot, localhost, .local, .lan, .internal, .home.arpa, or a private,
 * loopback, shared (CGNAT, as Tailscale's) or link-local IP literal.
 */
export function looksSelfHosted(url: string): boolean {
  let host: string

  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "")
  } catch {
    return false
  }

  if (
    !host.includes(".") ||
    /(^|\.)(localhost|local|lan|internal|home\.arpa)$/.test(host)
  ) {
    return true
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)

  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]

    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    )
  }

  return host === "::1" || /^f[cd]/.test(host) || host.startsWith("fe80:")
}

/**
 * What a provider embeds until the owner chooses: a service on the owner's
 * own machine (an endpoint, or an OpenAI-compatible address on their
 * network) everything; one elsewhere (Voyage AI, any other address) the
 * tools' names and descriptions only, so no skill or memory leaves PCP
 * unless the owner ticks it.
 */
export function defaultEmbedded(
  provider: EmbeddingProvider,
  url = "",
): EmbeddedKinds {
  const own =
    provider === "endpoint" || (provider === "openai" && looksSelfHosted(url))

  return { tools: true, skills: own, memories: own }
}
