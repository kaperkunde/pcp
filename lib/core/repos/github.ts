import { createHash } from "node:crypto"

import { z } from "zod"

import { invalid, PcpError } from "../errors"
import { isPublicAddress, lookupAll, type HostLookup } from "../openapi/address"
import { describeFetchError, discard, readCapped } from "../openapi/http"
import { PCP_VERSION } from "../version"

import {
  GITHUB_API_URL,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_TIMEOUT_MS,
  GITHUB_WEB_URL,
  MAX_BRANCH_CHARS,
  MAX_GITHUB_ANSWER_BYTES,
  MAX_TREE_BYTES,
  MAX_TREE_ENTRIES,
} from "./limits"

/**
 * PCP's client for GitHub, fixed and built in: the REST API at
 * api.github.com for repositories (the Git Data API to read and push), and
 * github.com for the device flow of PCP's own OAuth App. Nothing else is
 * called, no redirect is followed (one is an error), and every answer is
 * untrusted input: read up to a size, parsed against a schema, and a file's
 * bytes checked against the object id GitHub named them by.
 *
 * Nothing here reads a secret. upstream.ts `githubCredential` hands in the
 * Authorization header, made from the secret the owner chose for the
 * repository, and the values that would give it away; it goes to the API
 * only, never to github.com, and is taken out of any message PCP repeats.
 *
 * The addresses are GitHub's. A development server or a test points them
 * at a fake with PCP_GITHUB_API_URL and PCP_GITHUB_URL, which a production
 * build never reads.
 */

export type GitHubCredential = {
  headers: Record<string, string>
  /** Values that would give the credential away if an answer repeated them. */
  redact: string[]
}

export type GitHubEndpoints = {
  api: string
  web: string
  /** Whether the host must resolve to public addresses only. */
  publicOnly: boolean
}

type Fetch = typeof fetch

export type GitHub = {
  endpoints: GitHubEndpoints
  credential: GitHubCredential | null
  fetchFn?: Fetch
  lookup?: HostLookup
}

/** A repository on GitHub, by its owner and name. */
export type RepoCoords = { owner: string; name: string }

export const USER_AGENT = `PCP/${PCP_VERSION}`

/** GitHub's addresses, or a fake's outside a production build. */
export function githubEndpoints(): GitHubEndpoints {
  if (process.env.NODE_ENV !== "production") {
    const api = process.env.PCP_GITHUB_API_URL?.trim()

    if (api) {
      return {
        api: api.replace(/\/+$/, ""),
        web: (process.env.PCP_GITHUB_URL?.trim() || api).replace(/\/+$/, ""),
        publicOnly: false,
      }
    }
  }

  return { api: GITHUB_API_URL, web: GITHUB_WEB_URL, publicOnly: true }
}

// ---- Names ------------------------------------------------------------------

export function checkCoords(owner: string, name: string): RepoCoords {
  const o = owner.trim()
  const n = name.trim().replace(/\.git$/, "")

  if (!GITHUB_OWNER.test(o)) {
    throw invalid(
      `"${o.slice(0, 40)}" is not a GitHub owner: letters, digits and single dashes, at most 39 characters.`,
    )
  }

  if (!GITHUB_REPO.test(n) || n === "." || n === "..") {
    throw invalid(
      `"${n.slice(0, 100)}" is not a GitHub repository name: letters, digits, dots, dashes and underscores.`,
    )
  }

  return { owner: o, name: n }
}

/** "owner/name", or a github.com address of one, read into its parts. */
export function parseRepoName(input: string): RepoCoords {
  const text = input
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\/+$/, "")
  const parts = text.split("/")

  if (parts.length !== 2) {
    throw invalid("Name the repository as owner/name, like anthropics/skills.")
  }

  return checkCoords(parts[0]!, parts[1]!)
}

/** A branch name, checked the way git checks a ref's, more strictly. */
export function checkBranch(branch: string): string {
  const b = branch.trim()

  if (
    !b ||
    b.length > MAX_BRANCH_CHARS ||
    !/^[A-Za-z0-9._/-]+$/.test(b) ||
    b.startsWith("/") ||
    b.endsWith("/") ||
    b.startsWith("-") ||
    b.includes("//") ||
    b.includes("..") ||
    b.endsWith(".lock") ||
    b.split("/").some((part) => part.startsWith("."))
  ) {
    throw invalid(
      `"${b.slice(0, 80)}" is not a branch name PCP takes: letters, digits, dots, dashes, underscores and / between names.`,
    )
  }

  return b
}

