import { PcpError } from "../errors"

import { serializeItem, type ItemDocument } from "./documents"
import {
  blobSha,
  branchHead,
  createBlob,
  createCommit,
  createTree,
  moveBranch,
  readTree,
  type GitHub,
  type TreeChange,
} from "./github"
import { itemRoot, type ItemKind } from "./layout"
import { placeFiles } from "./remote"
import type { RepoView } from "./store"

/**
 * Writing one item to a read-write repository with GitHub's Git Data API:
 * a blob for each file that changed, a tree on top of the branch's, a
 * commit whose message names the item and who proposed it, and the branch
 * moved to it as a fast-forward. One commit per change; when the branch
 * moved on in between, GitHub refuses the move and that is a conflict,
 * never a force.
 */

const NOUN: Record<ItemKind, string> = {
  skill: "skill",
  wrapper: "wrapper",
  flow: "browser flow",
  endpoint: "API endpoint",
  server: "MCP server",
  service: "service",
}

/** Who a change is from, as the commit says it. */
export type Proposer = { by: "owner" } | { by: "assistant"; tokenName: string }

export function commitMessage(
  document: ItemDocument,
  isNew: boolean,
  proposer: Proposer,
): string {
  const who =
    proposer.by === "owner"
      ? "Proposed by the owner in PCP."
      : `Proposed by the assistant "${proposer.tokenName.replace(/[\r\n]+/g, " ").slice(0, 80)}" and approved by the owner in PCP.`

  return `${isNew ? "Add" : "Update"} ${NOUN[document.kind]} ${document.name}\n\n${who}`
}

export type Pushed = {
  /** The git id of the item's folder (or file) after the push. */
  sha: string
  /** The commit, or null when nothing differed and nothing was pushed. */
  commit: string | null
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

export async function pushDocument(
  gh: GitHub,
  repo: RepoView,
  document: ItemDocument,
  {
    root = itemRoot({ kind: document.kind, name: document.name }),
    proposer,
  }: { root?: string; proposer: Proposer },
): Promise<Pushed> {
  if (repo.access !== "write") {
    throw new PcpError(
      "forbidden",
      `${repo.owner}/${repo.name} is read-only here: nothing is pushed to it.`,
    )
  }

  const ref = { kind: document.kind, name: document.name }
  const head = await branchHead(gh, repo, repo.branch)
  const entries = await readTree(gh, repo, head.tree)
  const files = placeFiles(ref, root, serializeItem(document))
  const existing = new Map(
    entries
      .filter((entry) => entry.type === "blob" && under(entry.path, root))
      .map((entry) => [entry.path, entry.sha]),
  )
  const changes: TreeChange[] = []

  for (const [path, text] of Object.entries(files).sort()) {
    if (existing.get(path) !== blobSha(text)) {
      changes.push({ path, sha: await createBlob(gh, repo, text) })
    }
  }

  for (const path of existing.keys()) {
    // A dotfile in the folder (.gitkeep) is the repository's: left alone.
    if (
      !(path in files) &&
      !path
        .slice(root.length)
        .split("/")
        .some((part) => part.startsWith("."))
    ) {
      changes.push({ path, sha: null })
    }
  }

  const before = entries.find((entry) => entry.path === root)

  if (changes.length === 0 && before) {
    return { sha: before.sha, commit: null }
  }

  const tree = await createTree(gh, repo, head.tree, changes)
  const commit = await createCommit(gh, repo, {
    message: commitMessage(document, !before, proposer),
    tree,
    parent: head.commit,
  })

  await moveBranch(gh, repo, repo.branch, commit)

  const after = (await readTree(gh, repo, tree)).find(
    (entry) => entry.path === root,
  )

  if (!after) {
    throw new PcpError(
      "upstream",
      `GitHub does not list ${root} after the push.`,
    )
  }

  return { sha: after.sha, commit }
}
