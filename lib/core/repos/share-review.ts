import YAML from "yaml"

import type { VaultContext } from "../context"
import { db } from "../db"
import { shareDescription } from "../definition-rows"
import {
  checkPersonalNote,
  readServerNote,
  readSkillNote,
  setPersonalNote,
} from "../definitions"
import { changeEndpoint, storedSpec } from "../endpoints"
import { invalid, PcpError } from "../errors"
import type { DiffLine } from "../line-merge"
import { canonicalJson } from "../permission-rules"
import { getServer, normalizeNameAndDescription } from "../servers"
import { getSkill, updateSkill } from "../skills"
import { sha256Hex } from "../crypto"

import { refOf, serializeItem, type ItemDocument } from "./documents"
import { localHash } from "./hash"
import {
  checkItemName,
  itemRoot,
  type ItemKind,
  type RepoFiles,
} from "./layout"
import { instanceSignIn, localItem } from "./local"
import {
  findPersonalData,
  ownerFactsFrom,
  type OwnerFacts,
  type PersonalHit,
} from "./personal-data"
import { pushDocument, type Proposer } from "./push"
import { listRemote, placeFiles, readItemFiles } from "./remote"
import { fileChanges, type FileChange } from "./review"
import {
  clientFor,
  findRepoItem,
  getRepo,
  linkItem,
  refreshVisibility,
  setExcluded,
  type RepoView,
  type RepoVisibility,
} from "./store"

/**
 * The review before anything of the vault goes to a repository: one core
 * function and one page (app/(dashboard)/settings/repositories/[id]/share),
 * wherever a push starts (an item page's Share, Add or a changed item's
 * push on the repository's page, and an assistant's proposal the owner
 * answers).
 *
 * It shows every file the item would be in the repository, in full, and
 * against what the repository has (a diff, for a change); what stays in the
 * vault (the instances' names and addresses, how they sign in, the note,
 * the levels, the secrets' values); and what in the files looks personal
 * (personal-data.ts, against the owner's own facts from the vault). Each
 * hit links to its line and offers what can fix it here: edit the
 * description, move that sentence to the owner's note, rename what is
 * shared, or leave the owner's address out of a shared OpenAPI document.
 *
 * Confirm pushes exactly what was shown: the review's `basis` is a hash of
 * the repository, its visibility, the item's place and every file. If any
 * of that changed since the page opened, nothing is pushed and the page
 * opens again. To a public repository (or one whose visibility GitHub has
 * not told PCP yet), Confirm waits until every hit is fixed or the owner
 * ticked it as fine to publish; to a private one, the hits are advice.
 */

/** What can fix a hit from the review page. */
export type ShareFix =
  /** The item's description holds it: edit the description. */
  | "edit_description"
  /** The item's description holds it: that sentence goes to the note. */
  | "move_to_note"
  /** What the item is shared as (its name or short name) holds it. */
  | "rename"
  /** An endpoint's OpenAPI document names it as its server's address. */
  | "instance_address"

export type ShareHit = PersonalHit & { fixes: ShareFix[] }

export type ShareFile = {
  /** In the repository. */
  path: string
  /** What the push writes; empty for a file it removes. */
  text: string
  change: FileChange["change"]
  /** Against the repository's file, for a change. */
  diff: DiffLine[] | null
}

export type ShareReview = {
  repo: Pick<
    RepoView,
    "id" | "owner" | "name" | "branch" | "access" | "visibility"
  >
  item: {
    kind: ItemKind
    /** The skill's id, or the server row standing for the definition. */
    id: string
    /** Its short name in the repository, and its name. */
    name: string
    displayName: string
    description: string
    /** Its page in PCP. */
    href: string
    /** Every server of the definition, for a server. */
    instances: string[]
  }
  /** Its folder (or a server's file) in the repository. */
  root: string
  state: "new" | "changed" | "same"
  files: ShareFile[]
  staysPrivate: Array<{ label: string; value: string }>
  hits: ShareHit[]
  /** Anyone can read the repository, or GitHub has not said it cannot. */
  public: boolean
  /** Why it cannot be pushed from here, if it cannot. */
  blocked: string | null
  /** Its name and short name can change here: it is not in a repository yet. */
  canRename: boolean
  /** What Confirm checks: the review is still the one shown. */
  basis: string
}

// ---- The owner's facts ----------------------------------------------------------

