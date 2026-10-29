import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import { db } from "../db"
import { listOwnerNotices } from "../owner-notices"
import { createSecret, writeManagedSecret } from "../secrets"
import { githubCredential } from "../upstream"
import { deleteSkill, getSkill, listSkills, updateSkill } from "../skills"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"

import { startFakeGitHub, type FakeGitHub } from "./fake-github"
import { listRemote, browseItems } from "./remote"
import {
  clientFor,
  createRepo,
  getRepo,
  getRepoItem,
  listRepoItems,
  setItemSync,
} from "./store"
import {
  addFromRepo,
  approveChange,
  declineChange,
  forgetSyncLooks,
  keepMine,
  pendingChange,
  runDueSyncs,
  syncItem,
  syncRepo,
} from "./sync"
import { confirmShare, shareReview } from "./share-review"
import {
  ANTHROPIC_SKILL,
  CLIENT_SECRET,
  OAUTH_TOKEN,
  PETS_KEY,
  populate,
  REFRESH_TOKEN,
} from "./test-vault"
import type { ItemKind } from "./layout"
import { localItems } from "./local"

// Linked repositories end to end against a fake GitHub: what a repository
// offers and adding it, pushing one commit per item, the four ways a sync
// can find an item, trust deciding what waits, the owner's answers applying
// exactly what they were shown, and due syncs running one at a time.

let cleanup: () => Promise<void>
let fake: FakeGitHub
let ctx: VaultContext

const PAT = "github_pat_TESTTOKEN_123456"

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  fake = await startFakeGitHub()
  process.env.PCP_GITHUB_API_URL = fake.url
  forgetSyncLooks()
})

afterEach(async () => {
  delete process.env.PCP_GITHUB_API_URL
  await fake.close()
  await cleanup()
})

function skillMd(
  description: string,
  body: string,
  tools: string[] = [],
): string {
  return `---\nname: notes\ndescription: ${description}\n${tools.length ? `tools:\n${tools.map((tool) => `  - ${tool}`).join("\n")}\n` : ""}---\n\n${body}\n`
}

/** A repository with one skill, linked and added to the vault. */
async function linkedSkill({
  trust = "untrusted",
  access = "read",
  bidirectional = false,
}: {
  trust?: "trusted" | "untrusted"
  access?: "read" | "write"
  bidirectional?: boolean
} = {}) {
  fake.addRepo("ada", "shared", {
    files: {
      "skills/notes/SKILL.md": skillMd("Take notes.", "Write it down."),
    },
  })
  let secretId: string | null = null

  if (access === "write") {
    fake.tokens.set(PAT, { push: true })
    secretId = (await createSecret(ctx, { name: "GitHub token", value: PAT }))
      .id
  }

  const { id: repoId } = await createRepo(ctx, {
    owner: "ada",
    name: "shared",
    trust,
    access,
    secretId,
  })
  const repo = await getRepo(ctx, repoId)
  const gh = await clientFor(ctx, repo)
  const listing = await listRemote(gh, repo, repo.branch)
  const [browsed] = await browseItems(gh, repo, listing)
  const [added] = await addFromRepo(ctx, repoId, {
    commit: listing.head.commit,
    items: [{ root: "skills/notes", hash: browsed!.fetched!.hash }],
  })
  expect(added).toMatchObject({ ok: true })
  const [item] = await listRepoItems(ctx, repoId)

  if (bidirectional) {
    await setItemSync(ctx, item!.id, {
      frequency: "daily",
      bidirectional: true,
    })
  }

  return { repoId, itemId: item!.id, skillId: item!.itemId }
}

/** The owner's review of pushing one item, confirmed as shown. */
async function share(repoId: string, item: { kind: ItemKind; id: string }) {
  const review = await shareReview(ctx, repoId, item)
  return confirmShare(ctx, repoId, item, {
    basis: review.basis,
    acknowledged: review.hits.map((hit) => hit.id),
  })
}