function repoPath({ owner, name }: RepoCoords): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

function refPath(branch: string): string {
  return checkBranch(branch).split("/").map(encodeURIComponent).join("/")
}

const SHA = /^[0-9a-f]{40}$/

function checkSha(sha: string): string {
  if (!SHA.test(sha)) {
    throw new PcpError("upstream", "GitHub named an object PCP cannot read.")
  }

  return sha
}

/** The id git gives a file's bytes: SHA-1 of "blob <size>\0" and them. */
export function blobSha(bytes: Buffer | string): string {
  const data = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes

  return createHash("sha1")
    .update(`blob ${data.length}\0`)
    .update(data)
    .digest("hex")
}

// ---- Requests ---------------------------------------------------------------

function scrub(text: string, credential: GitHubCredential | null): string {
  let out = text

  for (const value of credential?.redact ?? []) {
    if (value) {
      out = out.split(value).join("[secret]")
    }
  }

  return out
}

async function checkHost(gh: GitHub, url: URL): Promise<void> {
  if (!gh.endpoints.publicOnly) {
    return
  }

  // A machine behind an outbound proxy may resolve nothing itself: then the
  // proxy reaches GitHub. What does resolve has to be public.
  const addresses = await (gh.lookup ?? lookupAll)(url.hostname).catch(
    () => [] as string[],
  )

  if (addresses.some((address) => !isPublicAddress(address))) {
    throw new PcpError(
      "upstream",
      `${url.hostname} resolves to a private address here, so PCP does not call it.`,
    )
  }
}

type Sent = {
  method?: "GET" | "POST" | "PATCH"
  body?: unknown
  maxBytes?: number
  /** github.com's device flow: no credential, a form. */
  web?: boolean
}

/** What GitHub answered: its status and its JSON, untrusted. */
type Answer = { status: number; value: unknown }

async function request(
  gh: GitHub,
  path: string,
  { method = "GET", body, maxBytes = MAX_GITHUB_ANSWER_BYTES, web }: Sent = {},
): Promise<Answer> {
  const base = web ? gh.endpoints.web : gh.endpoints.api
  const url = new URL(`${base}${path}`)
  await checkHost(gh, url)

  const headers: Record<string, string> = {
    accept: web ? "application/json" : "application/vnd.github+json",
    "user-agent": USER_AGENT,
    ...(web ? {} : { "x-github-api-version": "2022-11-28" }),
    // The credential goes to the API only, never to github.com.
    ...(!web && gh.credential ? gh.credential.headers : {}),
  }
  let payload: string | undefined

  if (body !== undefined) {
    if (web) {
      headers["content-type"] = "application/x-www-form-urlencoded"
      payload = new URLSearchParams(body as Record<string, string>).toString()
    } else {
      headers["content-type"] = "application/json"
      payload = JSON.stringify(body)
    }
  }

  let response: Response

  try {
    response = await (gh.fetchFn ?? fetch)(url, {
      method,
      headers,
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    })
  } catch (error) {
    throw new PcpError(
      "upstream",
      `PCP could not reach GitHub (${scrub(describeFetchError(error, GITHUB_TIMEOUT_MS), gh.credential)}).`,
    )
  }

  if (response.status >= 300 && response.status < 400) {
    await discard(response)
    throw new PcpError(
      "upstream",
      "GitHub sent PCP somewhere else, which it does not follow. A renamed repository is linked again under its new name.",
    )
  }

  const declared = Number(response.headers.get("content-length") ?? "0")

  if (declared > maxBytes) {
    await discard(response)
    throw new PcpError("upstream", "GitHub's answer is larger than PCP reads.")
  }

  let read: { bytes: Buffer; truncated: boolean }

  try {
    read = await readCapped(response, maxBytes)
  } catch (error) {
    throw new PcpError(
      "upstream",
      `PCP could not read GitHub's answer (${describeFetchError(error, GITHUB_TIMEOUT_MS)}).`,
    )
  }

  if (read.truncated) {
    throw new PcpError("upstream", "GitHub's answer is larger than PCP reads.")
  }

  let value: unknown = null

  if (read.bytes.length > 0) {
    try {
      value = JSON.parse(new TextDecoder().decode(read.bytes)) as unknown
    } catch {
      throw new PcpError("upstream", "PCP could not read what GitHub answered.")
    }
  }

  return { status: response.status, value }
}

