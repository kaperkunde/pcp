import { z } from "zod"

import { PcpError } from "../errors"
import { describeFetchError, discard, readCapped } from "../openapi/http"
import { PCP_VERSION } from "../version"
import { REPOSITORY_URL } from "@/lib/operator-identity"
import {
  MAX_ASSET_NAME_CHARS,
  MAX_ASSETS,
  MAX_LISTED_RELEASES,
  MAX_NOTES_CHARS,
  MAX_RELEASE_BYTES,
  MAX_RELEASE_LIST_BYTES,
  MAX_RELEASE_REDIRECTS,
  releaseApiUrl,
  type UpdateChannel,
  UPDATE_FETCH_TIMEOUT_MS,
} from "./limits"
import { isDevBuild, isNewer, normalizeVersion } from "./semver"

/**
 * Asking GitHub which release is the latest: the latest published release on
 * the stable channel, the latest version among the newest releases (develop's
 * pre-releases among them) on the develop one. Nothing is sent but the version
 * in the user agent: no credential, no cookie, nothing of the vault. The
 * address is PCP's own, not an assistant's, so this uses the plain fetch
 * the dynamic DNS code does (it works behind an outbound proxy), and still
 * follows no redirect it was not allowed: at most a couple, to the same
 * origin.
 */

export type Release = {
  /** MAJOR.MINOR.PATCH, without the "v". */
  version: string
  publishedAt: string | null
  /** The release notes as plain text, cut short. Never HTML. */
  notes: string
  /** The names of the files attached to the release. */
  assets: string[]
}

type Fetch = typeof fetch

export const USER_AGENT = `PCP/${PCP_VERSION} (+${REPOSITORY_URL})`

const Answer = z.object({
  tag_name: z.string(),
  published_at: z.string().nullish(),
  body: z.string().nullish(),
  assets: z.array(z.object({ name: z.string() })).nullish(),
})

const UNREADABLE = "PCP could not read what GitHub answered."

/** What GitHub answered, reduced to what PCP uses; anything odd is refused. */
export function parseRelease(value: unknown): Release {
  const answer = Answer.safeParse(value)

  if (!answer.success) {
    throw new PcpError("upstream", UNREADABLE)
  }

  const version = normalizeVersion(answer.data.tag_name)

  if (!version) {
    throw new PcpError("upstream", UNREADABLE)
  }

  const published = answer.data.published_at
    ? new Date(answer.data.published_at)
    : null

  return {
    version,
    publishedAt:
      published && !Number.isNaN(published.getTime())
        ? published.toISOString()
        : null,
    notes: plainText(answer.data.body ?? "", MAX_NOTES_CHARS),
    assets: (answer.data.assets ?? [])
      .map((asset) => asset.name)
      .filter((name) => name.length > 0 && name.length <= MAX_ASSET_NAME_CHARS)
      .slice(0, MAX_ASSETS),
  }
}

/**
 * The develop channel's answer: a list of releases, newest first. The latest
 * version among them counts, a release or a build; a draft (which GitHub
 * shows nobody without a credential) or an entry PCP cannot read does not.
 */
export function parseReleaseList(value: unknown): Release {
  if (!Array.isArray(value)) {
    throw new PcpError("upstream", UNREADABLE)
  }

  let latest: Release | null = null

  for (const entry of value.slice(0, MAX_LISTED_RELEASES)) {
    if (
      entry &&
      typeof entry === "object" &&
      (entry as { draft?: unknown }).draft === true
    ) {
      continue
    }

    let release: Release

    try {
      release = parseRelease(entry)
    } catch {
      continue
    }

    if (!latest || isNewer(release.version, latest.version)) {
      latest = release
    }
  }

  if (!latest) {
    throw new PcpError(
      "upstream",
      "GitHub has no published release to compare with.",
    )
  }

  return latest
}

/**
 * Text the owner reads as it is: line breaks and tabs kept, every other
 * control, format (zero-width, direction overrides) and private-use character
 * dropped, cut at a limit.
 */
function plainText(text: string, max: number): string {
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\p{Cc}\p{Cf}\p{Co}]/gu, (char) =>
      char === "\n" || char === "\t" ? char : "",
    )
    .trim()
  const characters = [...clean]

  return characters.length > max
    ? `${characters.slice(0, max).join("")}…`
    : clean
}

/**
 * The latest release on the channel, or a PcpError saying in the owner's
 * words why not.
 */
export async function fetchLatestRelease(
  fetchFn: Fetch = fetch,
  url?: string,
  channel: UpdateChannel = "stable",
): Promise<Release> {
  const value = await fetchJson(
    fetchFn,
    url ?? releaseApiUrl(channel),
    channel === "stable" ? MAX_RELEASE_BYTES : MAX_RELEASE_LIST_BYTES,
  )

  if (channel === "develop") {
    return parseReleaseList(value)
  }

  const release = parseRelease(value)

  // GitHub's latest release is never a pre-release; a build of develop
  // published as a release is still not one for the stable channel.
  if (isDevBuild(release.version)) {
    throw new PcpError("upstream", UNREADABLE)
  }

  return release
}

async function fetchJson(
  fetchFn: Fetch,
  url: string,
  maxBytes: number,
): Promise<unknown> {
  const origin = new URL(url).origin
  const signal = AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS)
  let current = url

  for (let hop = 0; ; hop++) {
    let response: Response

    try {
      response = await fetchFn(current, {
        redirect: "manual",
        signal,
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": USER_AGENT,
        },
      })
    } catch (error) {
      throw new PcpError(
        "upstream",
        `PCP could not reach GitHub (${describeFetchError(error, UPDATE_FETCH_TIMEOUT_MS)}).`,
      )
    }

    if (response.status >= 300 && response.status < 400) {
      await discard(response)
      const location = response.headers.get("location")
      const next = location ? safeUrl(location, current) : null

      if (!next || next.origin !== origin || hop >= MAX_RELEASE_REDIRECTS) {
        throw new PcpError("upstream", "GitHub sent PCP somewhere else.")
      }

      current = next.toString()
      continue
    }

    if (!response.ok) {
      await discard(response)
      throw new PcpError("upstream", refusal(response))
    }

    const declared = Number(response.headers.get("content-length") ?? "0")

    if (declared > maxBytes) {
      await discard(response)
      throw new PcpError("upstream", UNREADABLE)
    }

    let read: { bytes: Buffer; truncated: boolean }

    try {
      read = await readCapped(response, maxBytes)
    } catch (error) {
      throw new PcpError(
        "upstream",
        `PCP could not reach GitHub (${describeFetchError(error, UPDATE_FETCH_TIMEOUT_MS)}).`,
      )
    }

    if (read.truncated) {
      throw new PcpError("upstream", UNREADABLE)
    }

    try {
      return JSON.parse(new TextDecoder().decode(read.bytes)) as unknown
    } catch {
      throw new PcpError("upstream", UNREADABLE)
    }
  }
}

function safeUrl(location: string, base: string): URL | null {
  try {
    return new URL(location, base)
  } catch {
    return null
  }
}

function refusal(response: Response): string {
  if (
    response.status === 429 ||
    (response.status === 403 &&
      response.headers.get("x-ratelimit-remaining") === "0")
  ) {
    return "GitHub is limiting requests from this address. PCP will try again later."
  }

  if (response.status === 404) {
    return "GitHub has no published release to compare with."
  }

  return `GitHub answered HTTP ${response.status}.`
}
