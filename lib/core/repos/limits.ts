import { MAX_SPEC_BYTES } from "../constants"

/**
 * Bounds on what a linked repository's files can make PCP read. Every file
 * in one is untrusted input: these hold before anything parses it, and the
 * validators each kind already has (skills.ts, wrappers/definition.ts,
 * openapi/) hold after.
 */

/**
 * Files one item may have: a wrapper's wrapper.yaml and a program per tool
 * (30 at most), a skill's SKILL.md and its reference files (10).
 */
export const MAX_ITEM_FILES = 40

/** One file other than an endpoint's OpenAPI document, in UTF-8 bytes. */
export const MAX_FILE_BYTES = 256 * 1024

/** An endpoint's OpenAPI document: what PCP takes as a schema anyway. */
export const MAX_SPEC_FILE_BYTES = MAX_SPEC_BYTES

/** Everything one item's files add up to. */
export const MAX_ITEM_BYTES = MAX_SPEC_BYTES + 1024 * 1024

/** A file's path from the repository's root, in characters. */
export const MAX_PATH_CHARS = 200

/** An item's name in its path (a slug), in characters. */
export const MAX_ITEM_NAME_CHARS = 64

/** How deep a PCP document's YAML may nest. */
export const MAX_DOCUMENT_DEPTH = 64

// ---- GitHub (github.ts) -----------------------------------------------------

/**
 * The client id of PCP's own GitHub OAuth App (registered under kaperkunde),
 * for signing in with GitHub's device flow. It is public; only the id ships.
 * The app has the device flow on and token expiry off: GitHub wants a client
 * secret to renew an expiring token, and PCP has none, so its tokens do not
 * expire and come without a refresh token. A 401 means sign in again; the
 * owner revokes a token at github.com/settings/applications.
 */
export const GITHUB_OAUTH_CLIENT_ID = "Ov23liInv6e90qQsf4Ya"

/**
 * The managed secret (kind oauth) that holds the token of PCP's GitHub
 * sign-in: one per vault, used by every repository the owner signs in for.
 */
export const GITHUB_SIGNIN_SECRET = "oauth/github"

/**
 * What PCP asks GitHub's sign-in for, no more than it needs: `public_repo`
 * reads and pushes public repositories, `repo` private ones too.
 */
export type GitHubScope = "public_repo" | "repo"

export const GITHUB_SCOPES: readonly GitHubScope[] = ["public_repo", "repo"]

/** GitHub's REST API: the only address the client calls. */
export const GITHUB_API_URL = "https://api.github.com"

/** Where GitHub's device flow is: the code, the page and the token. */
export const GITHUB_WEB_URL = "https://github.com"

export const GITHUB_TIMEOUT_MS = 15_000

/** A small answer: a repository, a ref, a commit, a created object. */
export const MAX_GITHUB_ANSWER_BYTES = 256 * 1024

/** A repository's whole tree, listed at once. */
export const MAX_TREE_BYTES = 8 * 1024 * 1024

/** Entries in that tree. A larger repository is refused, not cut short. */
export const MAX_TREE_ENTRIES = 20_000

/** Files PCP reads from a repository when browsing it at once. */
export const MAX_BROWSE_FILES = 400

/** The bytes of those files together. */
export const MAX_BROWSE_BYTES = 24 * 1024 * 1024

/** Repositories one vault links. */
export const MAX_REPOS = 20

/** An owner's or organization's name on GitHub. */
export const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/** A repository's name on GitHub. */
export const GITHUB_REPO = /^[A-Za-z0-9._-]{1,100}$/

/** A branch name PCP takes: plain names with / between them. */
export const MAX_BRANCH_CHARS = 200

// ---- Sync (sync.ts) -----------------------------------------------------------

export type SyncFrequency = "off" | "hourly" | "daily" | "weekly"

export const SYNC_FREQUENCIES: readonly SyncFrequency[] = [
  "off",
  "hourly",
  "daily",
  "weekly",
]

/** How long after the last sync an item is due again. */
export const SYNC_PERIOD_MS: Record<Exclude<SyncFrequency, "off">, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
}

/**
 * How long one run of due syncs may take. It runs after a request was
 * answered, while that request's key is still in memory, so it is short:
 * what it did not reach is due at the next request.
 */
export const SYNC_BUDGET_MS = 20_000

/** Items one run syncs at most. */
export const MAX_SYNC_ITEMS_PER_RUN = 10

/** How often a vault's due syncs are looked for at all, at most. */
export const SYNC_LOOK_INTERVAL_MS = 60_000

/** An assistant's REVIEW.md, in characters. */
export const MAX_REVIEW_CHARS = 20_000