/**
 * What the vault knows of its owner, for the personal-data check: PCP's
 * public address, every server's and account's address, the email
 * addresses they sign in or send with, their SSH servers, and their name.
 * Read with no secret: these are plain columns.
 */
export async function vaultOwnerFacts(
  ctx: VaultContext,
  { publicUrl }: { publicUrl?: string | null } = {},
): Promise<OwnerFacts> {
  const [servers, vault] = await Promise.all([
    db().mcpServer.findMany({
      where: { vaultId: ctx.vaultId },
      select: {
        kind: true,
        url: true,
        smtpUrl: true,
        authUsername: true,
        mailFrom: true,
      },
    }),
    db().vault.findUnique({
      where: { id: ctx.vaultId },
      select: { name: true },
    }),
  ])
  const emails = servers.flatMap((server) =>
    [server.authUsername, server.mailFrom].filter(
      (value): value is string => !!value && value.includes("@"),
    ),
  )

  return ownerFactsFrom({
    publicUrl: publicUrl ?? null,
    serverAddresses: servers.flatMap((server) =>
      [server.url, server.smtpUrl].filter((value): value is string => !!value),
    ),
    ownAddresses: servers
      .filter((server) => server.kind === "ssh")
      .map((server) => server.url),
    emails,
    ownerName: vault?.name ?? null,
  })
}

// ---- The review -------------------------------------------------------------------

type Prepared = {
  review: ShareReview
  document: ItemDocument
  repo: RepoView
  gh: Awaited<ReturnType<typeof clientFor>>
  bidirectional: boolean
}

function itemHref(kind: ItemKind, id: string): string {
  return kind === "skill" ? `/skills/${id}` : `/servers/${id}`
}

/** The hosts an endpoint's OpenAPI document names as its servers. */
export function specServerHosts(text: string): string[] {
  return specServerUrls(text).map((url) => new URL(url).hostname.toLowerCase())
}

/** The absolute addresses an endpoint's OpenAPI document names as its servers. */
export function specServerUrls(text: string): string[] {
  let value: unknown

  try {
    value = text.trim().startsWith("{") ? JSON.parse(text) : YAML.parse(text)
  } catch {
    return []
  }

  const servers =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { servers?: unknown }).servers
      : undefined

  if (!Array.isArray(servers)) {
    return []
  }

  return servers.flatMap((server) => {
    const url =
      server && typeof server === "object"
        ? (server as { url?: unknown }).url
        : undefined

    try {
      return typeof url === "string" && /^https?:$/.test(new URL(url).protocol)
        ? [url]
        : []
    } catch {
      return []
    }
  })
}

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

function fixesFor(
  document: ItemDocument,
  hit: PersonalHit,
  canRename: boolean,
): ShareFix[] {
  const fixes: ShareFix[] = []

  if (contains(document.description, hit.match)) {
    fixes.push("edit_description", "move_to_note")
  }

  if (
    canRename &&
    document.kind !== "skill" &&
    (contains(document.name, hit.match) ||
      contains(document.displayName, hit.match))
  ) {
    fixes.push("rename")
  }

  if (
    document.kind === "endpoint" &&
    specServerHosts(document.spec.text).some((host) =>
      contains(host, hit.match),
    )
  ) {
    fixes.push("instance_address")
  }

  return fixes
}