function remoteSkill(): string {
  return fake.files("ada", "shared")["skills/notes/SKILL.md"]!
}

function changeRemote(text: string) {
  fake.commit("ada", "shared", {
    ...fake.files("ada", "shared"),
    "skills/notes/SKILL.md": text,
  })
}

describe("what a repository offers", () => {
  it("lists PCP's layout and skill folders anywhere, as Anthropic's repositories have them", async () => {
    fake.addRepo("anthropics", "skills", {
      files: {
        "README.md": "# Skills",
        "pdf-tools/SKILL.md": ANTHROPIC_SKILL,
        "pdf-tools/reference.md": "Pages.",
        "document-skills/xlsx/SKILL.md":
          "---\nname: xlsx\ndescription: Spreadsheets.\n---\nUse them.",
        "skills/group/docx/SKILL.md":
          "---\nname: docx\ndescription: Documents.\n---\nWrite them.",
        "skills/group/README.md": "A group of skills.",
        "skills/notes/SKILL.md": skillMd("Take notes.", "Write it down."),
        ".claude/skills/hidden/SKILL.md":
          "---\nname: hidden\ndescription: No.\n---\nNo.",
      },
    })
    const { id } = await createRepo(ctx, {
      owner: "anthropics",
      name: "skills",
      trust: "untrusted",
      access: "read",
      secretId: null,
    })
    const repo = await getRepo(ctx, id)
    const gh = await clientFor(ctx, repo)
    const listing = await listRemote(gh, repo, repo.branch)

    expect(listing.items.map((item) => [item.root, item.ref.name])).toEqual([
      ["document-skills/xlsx", "xlsx"],
      ["pdf-tools", "pdf-tools"],
      ["skills/group/docx", "docx"],
      ["skills/notes", "notes"],
    ])

    const browsed = await browseItems(gh, repo, listing)
    expect(browsed.every((item) => item.problem === null)).toBe(true)

    const results = await addFromRepo(ctx, id, {
      commit: listing.head.commit,
      items: browsed.map((item) => ({
        root: item.root,
        hash: item.fetched!.hash,
      })),
    })
    expect(results.every((result) => result.ok)).toBe(true)
    expect((await listSkills(ctx)).map((skill) => skill.name).sort()).toEqual([
      "docx",
      "notes",
      "pdf-tools",
      "xlsx",
    ])
    const pdf = (await listSkills(ctx)).find(
      (skill) => skill.name === "pdf-tools",
    )!
    expect(pdf.files.map((file) => file.path)).toEqual(["reference.md"])
    // Linked where each was found.
    expect(
      (await listRepoItems(ctx, id)).map((item) => item.data.path).sort(),
    ).toEqual([
      "document-skills/xlsx",
      "pdf-tools",
      "skills/group/docx",
      "skills/notes",
    ])
  })

  it("adds only what the owner was shown: a hash that differs adds nothing", async () => {
    fake.addRepo("ada", "shared", {
      files: {
        "skills/notes/SKILL.md": skillMd("Take notes.", "Write it down."),
      },
    })
    const { id } = await createRepo(ctx, {
      owner: "ada",
      name: "shared",
      trust: "untrusted",
      access: "read",
      secretId: null,
    })
    const repo = await getRepo(ctx, id)
    const listing = await listRemote(
      await clientFor(ctx, repo),
      repo,
      repo.branch,
    )

    const [result] = await addFromRepo(ctx, id, {
      commit: listing.head.commit,
      items: [{ root: "skills/notes", hash: "0".repeat(64) }],
    })

    expect(result).toMatchObject({ ok: false })
    expect(await listSkills(ctx)).toEqual([])
  })

  it("lists each item's problem and reads the rest", async () => {
    fake.addRepo("ada", "mixed", {
      files: {
        "skills/good/SKILL.md":
          "---\nname: good\ndescription: Good.\n---\nFine.",
        "skills/bad/SKILL.md": "---\nname: other\ndescription: Bad.\n---\nNo.",
        "servers/Not A Slug.yaml": "x",
      },
    })
    const { id } = await createRepo(ctx, {
      owner: "ada",
      name: "mixed",
      trust: "untrusted",
      access: "read",
      secretId: null,
    })
    const repo = await getRepo(ctx, id)
    const gh = await clientFor(ctx, repo)
    const listing = await listRemote(gh, repo, repo.branch)
    const browsed = await browseItems(gh, repo, listing)

    expect(listing.problems.map((problem) => problem.path)).toEqual([
      "servers/Not A Slug.yaml",
    ])
    expect(
      browsed.find((item) => item.root === "skills/good")?.problem,
    ).toBeNull()
    expect(browsed.find((item) => item.root === "skills/bad")?.problem).toMatch(
      /make them the same/,
    )
  })

  it("refuses read and write without a sign-in that may push", async () => {
    fake.addRepo("ada", "shared")
    fake.tokens.set(PAT, { push: false })
    const secretId = (
      await createSecret(ctx, { name: "GitHub token", value: PAT })
    ).id

    await expect(
      createRepo(ctx, {
        owner: "ada",
        name: "shared",
        trust: "untrusted",
        access: "write",
        secretId: null,
      }),
    ).rejects.toThrow(/may push/)
    await expect(
      createRepo(ctx, {
        owner: "ada",
        name: "shared",
        trust: "untrusted",
        access: "write",
        secretId,
      }),
    ).rejects.toThrow(/may not push/)
    expect(await db().repo.count()).toBe(0)
  })
})

