import { createHash, randomBytes } from "node:crypto"
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"

import { blobSha } from "./github"
import type { RepoFiles } from "./layout"

/**
 * A stand-in for GitHub, for tests and the e2e suite: the parts of the REST
 * API PCP uses (a repository, a branch's ref, commits, trees and blobs, and
 * creating them), and the device flow at /login. Everything is in memory.
 * Blobs have git's ids, so PCP's check of a file against its id holds;
 * trees and commits have ids of their own making.
 *
 * Tests reach in: `addRepo` and `commit` set what a repository holds,
 * `tokens` say which bearer tokens it takes and whether they may push,
 * `requests` records everything PCP sent, and the hooks make GitHub
 * misbehave (a redirect, an answer too large, a push racing PCP's).
 */

type TreeItem = {
  name: string
  mode: string
  type: "blob" | "tree"
  sha: string
}
type Commit = { tree: string; parents: string[]; message: string }

export type FakeRepo = {
  owner: string
  name: string
  private: boolean
  defaultBranch: string
  refs: Map<string, string>
}

export type DeviceStep = "pending" | "slow_down" | "expired" | "denied"

type DeviceGrant = {
  userCode: string
  /** What the next polls answer, in order, before the approval counts. */
  steps: DeviceStep[]
  token: string | null
  polls: number
}

export type FakeRequest = {
  method: string
  path: string
  authorization: string | null
  headers: Record<string, string | string[] | undefined>
  body: string
}

export type FakeGitHub = {
  url: string
  repos: Map<string, FakeRepo>
  /** Bearer tokens it takes, and whether each may push. */
  tokens: Map<string, { push: boolean }>
  requests: FakeRequest[]
  /** The device flow's client id it knows. */
  clientId: string
  devices: Map<string, DeviceGrant>
  /** Answer every request with a redirect. */
  redirectAll: boolean
  /** Pad blob answers past any limit. */
  hugeAnswers: boolean
  /** Runs when a ref update arrives, before it is checked. */
  beforeRefUpdate: (() => void) | null
  addRepo: (
    owner: string,
    name: string,
    options?: { private?: boolean; branch?: string; files?: RepoFiles },
  ) => FakeRepo
  /** Makes the files the branch's whole new state; the commit's id. */
  commit: (
    owner: string,
    name: string,
    files: RepoFiles,
    options?: { branch?: string; message?: string },
  ) => string
  /** The files on a branch now. */
  files: (owner: string, name: string, branch?: string) => RepoFiles
  /** Commit messages on a branch, newest first. */
  log: (owner: string, name: string, branch?: string) => string[]
  /** The owner approving a code at github.com/login/device. */
  approve: (userCode: string, token: string) => void
  close: () => Promise<void>
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex")
}