async function staysPrivate(
  ctx: VaultContext,
  kind: ItemKind,
  id: string,
): Promise<Array<{ label: string; value: string }>> {
  if (kind === "skill") {
    const skill = await db().skill.findFirstOrThrow({
      where: { id, vaultId: ctx.vaultId },
      select: { id: true, personalNote: true },
    })
    const tokens = await db().apiTokenSkill.count({ where: { skillId: id } })

    return [
      { label: "Your note", value: readSkillNote(ctx, skill) ?? "None" },
      {
        label: "Which assistants see it",
        value:
          tokens === 0
            ? "As each token's settings say"
            : `${tokens} token${tokens === 1 ? "" : "s"} chosen for it`,
      },
    ]
  }

  const row = await getServer(ctx, id)
  const instances = row.definitionId
    ? await db().mcpServer.findMany({
        where: { definitionId: row.definitionId, vaultId: ctx.vaultId },
        orderBy: { createdAt: "asc" },
      })
    : [row]
  const ids = instances.map((instance) => instance.id)
  const [own, shared] = await Promise.all([
    db().apiTokenToolAccess.count({ where: { serverId: { in: ids } } }),
    db().vaultToolAccess.count({ where: { serverId: { in: ids } } }),
  ])
  const signIn = (
    await Promise.all(
      instances.map(async (instance) =>
        (await instanceSignIn(ctx, instance)).map(
          (line) => `${instance.slug}: ${line}`,
        ),
      ),
    )
  ).flat()
  const notes = instances.flatMap((instance) => {
    const note = readServerNote(ctx, instance)
    return note ? [`${instance.slug}: ${note}`] : []
  })
  const lines = [
    {
      label: "Names here",
      value: instances
        .map((instance) => `${instance.name} (${instance.slug})`)
        .join(", "),
    },
    ...(row.kind === "wrapper"
      ? []
      : [
          {
            label: row.kind === "openapi" ? "Base URLs" : "Addresses",
            value: instances
              .map((instance) => `${instance.slug}: ${instance.url}`)
              .join(", "),
          },
          {
            label: "Signs in with",
            value: signIn.length > 0 ? signIn.join("; ") : "No credential",
          },
        ]),
    {
      label: "On or off, pace, read-only and private addresses",
      value: "Each server's own",
    },
    { label: "Your note", value: notes.length > 0 ? notes.join("; ") : "None" },
    {
      label: "Levels",
      value:
        own + shared === 0
          ? "None set: every tool asks"
          : `${own + shared} level${own + shared === 1 ? "" : "s"} you set for your tokens`,
    },
  ]

  return [
    ...lines,
    {
      label: "Secret values and sign-ins",
      value: "Never leave PCP",
    },
  ]
}

function basisOf(
  repo: RepoView,
  root: string,
  files: ShareFile[],
  visibility: RepoVisibility,
): string {
  return sha256Hex(
    canonicalJson({
      repo: repo.id,
      branch: repo.branch,
      visibility,
      root,
      files: files.map((file) => [file.path, file.change, file.text]),
    }),
  )
}

async function prepare(
  ctx: VaultContext,
  repoId: string,
  item: { kind: ItemKind; id: string },
  { publicUrl }: { publicUrl?: string | null },
): Promise<Prepared> {
  const stored = await getRepo(ctx, repoId)
  const gh = await clientFor(ctx, stored)
  const repo = await refreshVisibility(ctx, stored, gh)
  const { document } = await localItem(ctx, item.kind, item.id)
  const ref = refOf(document)
  const link = await findRepoItem(ctx, document.kind, item.id)
  let blocked: string | null = null

  if (repo.access !== "write") {
    blocked = `${repo.owner}/${repo.name} is read-only here: nothing is pushed to it. Change its access on its page to push to it.`
  } else if (link && link.repoId !== repoId) {
    const other = await getRepo(ctx, link.repoId)
    blocked = `It is linked to ${other.owner}/${other.name}: unlink it there first.`
  }

  const root = link && link.repoId === repoId ? link.data.path : itemRoot(ref)
  const written = placeFiles(ref, root, serializeItem(document))
  const listing = await listRemote(gh, repo, repo.branch)
  const remote = listing.items.find((entry) => entry.root === root)
  const theirs: RepoFiles = remote
    ? placeFiles(remote.ref, root, await readItemFiles(gh, repo, remote))
    : {}
  const changes = fileChanges(theirs, written)
  const files: ShareFile[] = changes.map((change) => ({
    path: change.path,
    text: written[change.path] ?? "",
    change: change.change,
    diff: remote && change.change !== "same" ? change.diff : null,
  }))
  const facts = await vaultOwnerFacts(ctx, { publicUrl })
  const canRename = !link && !remote
  const hits = findPersonalData(written, facts).map((hit) => ({
    ...hit,
    fixes: fixesFor(document, hit, canRename),
  }))
  const instances =
    document.kind === "skill"
      ? []
      : await (async () => {
          const row = await getServer(ctx, item.id)
          return row.definitionId
            ? (
                await db().mcpServer.findMany({
                  where: {
                    definitionId: row.definitionId,
                    vaultId: ctx.vaultId,
                  },
                  select: { slug: true },
                  orderBy: { createdAt: "asc" },
                })
              ).map((instance) => instance.slug)
            : [row.slug]
        })()

  return {
    document,
    repo,
    gh,
    bidirectional: link?.bidirectional ?? true,
    review: {
      repo: {
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        branch: repo.branch,
        access: repo.access,
        visibility: repo.visibility,
      },
      item: {
        kind: document.kind,
        id: item.id,
        name: document.name,
        displayName:
          document.kind === "skill" ? document.name : document.displayName,
        description: document.description,
        href: itemHref(document.kind, item.id),
        instances,
      },
      root,
      state: !remote
        ? "new"
        : changes.every((change) => change.change === "same")
          ? "same"
          : "changed",
      files,
      staysPrivate: await staysPrivate(ctx, document.kind, item.id),
      hits,
      public: repo.visibility !== "private",
      blocked,
      canRename,
      basis: basisOf(repo, root, files, repo.visibility),
    },
  }
}