/** GitHub's own message for a refusal, short and without the credential. */
function refusal(gh: GitHub, answer: Answer, what: string): PcpError {
  const message =
    answer.value &&
    typeof answer.value === "object" &&
    typeof (answer.value as { message?: unknown }).message === "string"
      ? (answer.value as { message: string }).message
          .replace(/[\p{Cc}\p{Cf}]/gu, " ")
          .slice(0, 200)
      : ""
  const said = message ? `: ${scrub(message, gh.credential)}` : ""

  switch (answer.status) {
    case 401:
      return new PcpError(
        "unauthorized",
        `GitHub did not take PCP's sign-in for ${what}${said}. With a token, check the repository's secret; with PCP's GitHub sign-in, sign in to GitHub again (it may have been revoked at github.com/settings/applications).`,
      )
    case 403:
    case 429:
      return new PcpError(
        "forbidden",
        `GitHub refused ${what}${said}. Without a sign-in GitHub allows few requests an hour; a token raises that.`,
      )
    case 404:
      return new PcpError(
        "not_found",
        `GitHub has no ${what} PCP can see${said}. A private repository needs a sign-in that can read it.`,
      )
    default:
      return new PcpError(
        "upstream",
        `GitHub answered ${answer.status} for ${what}${said}.`,
      )
  }
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)

  if (!result.success) {
    throw new PcpError("upstream", "PCP could not read what GitHub answered.")
  }

  return result.data
}

async function json<T>(
  gh: GitHub,
  path: string,
  schema: z.ZodType<T>,
  what: string,
  sent: Sent = {},
): Promise<T> {
  const answer = await request(gh, path, sent)

  if (answer.status < 200 || answer.status >= 300) {
    throw refusal(gh, answer, what)
  }

  return parsed(schema, answer.value)
}

// ---- Repositories -----------------------------------------------------------

const RepoAnswer = z.object({
  default_branch: z.string().max(MAX_BRANCH_CHARS),
  private: z.boolean(),
  permissions: z
    .object({ push: z.boolean().optional(), admin: z.boolean().optional() })
    .nullish(),
})

export type RepoInfo = {
  defaultBranch: string
  private: boolean
  /** Whether the sign-in may push: null without one (GitHub does not say). */
  push: boolean | null
}

export async function repoInfo(
  gh: GitHub,
  coords: RepoCoords,
): Promise<RepoInfo> {
  const answer = await json(gh, repoPath(coords), RepoAnswer, "repository")

  return {
    defaultBranch: checkBranch(answer.default_branch),
    private: answer.private,
    push: answer.permissions ? answer.permissions.push === true : null,
  }
}

const RefAnswer = z.object({
  object: z.object({ sha: z.string(), type: z.string() }),
})

const CommitAnswer = z.object({
  sha: z.string(),
  tree: z.object({ sha: z.string() }),
})

export type Head = { commit: string; tree: string }

/** Where a branch is now: its commit, and that commit's tree. */
export async function branchHead(
  gh: GitHub,
  coords: RepoCoords,
  branch: string,
): Promise<Head> {
  const ref = await json(
    gh,
    `${repoPath(coords)}/git/ref/heads/${refPath(branch)}`,
    RefAnswer,
    `branch ${branch}`,
  )

  if (ref.object.type !== "commit") {
    throw new PcpError("upstream", `${branch} does not point at a commit.`)
  }

  const commit = await json(
    gh,
    `${repoPath(coords)}/git/commits/${checkSha(ref.object.sha)}`,
    CommitAnswer,
    "commit",
  )

  return { commit: checkSha(commit.sha), tree: checkSha(commit.tree.sha) }
}

/** A commit the owner was shown, and its tree: what an addition reads. */
export async function commitAt(
  gh: GitHub,
  coords: RepoCoords,
  sha: string,
): Promise<Head> {
  const commit = await json(
    gh,
    `${repoPath(coords)}/git/commits/${checkSha(sha)}`,
    CommitAnswer,
    "commit",
  )

  return { commit: checkSha(commit.sha), tree: checkSha(commit.tree.sha) }
}

export type TreeEntry = {
  path: string
  type: "blob" | "tree"
  sha: string
  /** A blob's size in bytes. */
  size: number | null
  mode: string
}