describe("pushing items", () => {
  it("writes one commit per item naming it and who proposed it, and no secret anywhere", async () => {
    await populate(ctx)
    fake.addRepo("ada", "mine", {
      private: true,
      files: { "README.md": "Ours." },
    })
    fake.tokens.set(PAT, { push: true })
    const secretId = (
      await createSecret(ctx, { name: "GitHub token", value: PAT })
    ).id
    const { id } = await createRepo(ctx, {
      owner: "ada",
      name: "mine",
      trust: "trusted",
      access: "write",
      secretId,
    })
    const items = await localItems(ctx)

    for (const item of items) {
      await share(id, { kind: item.document.kind, id: item.id })
    }

    const log = fake.log("ada", "mine")
    expect(log).toHaveLength(items.length + 1)
    expect(log[0]).toMatch(
      /^Add \w[\w ]* [a-z0-9-]+\n\nProposed by the owner in PCP\.$/,
    )
    expect(log).toContain(
      "Add skill release-notes\n\nProposed by the owner in PCP.",
    )

    const files = fake.files("ada", "mine")
    expect(Object.keys(files)).toContain("skills/release-notes/SKILL.md")
    expect(files["README.md"]).toBe("Ours.")

    // Pushing again with nothing changed writes no commit.
    expect(
      await share(id, { kind: items[0]!.document.kind, id: items[0]!.id }),
    ).toMatchObject({ commit: null })
    expect(fake.log("ada", "mine")).toHaveLength(items.length + 1)

    // No value of a secret in a file, a path or a request; the token only as
    // the Authorization header, to the API.
    const values = [PETS_KEY, CLIENT_SECRET, OAUTH_TOKEN, REFRESH_TOKEN, PAT]
    for (const text of Object.values(files)) {
      for (const value of values) expect(text).not.toContain(value)
    }
    for (const request of fake.requests) {
      const headers = { ...request.headers }
      delete headers.authorization
      const seen = `${request.path}\n${request.body}\n${JSON.stringify(headers)}`
      for (const value of values) expect(seen).not.toContain(value)
      expect(request.authorization).toBe(`Bearer ${PAT}`)
    }
  })

  it("turns a branch that moved on in between into a conflict, never a force", async () => {
    const { repoId, skillId } = await linkedSkill({ access: "write" })
    const before = fake.log("ada", "shared")
    await updateSkill(ctx, skillId, {
      ...(await getSkill(ctx, skillId)),
      description: "Take short notes.",
    })
    fake.beforeRefUpdate = () => {
      fake.beforeRefUpdate = null
      fake.commit("ada", "shared", {
        ...fake.files("ada", "shared"),
        "OTHER.md": "Someone else's.",
      })
    }

    await expect(share(repoId, { kind: "skill", id: skillId })).rejects.toThrow(
      /moved on/,
    )
    expect(fake.log("ada", "shared")).toEqual(["A change", ...before])
    expect(remoteSkill()).toContain("Take notes.")
  })
})

