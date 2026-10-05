import { REPOSITORY_URL } from "@/lib/operator-identity"

/**
 * What the update check asks of GitHub, and how often. The answer is
 * untrusted input like a schema is: it is read through these limits.
 */

/** The latest published release (drafts and pre-releases are left out). */
export function releaseApiUrl(): string {
  const override = process.env.PCP_RELEASES_URL?.trim()

  if (override) {
    return override
  }

  return `https://api.github.com/repos${new URL(REPOSITORY_URL).pathname}/releases/latest`
}

/** The page on GitHub for one release, built here and never taken from an answer. */
export function releasePageUrl(version: string): string {
  return `${REPOSITORY_URL}/releases/tag/v${version}`
}

export const UPDATE_FETCH_TIMEOUT_MS = 10_000
export const MAX_RELEASE_BYTES = 256 * 1024
/** A renamed repository answers with a redirect to its new address. */
export const MAX_RELEASE_REDIRECTS = 2
export const MAX_NOTES_CHARS = 4_000
export const MAX_ASSETS = 50
export const MAX_ASSET_NAME_CHARS = 200

/** How often the timer wakes up; a round runs only when one is due. */
export const UPDATE_TICK_MS = 60 * 60_000
/** A successful check is repeated this often. */
export const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60_000
/** After a failure: an hour, four hours, then a day. */
export const UPDATE_BACKOFF_MS = [1, 4, 24].map((hours) => hours * 60 * 60_000)
/** The first automatic check after a start waits this long, so a restart is quiet. */
export const UPDATE_FIRST_TICK_MS = { min: 60_000, max: 10 * 60_000 }
/** "Check now": this many in a window, so a held button cannot spend GitHub's hourly allowance. */
export const CHECK_NOW_LIMIT = { max: 5, windowMs: 60_000 }