const TreeAnswer = z.object({
  sha: z.string(),
  truncated: z.boolean().optional(),
  tree: z
    .array(
      z.object({
        path: z.string().max(4096),
        mode: z.string().max(10),
        type: z.string().max(10),
        sha: z.string(),
        size: z.number().int().min(0).optional(),
      }),
    )
    .max(MAX_TREE_ENTRIES),
})

/**
 * A tree and everything under it, by path from it. Submodules and links are
 * left out: PCP reads plain files only. A tree GitHub cut short is refused,
 * since what is missing could be part of an item.
 */
export async function readTree(
  gh: GitHub,
  coords: RepoCoords,
  sha: string,
): Promise<TreeEntry[]> {
  const answer = await json(
    gh,
    `${repoPath(coords)}/git/trees/${checkSha(sha)}?recursive=1`,
    TreeAnswer,
    "tree",
    { maxBytes: MAX_TREE_BYTES },
  )

  if (answer.truncated) {
    throw new PcpError(
      "upstream",
      `The repository has more files than GitHub lists at once; PCP reads repositories of up to ${MAX_TREE_ENTRIES.toLocaleString("en")} files.`,
    )
  }

  return answer.tree.flatMap((entry): TreeEntry[] =>
    (entry.type === "blob" && entry.mode !== "120000") || entry.type === "tree"
      ? [
          {
            path: entry.path,
            type: entry.type as "blob" | "tree",
            sha: checkSha(entry.sha),
            size: entry.size ?? null,
            mode: entry.mode,
          },
        ]
      : [],
  )
}

const BlobAnswer = z.object({
  sha: z.string(),
  size: z.number().int().min(0),
  encoding: z.string(),
  content: z.string(),
})

/**
 * A file's text, by its object id: at most `maxBytes`, checked against the
 * id (so it is the file GitHub named, byte for byte), and UTF-8.
 */
export async function readBlob(
  gh: GitHub,
  coords: RepoCoords,
  sha: string,
  maxBytes: number,
  what: string,
): Promise<string> {
  const answer = await json(
    gh,
    `${repoPath(coords)}/git/blobs/${checkSha(sha)}`,
    BlobAnswer,
    what,
    // Base64 with a line break every 60 characters, and the JSON around it.
    { maxBytes: Math.ceil((maxBytes * 4) / 3) * 1.05 + 4096 },
  )

  if (answer.size > maxBytes) {
    throw invalid(
      `${what} is ${answer.size.toLocaleString("en")} bytes; a file there has at most ${maxBytes.toLocaleString("en")}.`,
    )
  }

  if (answer.encoding !== "base64") {
    throw new PcpError(
      "upstream",
      `GitHub sent ${what} in a form PCP does not read.`,
    )
  }

  const bytes = Buffer.from(answer.content.replace(/\s+/g, ""), "base64")

  if (bytes.length !== answer.size || blobSha(bytes) !== sha) {
    throw new PcpError(
      "upstream",
      `What GitHub sent for ${what} is not the file it named.`,
    )
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw invalid(`${what} is not text, and an item's files are.`)
  }
}

// ---- Pushing ----------------------------------------------------------------

const ShaAnswer = z.object({ sha: z.string() })

export async function createBlob(
  gh: GitHub,
  coords: RepoCoords,
  text: string,
): Promise<string> {
  const answer = await json(
    gh,
    `${repoPath(coords)}/git/blobs`,
    ShaAnswer,
    "a new file",
    {
      method: "POST",
      body: {
        content: Buffer.from(text, "utf8").toString("base64"),
        encoding: "base64",
      },
    },
  )
  const sha = checkSha(answer.sha)

  if (sha !== blobSha(text)) {
    throw new PcpError(
      "upstream",
      "GitHub stored a file other than the one PCP sent.",
    )
  }

  return sha
}

/** A file to write (its blob) or to remove (null), by path from the root. */
export type TreeChange = { path: string; sha: string | null }

export async function createTree(
  gh: GitHub,
  coords: RepoCoords,
  base: string,
  changes: TreeChange[],
): Promise<string> {
  const answer = await json(
    gh,
    `${repoPath(coords)}/git/trees`,
    ShaAnswer,
    "a new tree",
    {
      method: "POST",
      body: {
        base_tree: checkSha(base),
        tree: changes.map((change) => ({
          path: change.path,
          mode: "100644",
          type: "blob",
          sha: change.sha === null ? null : checkSha(change.sha),
        })),
      },
    },
  )

  return checkSha(answer.sha)
}