describe("sync by hash", () => {
  it("does nothing when neither side changed", async () => {
    const { itemId } = await linkedSkill()
    expect(await syncItem(ctx, itemId)).toMatchObject({ outcome: "same" })
  })

  it("pushes a change only the vault made, with two-way sync on, and keeps it otherwise", async () => {
    const { itemId, skillId } = await linkedSkill({
      access: "write",
      bidirectional: true,
    })
    await updateSkill(ctx, skillId, {
      ...(await getSkill(ctx, skillId)),
      description: "Take short notes.",
    })

    expect(await syncItem(ctx, itemId)).toMatchObject({ outcome: "pushed" })
    expect(remoteSkill()).toContain("Take short notes.")
    expect(await syncItem(ctx, itemId)).toMatchObject({ outcome: "same" })

    await setItemSync(ctx, itemId, { frequency: "daily", bidirectional: false })
    await updateSkill(ctx, skillId, {
      ...(await getSkill(ctx, skillId)),
      description: "Take long notes.",
    })
    expect(await syncItem(ctx, itemId)).toMatchObject({ outcome: "local" })
    expect(remoteSkill()).toContain("Take short notes.")
  })

  it("leaves a change both sides made as a conflict, applying nothing", async () => {
    const { itemId, skillId } = await linkedSkill({
      trust: "trusted",
      access: "write",
      bidirectional: true,
    })
    await updateSkill(ctx, skillId, {
      ...(await getSkill(ctx, skillId)),
      description: "Mine.",
    })
    changeRemote(skillMd("Theirs.", "Write it down."))

    expect(await syncItem(ctx, itemId)).toMatchObject({ outcome: "conflict" })
    expect((await getSkill(ctx, skillId)).description).toBe("Mine.")
    expect(remoteSkill()).toContain("Theirs.")
    expect((await getRepoItem(ctx, itemId)).state).toBe("conflict")

    const notices = (await listOwnerNotices(ctx)).filter(
      (notice) => notice.kind === "repos",
    )
    expect(notices).toEqual([
      expect.objectContaining({
        title: "Conflict in skills/notes with ada/shared",
        href: `/settings/repositories/changes/${itemId}`,
      }),
    ])

    // Keep mine pushes it over theirs, as a new commit on top.
    const { pending } = (await getRepoItem(ctx, itemId)).data
    expect(await keepMine(ctx, itemId, { sha: pending!.sha })).toMatchObject({
      outcome: "pushed",
    })
    expect(remoteSkill()).toContain("Mine.")
    expect(
      (await listOwnerNotices(ctx)).filter((notice) => notice.kind === "repos"),
    ).toEqual([])
  })

  it("takes theirs in a conflict when the owner says so", async () => {
    const { itemId, skillId } = await linkedSkill()
    await updateSkill(ctx, skillId, {
      ...(await getSkill(ctx, skillId)),
      description: "Mine.",
    })
    changeRemote(skillMd("Theirs.", "Write it down."))
    await syncItem(ctx, itemId)
    const { pending } = (await getRepoItem(ctx, itemId)).data

    await approveChange(ctx, itemId, { sha: pending!.sha, hash: pending!.hash })

    expect((await getSkill(ctx, skillId)).description).toBe("Theirs.")
    expect(await syncItem(ctx, itemId)).toMatchObject({ outcome: "same" })
  })
})

