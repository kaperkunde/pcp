import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "./context"
import { cloneServer } from "./definitions"
import { createEndpoint } from "./endpoints"
import { itemAbout } from "./item-about"
import { startFakeGitHub, type FakeGitHub } from "./repos/fake-github"
import { listRemote, browseItems } from "./repos/remote"
import { confirmShare, shareReview } from "./repos/share-review"
import { clientFor, createRepo, getRepo } from "./repos/store"
import { addFromRepo, syncItem } from "./repos/sync"
import { PETS_SPEC } from "./repos/test-vault"
import { createSecret } from "./secrets"
import { createSkill, getSkill, updateSkill } from "./skills"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// The About card's Source, Sync and Sharing: where an item came from, where
// it stands with its repository, and whether anyone else reads it.

let cleanup: () => Promise<void>
let fake: FakeGitHub
let ctx: VaultContext

const PAT = "github_pat_TESTTOKEN_123456"

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({ name: "Ada", password: "correct horse battery" })
  fake = await startFakeGitHub()
  process.env.PCP_GITHUB_API_URL = fake.url
  fake.tokens.set(PAT, { push: true })
})

afterEach(async () => {
  delete process.env.PCP_GITHUB_API_URL
  await fake.close()
  await cleanup()
})

async function repo(
  name: string,
  access: "read" | "write",
  files: Record<string, string> = { "README.md": "x" },
): Promise<string> {
  fake.addRepo("ada", name, { files })
  const secretId =
    access === "write"
      ? (await createSecret(ctx, { name: `GitHub ${name}`, value: PAT })).id
      : null

  return (
    await createRepo(ctx, {
      owner: "ada",
      name,
      trust: "trusted",
      access,
      secretId,
    })
  ).id
}

describe("the About card", () => {
  it("says local and private, and offers Share only with a public repository to push to", async () => {
    const { id } = await createSkill(ctx, {
      name: "notes",
      description: "Take notes.",
      body: "Write it down.",
      tools: [],
    })

    expect(await itemAbout(ctx, "skill", id)).toMatchObject({
      source: { kind: "local" },
      sync: { kind: "local" },
      sharing: { kind: "private", repo: null, itemKind: "skill", targets: [] },
    })

    const shared = await repo("shared", "write")
    expect((await itemAbout(ctx, "skill", id)).sharing.targets).toEqual([
      { repoId: shared, repo: "ada/shared" },
    ])

    const review = await shareReview(ctx, shared, { kind: "skill", id })
    await confirmShare(
      ctx,
      shared,
      { kind: "skill", id },
      {
        basis: review.basis,
        acknowledged: [],
      },
    )
    const about = await itemAbout(ctx, "skill", id)
    expect(about.source).toMatchObject({
      kind: "repo",
      repo: "ada/shared",
      path: "skills/notes",
      imported: false,
    })
    expect(about.source.kind === "repo" && about.source.url).toMatch(
      /\/ada\/shared\/tree\/[0-9a-f]{40}\/skills\/notes$/,
    )
    expect(about.sync).toMatchObject({ status: "synced", writable: true })
    expect(about.sharing).toMatchObject({ kind: "public", repo: "ada/shared" })

    await updateSkill(ctx, id, {
      ...(await getSkill(ctx, id)),
      description: "Take short notes.",
    })
    expect((await itemAbout(ctx, "skill", id)).sync).toMatchObject({
      status: "modified",
    })
  })

  it("says imported at the commit reviewed, and update available when a newer one waits", async () => {
    const skill =
      "---\nname: notes\ndescription: Take notes.\n---\n\nWrite it.\n"
    const theirs = await repo("theirs", "read", {
      "skills/notes/SKILL.md": skill,
    })
    const stored = await getRepo(ctx, theirs)
    const gh = await clientFor(ctx, stored)
    const listing = await listRemote(gh, stored, stored.branch)
    const [browsed] = await browseItems(gh, stored, listing)
    const [added] = await addFromRepo(ctx, theirs, {
      commit: listing.head.commit,
      items: [{ root: "skills/notes", hash: browsed!.fetched!.hash }],
    })
    const id = added!.id!

    expect((await itemAbout(ctx, "skill", id)).source).toMatchObject({
      kind: "repo",
      imported: true,
      ref: listing.head.commit.slice(0, 7),
    })

    fake.commit("ada", "theirs", {
      "skills/notes/SKILL.md": skill.replace("Take notes.", "Take more."),
    })
    const about = await itemAbout(ctx, "skill", id)
    expect(about.sync).toMatchObject({ kind: "linked", status: "synced" })
    await syncItem(ctx, about.sync.kind === "linked" ? about.sync.linkId : "")
    const after = await itemAbout(ctx, "skill", id)
    expect(after.sync).toMatchObject({
      status: "update_available",
      writable: false,
      changeHref: expect.stringContaining("/settings/repositories/changes/"),
    })
    expect(after.sharing).toMatchObject({ kind: "public", repo: "ada/theirs" })
  })

  it("gives every instance of a definition its link", async () => {
    const shared = await repo("shared", "write")
    const { id } = await createEndpoint(ctx, {
      name: "Pets",
      baseUrl: "https://pets.example.com/v1",
      specSource: "upload",
      specText: PETS_SPEC,
      readOnly: true,
      authType: "none",
    })
    const item = { kind: "endpoint" as const, id }
    const review = await shareReview(ctx, shared, item)
    await confirmShare(ctx, shared, item, {
      basis: review.basis,
      acknowledged: review.hits.map((hit) => hit.id),
    })
    const clone = await cloneServer(ctx, id, {
      name: "Pets at home",
      url: "https://pets.home.example/v1",
      authType: "none",
    })

    expect((await itemAbout(ctx, "server", clone.id)).source).toMatchObject({
      kind: "repo",
      path: "endpoints/pets",
    })
    expect((await itemAbout(ctx, "server", clone.id)).sharing).toMatchObject({
      kind: "public",
      itemKind: "endpoint",
    })
  })
})
