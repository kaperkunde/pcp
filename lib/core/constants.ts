/**
 * Values shared with client components. Nothing here may import anything:
 * a client bundle that reaches lib/core proper would drag Prisma in.
 */

export const MIN_PASSWORD_LENGTH = 10

export const DEFAULT_HEADER_NAME = "Authorization"
export const DEFAULT_VALUE_TEMPLATE = "Bearer {{secret}}"
export const SECRET_PLACEHOLDER = "{{secret}}"

/**
 * The secret picker's choice for one typed into the form there and then,
 * saved as a new secret when the form is.
 */
export const NEW_SECRET = "new"

/** The largest OpenAPI schema PCP reads, uploaded or downloaded. */
export const MAX_SPEC_BYTES = 5 * 1024 * 1024
export const SPEC_FILE_ACCEPT =
  ".json,.yaml,.yml,application/json,application/yaml,text/yaml"

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
 * How the owner can answer an assistant's request. Each kind offers some of
 * them (lib/core/permission-rules.ts); "discard" is only for a memory an
 * assistant wants to share.
 */
export const PERMISSION_DECISIONS = [
  "allow_once",
  "always",
  "block",
  "decline",
  "discard",
] as const

export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

export type PermissionKind =
  | "call"
  | "register"
  | "memory_share"
  | "memory_change"
  | "access"
  | "endpoint_change"

/** The longest memory, in characters. */
export const MAX_MEMORY_CHARS = 10_000

/**
 * The longest shared memory: short enough that the owner reads all of it
 * when an assistant asks to share it.
 */
export const MAX_SHARED_MEMORY_CHARS = 2_000

/** The longest memory path, without the leading /memories/. */
export const MAX_MEMORY_PATH = 200

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
    hint: "Free. Sign in at duckdns.org, pick a name, and copy your token.",
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

/** dyndns2 services PCP knows the update address of. */
export const DYNDNS2_SERVERS: Record<string, string> = {
  "dynupdate.no-ip.com": "No-IP",
  "api.dynu.com": "Dynu",
}

/** Let's Encrypt's agreements, which turning HTTPS on accepts. */
export const LETS_ENCRYPT_TERMS_URL = "https://letsencrypt.org/repository/"