describe("trust", () => {
  it("applies a text-only change from a trusted repository the owner pushes to at once", async () => {
    const { itemId, skillId } = await linkedSkill({
      trust: "trusted",
      access: "write",
    })
    changeRemote(skillMd("Take better notes.", "Write it all down."))

    expect(await syncItem(ctx, itemId)).toMatchObject({ outcome: "pulled" })
    expect(await getSkill(ctx, skillId)).toMatchObject({
      description: "Take better notes.",
      body: "Write it all down.",
    })
    expect(await syncItem(ctx, itemId)).toMatchObject({ outcome: "same" })
  })

  it("pins an import from a read-only repository, trusted or not: an update waits until the owner takes it", async () => {
    const { itemId, skillId } = await linkedSkill({ trust: "trusted" })
    const pinned = (await getRepoItem(ctx, itemId)).data.commit
    expect(pinned).toMatch(/^[0-9a-f]{40}$/)
    changeRemote(skillMd("Take better notes.", "Write it all down."))

    expect(await syncItem(ctx, itemId)).toMatchObject({
      outcome: "review",
      message: expect.stringMatching(/update is available/),
    })
    expect((await getSkill(ctx, skillId)).description).toBe("Take notes.")
    const item = await getRepoItem(ctx, itemId)
    expect(item.state).toBe("review")
    expect(item.data.commit).toBe(pinned)

    // Taking it goes through the review, as any other change does.
    const change = await pendingChange(ctx, itemId)
    expect(change.review.textOnly).toBe(true)
    await approveChange(ctx, itemId, change.pending)
    expect((await getSkill(ctx, skillId)).description).toBe(
      "Take better notes.",
    )
  })

  it("holds a change that raises a flag, even from a trusted repository", async () => {
    const { itemId, skillId } = await linkedSkill({ trust: "trusted" })
    changeRemote(
      skillMd("Take notes.", "Write it down.", ["github/delete_repo"]),
    )

    expect(await syncItem(ctx, itemId)).toMatchObject({ outcome: "review" })
    expect((await getSkill(ctx, skillId)).tools).toEqual([])
    const change = await pendingChange(ctx, itemId)
    expect(change.review.flags.map((flag) => flag.kind)).toEqual([
      "skill_tools",
    ])
  })

  it("holds every change from a repository the owner does not trust", async () => {
    const { itemId, skillId } = await linkedSkill({ trust: "untrusted" })
    changeRemote(skillMd("Take better notes.", "Write it down."))

    expect(await syncItem(ctx, itemId)).toMatchObject({ outcome: "review" })
    expect((await getSkill(ctx, skillId)).description).toBe("Take notes.")
    expect(
      (await listOwnerNotices(ctx)).map((notice) => notice.title),
    ).toContain("Change to review in skills/notes from ada/shared")

    // Not now: left alone until the repository changes again.
    const { pending } = (await getRepoItem(ctx, itemId)).data
    await declineChange(ctx, itemId, { sha: pending!.sha })
    expect(await syncItem(ctx, itemId)).toMatchObject({ outcome: "same" })
    changeRemote(skillMd("Take other notes.", "Write it down."))
    expect(await syncItem(ctx, itemId)).toMatchObject({ outcome: "review" })
  })
})

describe("the owner's approval", () => {
  it("applies exactly the change shown, even after the repository moved on", async () => {
    const { itemId, skillId } = await linkedSkill()
    changeRemote(skillMd("Shown to the owner.", "Write it down."))
    await syncItem(ctx, itemId)
    const { pending } = (await getRepoItem(ctx, itemId)).data
    changeRemote(skillMd("Pushed after.", "Write it down."))

    await approveChange(ctx, itemId, { sha: pending!.sha, hash: pending!.hash })

    expect((await getSkill(ctx, skillId)).description).toBe(
      "Shown to the owner.",
    )
    // The later change is a change of its own.
    expect(await syncItem(ctx, itemId)).toMatchObject({ outcome: "review" })
  })

  it("refuses an approval when the item changed in the vault since, or the change is another", async () => {
    const { itemId, skillId } = await linkedSkill()
    changeRemote(skillMd("Theirs.", "Write it down."))
    await syncItem(ctx, itemId)
    const { pending } = (await getRepoItem(ctx, itemId)).data

    await expect(
      approveChange(ctx, itemId, { sha: pending!.sha, hash: "f".repeat(64) }),
    ).rejects.toThrow(/no longer the one you were shown/)

    await updateSkill(ctx, skillId, {
      ...(await getSkill(ctx, skillId)),
      description: "Mine.",
    })
    await expect(
      approveChange(ctx, itemId, { sha: pending!.sha, hash: pending!.hash }),
    ).rejects.toThrow(/changed in your vault/)
    expect((await getSkill(ctx, skillId)).description).toBe("Mine.")
  })
})