export async function startFakeGitHub(
  options: { port?: number } = {},
): Promise<FakeGitHub> {
  const blobs = new Map<string, Buffer>()
  const trees = new Map<string, TreeItem[]>()
  const commits = new Map<string, Commit>()

  function putTree(items: TreeItem[]): string {
    const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name))
    const sha = sha1(`tree ${JSON.stringify(sorted)}`)
    trees.set(sha, sorted)
    return sha
  }

  /** A tree from blob ids by path. */
  function buildTree(byPath: Map<string, string>): string {
    const here = new Map<string, TreeItem>()
    const below = new Map<string, Map<string, string>>()

    for (const [path, sha] of byPath) {
      const slash = path.indexOf("/")

      if (slash < 0) {
        here.set(path, { name: path, mode: "100644", type: "blob", sha })
      } else {
        const dir = path.slice(0, slash)
        const inner = below.get(dir) ?? new Map<string, string>()
        inner.set(path.slice(slash + 1), sha)
        below.set(dir, inner)
      }
    }

    for (const [dir, inner] of below) {
      here.set(dir, {
        name: dir,
        mode: "040000",
        type: "tree",
        sha: buildTree(inner),
      })
    }

    return putTree([...here.values()])
  }

  function flatten(
    sha: string,
    prefix = "",
  ): Array<TreeItem & { path: string }> {
    const items = trees.get(sha) ?? []

    return items.flatMap((item) => {
      const path = prefix ? `${prefix}/${item.name}` : item.name

      return item.type === "tree"
        ? [{ ...item, path }, ...flatten(item.sha, path)]
        : [{ ...item, path }]
    })
  }

  function blobsOf(treeSha: string): Map<string, string> {
    return new Map(
      flatten(treeSha)
        .filter((item) => item.type === "blob")
        .map((item) => [item.path, item.sha]),
    )
  }

  function putBlob(text: string | Buffer): string {
    const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text
    const sha = blobSha(bytes)
    blobs.set(sha, bytes)
    return sha
  }

  function filesTree(files: RepoFiles): string {
    return buildTree(
      new Map(
        Object.entries(files).map(([path, text]) => [path, putBlob(text)]),
      ),
    )
  }

  function isAncestor(ancestor: string, of: string): boolean {
    const queue = [of]
    const seen = new Set<string>()

    while (queue.length > 0) {
      const at = queue.shift()!

      if (at === ancestor) {
        return true
      }

      if (seen.has(at)) {
        continue
      }

      seen.add(at)
      queue.push(...(commits.get(at)?.parents ?? []))
    }

    return false
  }

  const fake: FakeGitHub = {
    url: "",
    repos: new Map(),
    tokens: new Map(),
    requests: [],
    clientId: "Iv1.fakeclient",
    devices: new Map(),
    redirectAll: false,
    hugeAnswers: false,
    beforeRefUpdate: null,
    addRepo(
      owner,
      name,
      { private: hidden = false, branch = "main", files = {} } = {},
    ) {
      const repo: FakeRepo = {
        owner,
        name,
        private: hidden,
        defaultBranch: branch,
        refs: new Map(),
      }
      fake.repos.set(`${owner}/${name}`, repo)
      fake.commit(owner, name, files, { branch, message: "First" })
      return repo
    },
    commit(owner, name, files, { branch, message = "A change" } = {}) {
      const repo = fake.repos.get(`${owner}/${name}`)!
      const on = branch ?? repo.defaultBranch
      const parent = repo.refs.get(on)
      const sha = sha1(`commit ${randomBytes(8).toString("hex")}`)
      commits.set(sha, {
        tree: filesTree(files),
        parents: parent ? [parent] : [],
        message,
      })
      repo.refs.set(on, sha)
      return sha
    },
    files(owner, name, branch) {
      const repo = fake.repos.get(`${owner}/${name}`)!
      const head = repo.refs.get(branch ?? repo.defaultBranch)!
      const out: RepoFiles = {}

      for (const [path, sha] of blobsOf(commits.get(head)!.tree)) {
        out[path] = blobs.get(sha)!.toString("utf8")
      }

      return out
    },
    log(owner, name, branch) {
      const repo = fake.repos.get(`${owner}/${name}`)!
      const messages: string[] = []
      let at = repo.refs.get(branch ?? repo.defaultBranch)

      while (at) {
        const commit = commits.get(at)!
        messages.push(commit.message)
        at = commit.parents[0]
      }

      return messages
    },
    approve(userCode, token) {
      for (const grant of fake.devices.values()) {
        if (grant.userCode === userCode) {
          grant.token = token
        }
      }
    },
    close: async () => {},
  }

  function send(response: ServerResponse, status: number, body: unknown) {
    let text = JSON.stringify(body)

    if (fake.hugeAnswers) {
      text = JSON.stringify({
        ...(body as object),
        padding: "x".repeat(40 * 1024 * 1024),
      })
    }

    response.writeHead(status, { "content-type": "application/json" })
    response.end(text)
  }

  function canRead(repo: FakeRepo, auth: string | null): boolean {
    return !repo.private || (auth !== null && fake.tokens.has(auth))
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = []

    for await (const chunk of request) {
      chunks.push(chunk as Buffer)
    }

    const body = Buffer.concat(chunks).toString("utf8")
    const url = new URL(request.url ?? "/", "http://fake")
    const header = request.headers.authorization ?? null
    fake.requests.push({
      method: request.method ?? "GET",
      path: url.pathname + url.search,
      authorization: header,
      headers: { ...request.headers },
      body,
    })

    if (fake.redirectAll) {
      response.writeHead(302, { location: "https://elsewhere.example/" })
      response.end()
      return
    }

    const auth = header?.match(/^Bearer (.+)$/)?.[1] ?? null

    if (header && (!auth || !fake.tokens.has(auth))) {
      send(response, 401, { message: "Bad credentials" })
      return
    }

    // The device flow, on github.com.
    if (url.pathname === "/login/device/code" && request.method === "POST") {
      const form = new URLSearchParams(body)

      if (form.get("client_id") !== fake.clientId) {
        send(response, 200, { error: "unauthorized_client" })
        return
      }

      const deviceCode = randomBytes(10).toString("hex")
      const userCode =
        `${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}`.toUpperCase()
      fake.devices.set(deviceCode, {
        userCode,
        steps: [],
        token: null,
        polls: 0,
      })
      send(response, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: "https://phish.example/login/device",
        expires_in: 900,
        interval: 5,
      })
      return
    }

    if (
      url.pathname === "/login/oauth/access_token" &&
      request.method === "POST"
    ) {
      const form = new URLSearchParams(body)
      const grant = fake.devices.get(form.get("device_code") ?? "")

      if (!grant || form.get("client_id") !== fake.clientId) {
        send(response, 200, { error: "incorrect_device_code" })
        return
      }

      grant.polls += 1
      const step = grant.steps.shift()

      if (step === "slow_down") {
        send(response, 200, { error: "slow_down", interval: 10 })
      } else if (step === "expired") {
        send(response, 200, { error: "expired_token" })
      } else if (step === "denied") {
        send(response, 200, { error: "access_denied" })
      } else if (step === "pending" || !grant.token) {
        send(response, 200, { error: "authorization_pending" })
      } else {
        send(response, 200, {
          access_token: grant.token,
          token_type: "bearer",
          scope: "repo",
        })
      }

      return
    }

    const match = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/)
    const repo = match
      ? fake.repos.get(
          `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`,
        )
      : undefined

    if (!match || !repo || !canRead(repo, auth)) {
      send(response, 404, { message: "Not Found" })
      return
    }

    const rest = match[3] ?? ""
    const method = request.method ?? "GET"
    const push = auth ? (fake.tokens.get(auth)?.push ?? false) : false
    const writing = method !== "GET"

    if (writing && !push) {
      send(response, auth ? 403 : 401, {
        message: auth
          ? "Resource not accessible by personal access token"
          : "Requires authentication",
      })
      return
    }

    if (rest === "" && method === "GET") {
      send(response, 200, {
        full_name: `${repo.owner}/${repo.name}`,
        default_branch: repo.defaultBranch,
        private: repo.private,
        ...(auth ? { permissions: { admin: false, push, pull: true } } : {}),
      })
      return
    }

    const ref = rest.match(/^\/git\/refs?\/heads\/(.+)$/)

    if (ref && method === "GET") {
      const sha = repo.refs.get(decodeURIComponent(ref[1]!))

      return sha
        ? send(response, 200, { object: { sha, type: "commit" } })
        : send(response, 404, { message: "Not Found" })
    }

    if (ref && method === "PATCH") {
      fake.beforeRefUpdate?.()
      const branch = decodeURIComponent(ref[1]!)
      const input = JSON.parse(body) as { sha: string; force?: boolean }
      const current = repo.refs.get(branch)

      if (!commits.has(input.sha)) {
        send(response, 422, { message: "Object does not exist" })
        return
      }

      if (current && !input.force && !isAncestor(current, input.sha)) {
        send(response, 422, { message: "Update is not a fast forward" })
        return
      }

      repo.refs.set(branch, input.sha)
      send(response, 200, { object: { sha: input.sha, type: "commit" } })
      return
    }

    const commit = rest.match(/^\/git\/commits\/([0-9a-f]{40})$/)

    if (commit && method === "GET") {
      const found = commits.get(commit[1]!)

      return found
        ? send(response, 200, { sha: commit[1], tree: { sha: found.tree } })
        : send(response, 404, { message: "Not Found" })
    }

    const tree = rest.match(/^\/git\/trees\/([0-9a-f]{40})$/)

    if (tree && method === "GET") {
      if (!trees.has(tree[1]!)) {
        send(response, 404, { message: "Not Found" })
        return
      }

      send(response, 200, {
        sha: tree[1],
        truncated: false,
        tree: flatten(tree[1]!).map((item) => ({
          path: item.path,
          mode: item.mode,
          type: item.type,
          sha: item.sha,
          ...(item.type === "blob"
            ? { size: blobs.get(item.sha)!.length }
            : {}),
        })),
      })
      return
    }

    const blob = rest.match(/^\/git\/blobs\/([0-9a-f]{40})$/)

    if (blob && method === "GET") {
      const bytes = blobs.get(blob[1]!)

      return bytes
        ? send(response, 200, {
            sha: blob[1],
            size: bytes.length,
            encoding: "base64",
            content: bytes.toString("base64").replace(/(.{60})/g, "$1\n"),
          })
        : send(response, 404, { message: "Not Found" })
    }

    if (rest === "/git/blobs" && method === "POST") {
      const input = JSON.parse(body) as { content: string; encoding: string }
      const sha = putBlob(
        input.encoding === "base64"
          ? Buffer.from(input.content, "base64")
          : input.content,
      )
      send(response, 201, { sha })
      return
    }

    if (rest === "/git/trees" && method === "POST") {
      const input = JSON.parse(body) as {
        base_tree?: string
        tree: Array<{ path: string; sha: string | null; content?: string }>
      }
      const byPath = input.base_tree
        ? blobsOf(input.base_tree)
        : new Map<string, string>()

      for (const entry of input.tree) {
        if (entry.sha === null) {
          byPath.delete(entry.path)
        } else if (entry.content !== undefined) {
          byPath.set(entry.path, putBlob(entry.content))
        } else if (!blobs.has(entry.sha)) {
          send(response, 422, { message: "Invalid tree info" })
          return
        } else {
          byPath.set(entry.path, entry.sha)
        }
      }

      send(response, 201, { sha: buildTree(byPath), tree: [] })
      return
    }

    if (rest === "/git/commits" && method === "POST") {
      const input = JSON.parse(body) as {
        message: string
        tree: string
        parents: string[]
      }
      const sha = sha1(`commit ${randomBytes(8).toString("hex")}`)
      commits.set(sha, {
        tree: input.tree,
        parents: input.parents,
        message: input.message,
      })
      send(response, 201, { sha, tree: { sha: input.tree } })
      return
    }

    send(response, 404, { message: "Not Found" })
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500)
      }
      response.end()
    })
  })

  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", resolve),
  )
  const { port } = server.address() as AddressInfo
  fake.url = `http://127.0.0.1:${port}`
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })

  return fake
}

/** The device-flow steps a test wants the next code to go through. */
export function scriptDevice(fake: FakeGitHub, steps: DeviceStep[]): void {
  for (const grant of fake.devices.values()) {
    grant.steps.push(...steps)
  }
}