export async function createCommit(
  gh: GitHub,
  coords: RepoCoords,
  { message, tree, parent }: { message: string; tree: string; parent: string },
): Promise<string> {
  const answer = await json(
    gh,
    `${repoPath(coords)}/git/commits`,
    ShaAnswer,
    "a new commit",
    {
      method: "POST",
      body: { message, tree: checkSha(tree), parents: [checkSha(parent)] },
    },
  )

  return checkSha(answer.sha)
}

/**
 * Moves the branch to the commit, as a fast-forward only: when someone
 * pushed in between, GitHub refuses it and that is a conflict, never a
 * force.
 */
export async function moveBranch(
  gh: GitHub,
  coords: RepoCoords,
  branch: string,
  commit: string,
): Promise<void> {
  const answer = await request(
    gh,
    `${repoPath(coords)}/git/refs/heads/${refPath(branch)}`,
    { method: "PATCH", body: { sha: checkSha(commit), force: false } },
  )

  if (answer.status === 422 || answer.status === 409) {
    throw new PcpError(
      "conflict",
      `${branch} moved on while PCP was writing to it, so nothing was pushed. Sync again to see what changed.`,
    )
  }

  if (answer.status < 200 || answer.status >= 300) {
    throw refusal(gh, answer, `branch ${branch}`)
  }
}

// ---- The device flow ----------------------------------------------------------

const DeviceAnswer = z.object({
  device_code: z.string().min(1).max(200),
  user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  expires_in: z.number().int().min(1).max(3600),
  interval: z.number().int().min(1).max(120).optional(),
})

export type DeviceCode = {
  deviceCode: string
  userCode: string
  /** Built by PCP, never taken from the answer. */
  verificationUri: string
  expiresAt: number
  intervalMs: number
}

/** Starts a sign-in: the code the owner types in at github.com/login/device. */
export async function startDeviceFlow(
  gh: Omit<GitHub, "credential">,
  clientId: string,
  scope: string,
  now = Date.now(),
): Promise<DeviceCode> {
  const answer = await json(
    { ...gh, credential: null },
    "/login/device/code",
    DeviceAnswer,
    "a sign-in code",
    { method: "POST", web: true, body: { client_id: clientId, scope } },
  )

  return {
    deviceCode: answer.device_code,
    userCode: answer.user_code,
    verificationUri: `${gh.endpoints.web}/login/device`,
    expiresAt: now + answer.expires_in * 1000,
    intervalMs: (answer.interval ?? 5) * 1000,
  }
}

const TokenAnswer = z.union([
  z.object({
    access_token: z.string().min(1).max(500),
    token_type: z.string().max(40).optional(),
    scope: z.string().max(500).optional(),
  }),
  z.object({
    error: z.string().max(100),
    interval: z.number().int().min(1).max(600).optional(),
  }),
])

export type DevicePoll =
  | { status: "done"; accessToken: string; scope: string }
  | { status: "pending" }
  | { status: "slow_down"; intervalMs: number }
  | { status: "expired" }
  | { status: "denied" }

/** Asks once whether the owner approved the code yet. */
export async function pollDeviceFlow(
  gh: Omit<GitHub, "credential">,
  clientId: string,
  deviceCode: string,
): Promise<DevicePoll> {
  const answer = await request(
    { ...gh, credential: null },
    "/login/oauth/access_token",
    {
      method: "POST",
      web: true,
      body: {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
    },
  )

  if (answer.status < 200 || answer.status >= 300) {
    throw refusal({ ...gh, credential: null }, answer, "the sign-in")
  }

  const value = parsed(TokenAnswer, answer.value)

  if ("access_token" in value) {
    if (/[\u0000-\u001f\u007f\s]/.test(value.access_token)) {
      throw new PcpError("upstream", "GitHub sent a token PCP cannot use.")
    }

    return {
      status: "done",
      accessToken: value.access_token,
      scope: value.scope ?? "",
    }
  }

  switch (value.error) {
    case "authorization_pending":
      return { status: "pending" }
    case "slow_down":
      return { status: "slow_down", intervalMs: (value.interval ?? 10) * 1000 }
    case "expired_token":
      return { status: "expired" }
    case "access_denied":
      return { status: "denied" }
    default:
      throw new PcpError(
        "upstream",
        `GitHub refused the sign-in (${value.error.replace(/[^a-z_]/g, "").slice(0, 40)}).`,
      )
  }
}