describe("a repository's visibility", () => {
  it("is stored when it is linked, and asked again on every sync", async () => {
    const { repoId } = await linkedSkill({ access: "write" })
    expect((await getRepo(ctx, repoId)).visibility).toBe("public")

    fake.repos.get("ada/shared")!.private = true
    await syncRepo(ctx, repoId)
    expect((await getRepo(ctx, repoId)).visibility).toBe("private")

    // One not asked yet reads as such, and counts as public in a review.
    await db().repo.update({ where: { id: repoId }, data: { private: null } })
    expect((await getRepo(ctx, repoId)).visibility).toBe("unknown")
  })
})

describe("links", () => {
  it("goes when its item is deleted from the vault", async () => {
    const { skillId } = await linkedSkill()
    expect(await db().repoItem.count()).toBe(1)

    await deleteSkill(ctx, skillId)

    expect(await db().repoItem.count()).toBe(0)
  })

  it("never sends another server's OAuth tokens to GitHub", async () => {
    const tokens = await writeManagedSecret(ctx, {
      name: "oauth/some-server",
      description: "Another server's sign-in.",
      value: JSON.stringify({ access_token: OAUTH_TOKEN }),
    })

    await expect(githubCredential(ctx, tokens.id)).rejects.toThrow(
      /not one PCP sends/,
    )
    fake.addRepo("ada", "shared")
    await expect(
      createRepo(ctx, {
        owner: "ada",
        name: "shared",
        trust: "untrusted",
        access: "read",
        secretId: tokens.id,
      }),
    ).rejects.toThrow(/Choose one of your secrets/)
    expect(fake.requests).toHaveLength(0)
  })
})

describe("due syncs", () => {
  it("syncs what is due, leaves what is not, and runs one at a time per vault", async () => {
    const { itemId } = await linkedSkill({ trust: "trusted", access: "write" })
    changeRemote(skillMd("Take better notes.", "Write it down."))
    const now = Date.now()

    // Just linked: daily is not due yet.
    expect(await runDueSyncs(ctx, { now })).toEqual({ synced: 0 })
    expect((await getRepoItem(ctx, itemId)).data.localHash).toBeTruthy()

    await db().repoItem.update({
      where: { id: itemId },
      data: { lastSyncAt: new Date(now - 2 * 24 * 60 * 60 * 1000) },
    })
    forgetSyncLooks()

    const [first, second] = await Promise.all([
      runDueSyncs(ctx, { now }),
      runDueSyncs(ctx, { now }),
    ])
    expect(first).toEqual({ synced: 1 })
    expect(second).toEqual({ synced: 0, skipped: "busy" })
    expect((await listSkills(ctx))[0]!.description).toBe("Take better notes.")

    // Looked at a moment ago: not looked at again so soon.
    expect(await runDueSyncs(ctx, { now: now + 1000 })).toEqual({
      synced: 0,
      skipped: "recent",
    })

    // Off is never due.
    await setItemSync(ctx, itemId, { frequency: "off", bidirectional: false })
    await db().repoItem.update({
      where: { id: itemId },
      data: { lastSyncAt: null },
    })
    forgetSyncLooks()
    expect(await runDueSyncs(ctx, { now })).toEqual({ synced: 0 })
  })
})