/**
 * The review of pushing one item of the vault to a repository: what the
 * share page shows. Reads the repository (and asks GitHub again whether it
 * is private); writes nothing but that.
 */
export async function shareReview(
  ctx: VaultContext,
  repoId: string,
  item: { kind: ItemKind; id: string },
  options: { publicUrl?: string | null } = {},
): Promise<ShareReview> {
  return (await prepare(ctx, repoId, item, options)).review
}

/** Confirm found the item, its files or the repository changed since. */
export const REVIEW_CHANGED =
  "It changed since you opened the review, so nothing was pushed. Here it is again: read it before you confirm."

export type ShareResult = {
  root: string
  /** The commit, or null when the repository had it the same already. */
  commit: string | null
  message: string
}

/**
 * Pushes the item exactly as the owner was shown it (`basis`): one commit,
 * fast-forward only, then links it (two-way unless the owner turned that
 * off) and takes it off the repository's excluded list. Refused when the
 * review changed since (REVIEW_CHANGED: the page opens again), when it is
 * blocked, or, for a public repository, while a hit is neither fixed nor in
 * `acknowledged`.
 */
export async function confirmShare(
  ctx: VaultContext,
  repoId: string,
  item: { kind: ItemKind; id: string },
  {
    basis,
    acknowledged,
    publicUrl,
    proposer = { by: "owner" },
  }: {
    basis: string
    acknowledged: string[]
    publicUrl?: string | null
    proposer?: Proposer
  },
): Promise<ShareResult> {
  const prepared = await prepare(ctx, repoId, item, { publicUrl })
  const { review, document, repo, gh } = prepared

  if (review.basis !== basis) {
    throw new PcpError("conflict", REVIEW_CHANGED)
  }

  if (review.blocked) {
    throw new PcpError("state", review.blocked)
  }

  if (review.public) {
    const ticked = new Set(acknowledged)
    const open = review.hits.filter((hit) => !ticked.has(hit.id))

    if (open.length > 0) {
      throw new PcpError(
        "forbidden",
        `${open.length === 1 ? "One thing" : `${open.length} things`} in it still ${open.length === 1 ? "looks" : "look"} personal, and anyone can read ${repo.owner}/${repo.name}: fix ${open.length === 1 ? "it" : "each"}, or tick it as fine to publish.`,
      )
    }
  }

  const pushed = await pushDocument(gh, repo, document, {
    root: review.root,
    proposer,
  })

  await linkItem(ctx, repoId, {
    kind: document.kind,
    itemId: item.id,
    path: review.root,
    remoteSha: pushed.sha,
    localHash: localHash(document),
    commit: pushed.commit,
    bidirectional: prepared.bidirectional,
  })
  await setExcluded(ctx, repoId, item, false)

  return {
    root: review.root,
    commit: pushed.commit,
    message: pushed.commit
      ? `Pushed to ${review.root}.`
      : `${review.root} was the same already.`,
  }
}

// ---- What fixes a hit -----------------------------------------------------------

/**
 * The description every instance of the item carries (a skill's own),
 * written as the owner typed it on the review page.
 */
export async function setSharedDescription(
  ctx: VaultContext,
  item: { kind: ItemKind; id: string },
  description: string,
): Promise<void> {
  if (item.kind === "skill") {
    const skill = await getSkill(ctx, item.id)
    await updateSkill(ctx, item.id, {
      name: skill.name,
      description,
      body: skill.body,
      tools: skill.tools,
      extra: skill.extra,
    })
    return
  }

  const row = await getServer(ctx, item.id)

  if (row.kind === "openapi") {
    await changeEndpoint(ctx, row.id, { description })
    return
  }

  const text = normalizeNameAndDescription({
    name: row.name,
    description,
  }).description

  await db().mcpServer.update({
    where: { id: row.id },
    data: { description: text },
  })
  await shareDescription(row.id)
}

