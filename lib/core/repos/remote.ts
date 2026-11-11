import { invalid, isPcpError, PcpError } from "../errors"

import { parseItem, type ItemDocument } from "./documents"
import {
  branchHead,
  readBlob,
  readTree,
  type GitHub,
  type Head,
  type RepoCoords,
  type TreeEntry,
} from "./github"
import { filesHash } from "./hash"
import {
  checkItemName,
  checkItemSize,
  checkRepoPath,
  ITEM_DIRS,
  isOneFileKind,
  itemKey,
  itemOfPath,
  itemPath,
  itemRoot,
  SKILL_MD,
  SPEC_JSON,
  SPEC_YAML,
  type ItemRef,
  type RepoFiles,
  type RepoProblem,
} from "./layout"
import {
  MAX_BROWSE_BYTES,
  MAX_BROWSE_FILES,
  MAX_FILE_BYTES,
  MAX_ITEM_FILES,
  MAX_SPEC_FILE_BYTES,
} from "./limits"

/**
 * A linked repository's items as GitHub lists them, before any file is
 * read: PCP's own layout (layout.ts), and a skill in any other folder that
 * holds a SKILL.md, as Anthropic's skill repositories have them (at the
 * root, `<name>/SKILL.md`, or deeper, `document-skills/pdf/SKILL.md`). Each
 * item is named by the git id of its folder (or a server's file), which is
 * what sync compares: the same id is the same files, byte for byte.
 */

export type RemoteItem = {
  ref: ItemRef
  /** Its folder (or a server's file) from the repository's root. */
  root: string
  /** The git id of that folder or file. */
  sha: string
  /** Laid out as PCP lays it out, or a skill folder elsewhere. */
  native: boolean
  /** Its files, by name inside the item, with where each is. */
  files: Record<string, { path: string; sha: string; size: number | null }>
}

export type RemoteListing = {
  head: Head
  items: RemoteItem[]
  problems: RepoProblem[]
}

