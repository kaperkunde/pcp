import { REPOSITORY_URL } from "@/lib/operator-identity"

/**
 * What the update check asks of GitHub, and how often. The answer is
 * untrusted input like a schema is: it is read through these limits.
 */

/**
 * Which builds the owner follows: "stable", the releases made from main, or
 * "develop", the pre-releases built from every change on develop as well.
 */
export type UpdateChannel = "stable" | "develop"

export const UPDATE_CHANNELS: readonly UpdateChannel[] = ["stable", "develop"]

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === "stable" || value === "develop"
}

/**
 * What the check asks for. Stable: the latest published release (GitHub
 * leaves out drafts and pre-releases). Develop: the newest few releases,
 * pre-releases among them, of which the latest version counts.
 * `PCP_RELEASES_URL` replaces the latest-release address (for tests and
 * mirrors); the list is the same address without its `/latest`.
 */
export function releaseApiUrl(channel: UpdateChannel = "stable"): string {
  const override = process.env.PCP_RELEASES_URL?.trim()
  const latest =
    override ||
    `https://api.github.com/repos${new URL(REPOSITORY_URL).pathname}/releases/latest`

  if (channel === "stable") {
    return latest
  }

  const list = new URL(latest.replace(/\/latest\/?$/, ""))
  list.searchParams.set("per_page", String(MAX_LISTED_RELEASES))
  return list.toString()
}

/** The page on GitHub for one release, built here and never taken from an answer. */
export function releasePageUrl(version: string): string {
  return `${REPOSITORY_URL}/releases/tag/v${version}`
}

/**
 * Where the files of a release are: a build of develop's own release, or
 * the latest release's (`releases/latest/download/<name>`).
 */
export function releaseDownloadsUrl(devBuild: string | null): string {
  return devBuild
    ? `${REPOSITORY_URL}/releases/download/v${devBuild}`
    : `${REPOSITORY_URL}/releases/latest/download`
}

export const UPDATE_FETCH_TIMEOUT_MS = 10_000
export const MAX_RELEASE_BYTES = 256 * 1024
/**
 * The develop channel's list: enough releases that the newest build and the
 * newest release are both among them (release.yml keeps a few builds), and a
 * cap that fits that many with their files.
 */
export const MAX_LISTED_RELEASES = 10
export const MAX_RELEASE_LIST_BYTES = 2 * 1024 * 1024
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