/** The sentences of a text, as written. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

/**
 * Takes the sentences of the description that hold `text` out of it and
 * puts them at the end of the owner's note (private, never shared). Refused,
 * changing nothing, when the note would grow past its length.
 */
export async function moveToNote(
  ctx: VaultContext,
  item: { kind: ItemKind; id: string },
  text: string,
): Promise<{ description: string; note: string }> {
  const { document } = await localItem(ctx, item.kind, item.id)
  const all = sentences(document.description)
  const moved = all.filter((sentence) => contains(sentence, text))

  if (!text.trim() || moved.length === 0) {
    throw invalid("The description does not hold that any more.")
  }

  const current =
    item.kind === "skill"
      ? readSkillNote(
          ctx,
          await db().skill.findFirstOrThrow({
            where: { id: item.id, vaultId: ctx.vaultId },
            select: { id: true, personalNote: true },
          }),
        )
      : readServerNote(ctx, await getServer(ctx, item.id))
  const note = [current, ...moved].filter(Boolean).join(" ")
  const description = all
    .filter((sentence) => !contains(sentence, text))
    .join(" ")
  const kind = item.kind === "skill" ? "skill" : "server"

  // The note is checked first: nothing changes when it would not fit.
  checkPersonalNote(note)
  await setSharedDescription(ctx, item, description)
  await setPersonalNote(ctx, kind, item.id, note)

  return { description, note }
}

/**
 * What a server's definition is shared as, renamed: its name and short
 * name. Only before it is in a repository; after, it is renamed there.
 */
export async function renameShared(
  ctx: VaultContext,
  serverId: string,
  input: { name: string; slug: string },
): Promise<void> {
  const row = await getServer(ctx, serverId)

  if (!row.definitionId) {
    throw invalid(`${row.name} is not something PCP shares.`)
  }

  if (await findRepoItem(ctx, "server", serverId)) {
    throw new PcpError(
      "state",
      "It is in a repository already: rename it there, or unlink it first.",
    )
  }

  const name = normalizeNameAndDescription({
    name: input.name,
    description: "",
  }).name
  const slug = checkItemName(input.slug.trim().toLowerCase())
  const [definition, server] = await Promise.all([
    db().serverDefinition.findUnique({
      where: { vaultId_slug: { vaultId: ctx.vaultId, slug } },
      select: { id: true },
    }),
    db().mcpServer.findUnique({
      where: { vaultId_slug: { vaultId: ctx.vaultId, slug } },
      select: { definitionId: true },
    }),
  ])

  if (
    (definition && definition.id !== row.definitionId) ||
    (server && server.definitionId !== row.definitionId)
  ) {
    throw new PcpError(
      "conflict",
      `Something in your vault goes by ${slug} already: choose another short name.`,
    )
  }

  await db().serverDefinition.update({
    where: { id: row.definitionId },
    data: { name, slug },
  })
}

/**
 * Leaves the owner's address out of an endpoint's shared OpenAPI document:
 * its `servers` go, for every instance of it. Each instance keeps its own
 * base URL, which is where its requests go; the document no longer says
 * where anyone's server is.
 */
export async function keepAddressPrivate(
  ctx: VaultContext,
  serverId: string,
): Promise<void> {
  const row = await getServer(ctx, serverId)
  const spec = await storedSpec(serverId)

  if (row.kind !== "openapi" || !spec) {
    throw invalid("Only an API endpoint's schema names its server's address.")
  }

  let text: string

  if (spec.text.trim().startsWith("{")) {
    const value = JSON.parse(spec.text) as Record<string, unknown>
    delete value.servers
    text = `${JSON.stringify(value, null, 2)}\n`
  } else {
    const parsed = YAML.parseDocument(spec.text)
    parsed.delete("servers")
    text = parsed.toString()
  }

  if (text === spec.text) {
    return
  }

  await changeEndpoint(
    ctx,
    serverId,
    row.specSource === "url" && row.specUrl
      ? { fetched: { text, url: row.specUrl } }
      : { specText: text },
  )
}