function hidden(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."))
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash < 0 ? "" : path.slice(0, slash)
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

/** The items in a tree's entries, and what is wrong with the rest. */
export function itemsOfTree(entries: TreeEntry[]): {
  items: RemoteItem[]
  problems: RepoProblem[]
} {
  const bySha = new Map(entries.map((entry) => [entry.path, entry]))
  const blobs = entries.filter(
    (entry) => entry.type === "blob" && !hidden(entry.path),
  )
  const items = new Map<string, RemoteItem>()
  const problems: RepoProblem[] = []
  const taken = new Set<string>()
  const broken = new Set<string>()

  const add = (item: RemoteItem) => {
    const key = itemKey(item.ref)
    const before = items.get(key)

    if (before && before.root !== item.root) {
      problems.push({
        path: item.root,
        message: `${before.root} and ${item.root} are both the ${item.ref.kind} ${item.ref.name}; PCP reads neither until one is renamed.`,
      })
      broken.add(key)
      return null
    }

    const found = before ?? item
    items.set(key, found)
    return found
  }

  // Skills in folders of their own making, outermost first: a SKILL.md
  // deeper inside one is that skill's file.
  const skillDirs = blobs
    .filter((entry) => basename(entry.path) === SKILL_MD)
    .map((entry) => dirname(entry.path))
    .filter((dir) => {
      const parts = dir.split("/")
      return !(parts.length === 2 && parts[0] === ITEM_DIRS.skill)
    })
    .sort((a, b) => a.split("/").length - b.split("/").length)

  for (const dir of skillDirs) {
    if (
      dir === "" ||
      [...taken].some((outer) => dir.startsWith(`${outer}/`)) ||
      Object.values(ITEM_DIRS).some(
        (top) => top !== ITEM_DIRS.skill && dir.startsWith(`${top}/`),
      )
    ) {
      continue
    }

    let name: string

    try {
      checkRepoPath(dir)
      name = checkItemName(basename(dir))
    } catch (error) {
      problems.push({
        path: dir,
        message: error instanceof Error ? error.message : String(error),
      })
      taken.add(dir)
      continue
    }

    const tree = bySha.get(dir)

    if (!tree || tree.type !== "tree") {
      continue
    }

    taken.add(dir)
    const files: RemoteItem["files"] = {}

    for (const entry of blobs) {
      if (entry.path.startsWith(`${dir}/`)) {
        files[entry.path.slice(dir.length + 1)] = {
          path: entry.path,
          sha: entry.sha,
          size: entry.size,
        }
      }
    }

    add({
      ref: { kind: "skill", name },
      root: dir,
      sha: tree.sha,
      native: false,
      files,
    })
  }

  for (const entry of blobs) {
    if ([...taken].some((dir) => entry.path.startsWith(`${dir}/`))) {
      continue
    }

    let found: ReturnType<typeof itemOfPath>

    try {
      found = itemOfPath(entry.path)
    } catch (error) {
      if (Object.values(ITEM_DIRS).includes(entry.path.split("/")[0]!)) {
        problems.push({
          path: entry.path,
          message: error instanceof Error ? error.message : String(error),
        })
        broken.add(entry.path.split("/").slice(0, 2).join("/"))
      }
      continue
    }

    if (!found) {
      continue
    }

    const root = itemRoot(found.ref)
    const tree = bySha.get(root)

    if (!tree) {
      continue
    }

    const item = add({
      ref: found.ref,
      root,
      sha: tree.sha,
      native: true,
      files: {},
    })

    if (item) {
      item.files[found.file] = {
        path: entry.path,
        sha: entry.sha,
        size: entry.size,
      }
    }
  }

  const list = [...items.values()]
    .filter(
      (item) =>
        // skills/<group>/<name>/SKILL.md: the group is a folder, not a skill.
        !(
          item.native &&
          item.ref.kind === "skill" &&
          item.files[SKILL_MD] === undefined &&
          [...taken].some((dir) => dir.startsWith(`${item.root}/`))
        ) &&
        !broken.has(itemKey(item.ref)) &&
        !broken.has(item.root.replace(/\.yaml$/, "")) &&
        !broken.has(item.root),
    )
    .sort((a, b) => a.root.localeCompare(b.root))

  // Two server items by one name (a wrapper and an endpoint, say) are one
  // server in a vault: both are left out.
  const servers = new Map<string, RemoteItem>()

  for (const item of list) {
    if (item.ref.kind === "skill") {
      continue
    }

    const other = servers.get(item.ref.name)

    if (other) {
      problems.push({
        path: item.root,
        message: `${other.root} and ${item.root} have one name, ${item.ref.name}, and a vault has one server by a name.`,
      })
      broken.add(itemKey(other.ref))
      broken.add(itemKey(item.ref))
    }

    servers.set(item.ref.name, item)
  }

  return {
    items: list.filter((item) => !broken.has(itemKey(item.ref))),
    problems,
  }
}

/** The branch's head and the items in its tree. */
export async function listRemote(
  gh: GitHub,
  coords: RepoCoords,
  branch: string,
  at?: Head,
): Promise<RemoteListing> {
  const head = at ?? (await branchHead(gh, coords, branch))
  const { items, problems } = itemsOfTree(await readTree(gh, coords, head.tree))

  return { head, items, problems }
}

function isSpec(item: RemoteItem, file: string): boolean {
  return (
    item.ref.kind === "endpoint" && (file === SPEC_JSON || file === SPEC_YAML)
  )
}

/**
 * An item's files, read from GitHub and checked, by PCP's paths
 * (`skills/<name>/SKILL.md`, wherever the folder is in the repository).
 */
export async function readItemFiles(
  gh: GitHub,
  coords: RepoCoords,
  item: RemoteItem,
): Promise<RepoFiles> {
  const names = Object.keys(item.files)

  if (names.length > MAX_ITEM_FILES) {
    throw invalid(
      `${item.root} has ${names.length} files; an item has at most ${MAX_ITEM_FILES}.`,
    )
  }

  const byName: Record<string, string> = {}

  for (const name of names.sort()) {
    const file = item.files[name]!
    const max = isSpec(item, name) ? MAX_SPEC_FILE_BYTES : MAX_FILE_BYTES

    if (file.size !== null && file.size > max) {
      throw invalid(
        `${file.path} is ${file.size.toLocaleString("en")} bytes; a file there has at most ${max.toLocaleString("en")}.`,
      )
    }

    byName[name] = await readBlob(gh, coords, file.sha, max, file.path)
  }

  checkItemSize({ ref: item.ref, files: byName })

  return Object.fromEntries(
    Object.entries(byName).map(([name, text]) => [
      itemPath(item.ref, name),
      text,
    ]),
  )
}

export type FetchedItem = {
  item: RemoteItem
  files: RepoFiles
  /** filesHash of the files as read: what the owner is shown and approves. */
  hash: string
  document: ItemDocument
}

/** An item read and parsed; a problem with it is thrown as a PcpError. */
export async function fetchItem(
  gh: GitHub,
  coords: RepoCoords,
  item: RemoteItem,
): Promise<FetchedItem> {
  const files = await readItemFiles(gh, coords, item)
  const name = (path: string) =>
    isOneFileKind(item.ref.kind)
      ? basename(path)
      : path.slice(itemRoot(item.ref).length + 1)
  const document = await parseItem({
    ref: item.ref,
    files: Object.fromEntries(
      Object.entries(files).map(([path, text]) => [name(path), text]),
    ),
  })

  return { item, files, hash: filesHash(files), document }
}

/**
 * The item as it is at a git id, whatever the branch holds now: the folder
 * (a tree) or a server's file (a blob). Git ids name content, so this is the
 * very change the owner was shown.
 */
export async function fetchItemAt(
  gh: GitHub,
  coords: RepoCoords,
  ref: ItemRef,
  root: string,
  sha: string,
): Promise<FetchedItem> {
  const item: RemoteItem = {
    ref,
    root,
    sha,
    native: root === itemRoot(ref),
    files: {},
  }

  if (isOneFileKind(ref.kind)) {
    item.files[basename(root)] = { path: root, sha, size: null }
  } else {
    for (const entry of await readTree(gh, coords, sha)) {
      if (entry.type === "blob" && !hidden(entry.path)) {
        item.files[entry.path] = {
          path: `${root}/${entry.path}`,
          sha: entry.sha,
          size: entry.size,
        }
      }
    }
  }

  return fetchItem(gh, coords, item)
}

export type BrowsedItem = {
  ref: ItemRef
  root: string
  sha: string
  native: boolean
  /** Read and parsed; null when it has a problem. */
  fetched: FetchedItem | null
  problem: string | null
}

/**
 * Every item in the listing read and parsed, for the owner to choose from:
 * each with its problem, if any. Stops reading at the browse limits.
 */
export async function browseItems(
  gh: GitHub,
  coords: RepoCoords,
  listing: RemoteListing,
): Promise<BrowsedItem[]> {
  let files = 0
  let bytes = 0
  const out: BrowsedItem[] = []

  for (const item of listing.items) {
    const size = Object.values(item.files).reduce(
      (sum, file) => sum + (file.size ?? 0),
      0,
    )
    files += Object.keys(item.files).length
    bytes += size

    if (files > MAX_BROWSE_FILES || bytes > MAX_BROWSE_BYTES) {
      out.push({
        ref: item.ref,
        root: item.root,
        sha: item.sha,
        native: item.native,
        fetched: null,
        problem:
          "The repository has more than PCP reads at once; this item was not read.",
      })
      continue
    }

    try {
      out.push({
        ref: item.ref,
        root: item.root,
        sha: item.sha,
        native: item.native,
        fetched: await fetchItem(gh, coords, item),
        problem: null,
      })
    } catch (error) {
      if (!isPcpError(error) || error.code === "unauthorized") {
        throw error
      }

      out.push({
        ref: item.ref,
        root: item.root,
        sha: item.sha,
        native: item.native,
        fetched: null,
        problem: error.message,
      })
    }
  }

  return out
}

/**
 * The files an item is written as, at its place in the repository: PCP's
 * paths, or under the folder a skill was found in.
 */
export function placeFiles(
  ref: ItemRef,
  root: string,
  files: RepoFiles,
): RepoFiles {
  const own = itemRoot(ref)

  if (root === own) {
    return files
  }

  if (isOneFileKind(ref.kind)) {
    throw new PcpError("state", `${root} is not where a server's file goes.`)
  }

  return Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      `${root}${path.slice(own.length)}`,
      text,
    ]),
  )
}
