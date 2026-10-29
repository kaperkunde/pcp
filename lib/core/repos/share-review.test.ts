import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import { db } from "../db"
import { readServerNote, setPersonalNote } from "../definitions"
import { createEndpoint, storedSpec } from "../endpoints"
import { createSecret } from "../secrets"
import { createSkill, getSkill, updateSkill } from "../skills"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"

import { startFakeGitHub, type FakeGitHub } from "./fake-github"
import {
  confirmShare,
  keepAddressPrivate,
  moveToNote,
  renameShared,
  REVIEW_CHANGED,
  shareReview,
} from "./share-review"
import {
  createRepo,
  exclusionKey,
  findRepoItem,
  listExclusions,
  setExcluded,
} from "./store"
import { PETS_SPEC } from "./test-vault"

// The review before a push: every file in full, what stays in the vault,
// what looks personal and what fixes it, Confirm pushing exactly what was
// shown, and a public repository waiting on every hit.

let cleanup: () => Promise<void>
let fake: FakeGitHub
let ctx: VaultContext

const PAT = "github_pat_TESTTOKEN_123456"
const PUBLIC_URL = "https://pcp.kaperkun.de"

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Kevin Jones",
    password: "correct horse battery staple",
  })
  fake = await startFakeGitHub()
  process.env.PCP_GITHUB_API_URL = fake.url
  fake.tokens.set(PAT, { push: true })
})

afterEach(async () => {
  delete process.env.PCP_GITHUB_API_URL
  await fake.close()
  await cleanup()
})

/** A repository the owner pushes to, public or private. */
async function writeRepo(
  name: string,
  { private: hidden = false, access = "write" as "read" | "write" } = {},
): Promise<string> {
  fake.addRepo("kevin", name, {
    private: hidden,
    files: { "README.md": "Shared things." },
  })
  const secret = await db().secret.findFirst({ where: { name: "GitHub" } })
  const secretId =
    secret?.id ?? (await createSecret(ctx, { name: "GitHub", value: PAT })).id

  return (
    await createRepo(ctx, {
      owner: "kevin",
      name,
      trust: "trusted",
      access,
      secretId,
    })
  ).id
}

async function noteSkill(description: string): Promise<string> {
  return (
    await createSkill(ctx, {
      name: "notes",
      description,
      body: "Write it down.",
      tools: [],
    })
  ).id
}

async function coolify(): Promise<string> {
  return (
    await createEndpoint(ctx, {
      name: "Coolify gaaf",
      description: "Coolify on gaaf.kaperkun.de. Lists the apps.",
      baseUrl: "https://gaaf.kaperkun.de/v1",
      specSource: "upload",
      specText: PETS_SPEC.replace(
        "https://pets.example.com/v1",
        "https://gaaf.kaperkun.de/v1",
      ),
      readOnly: true,
      authType: "none",
    })
  ).id
}

function acknowledgeAll(review: Awaited<ReturnType<typeof shareReview>>) {
  return review.hits.map((hit) => hit.id)
}

describe("the review", () => {
  it("shows every file in full, what stays in the vault, and a diff for a change", async () => {
    const repoId = await writeRepo("shared")
    const id = await coolify()
    await setPersonalNote(ctx, "server", id, "The SECRET-NOTE for gaaf.")
    const item = { kind: "endpoint" as const, id }

    const first = await shareReview(ctx, repoId, item, {
      publicUrl: PUBLIC_URL,
    })
    expect(first).toMatchObject({
      root: "endpoints/coolify-gaaf",
      state: "new",
      public: true,
      blocked: null,
      canRename: true,
    })
    expect(first.files.map((file) => [file.path, file.change])).toEqual([
      ["endpoints/coolify-gaaf/openapi.json", "added"],
      ["endpoints/coolify-gaaf/pcp.yaml", "added"],
    ])
    expect(first.files.every((file) => file.diff === null)).toBe(true)
    expect(first.staysPrivate).toEqual(
      expect.arrayContaining([
        {
          label: "Base URLs",
          value: "coolify-gaaf: https://gaaf.kaperkun.de/v1",
        },
        {
          label: "Your note",
          value: "coolify-gaaf: The SECRET-NOTE for gaaf.",
        },
      ]),
    )
    const written = first.files.map((file) => file.text).join("\n")
    expect(written).not.toContain("SECRET-NOTE")
    expect(written).not.toContain("baseUrl")

    await confirmShare(ctx, repoId, item, {
      basis: first.basis,
      acknowledged: acknowledgeAll(first),
      publicUrl: PUBLIC_URL,
    })
    expect(Object.keys(fake.files("kevin", "shared"))).toContain(
      "endpoints/coolify-gaaf/pcp.yaml",
    )

    await db().mcpServer.update({
      where: { id },
      data: { description: "Lists the apps." },
    })
    const second = await shareReview(ctx, repoId, item, {
      publicUrl: PUBLIC_URL,
    })
    expect(second.state).toBe("changed")
    expect(second.canRename).toBe(false)
    const yaml = second.files.find((file) => file.path.endsWith("pcp.yaml"))!
    expect(yaml.change).toBe("changed")
    expect(yaml.diff?.some((line) => line.kind === "removed")).toBe(true)
  })

  it("opens again instead of pushing when anything changed since it was shown", async () => {
    const repoId = await writeRepo("shared")
    const id = await noteSkill("Take notes.")
    const item = { kind: "skill" as const, id }
    const shown = await shareReview(ctx, repoId, item)

    await updateSkill(ctx, id, {
      ...(await getSkill(ctx, id)),
      description: "Take notes, and share them.",
    })
    await expect(
      confirmShare(ctx, repoId, item, {
        basis: shown.basis,
        acknowledged: [],
      }),
    ).rejects.toThrow(REVIEW_CHANGED)
    expect(fake.log("kevin", "shared")).toHaveLength(1)

    // The repository becoming private since is a change too.
    const again = await shareReview(ctx, repoId, item)
    fake.repos.get("kevin/shared")!.private = true
    await expect(
      confirmShare(ctx, repoId, item, { basis: again.basis, acknowledged: [] }),
    ).rejects.toThrow(REVIEW_CHANGED)

    const now = await shareReview(ctx, repoId, item)
    expect(now.public).toBe(false)
    await confirmShare(ctx, repoId, item, {
      basis: now.basis,
      acknowledged: [],
    })
    expect(fake.files("kevin", "shared")["skills/notes/SKILL.md"]).toContain(
      "Take notes, and share them.",
    )
  })

  it("waits on every hit for a public repository, and only advises for a private one", async () => {
    const id = await noteSkill(
      "Take notes for kevin@kaperkun.de. Call +31 6 1234 5678 when stuck.",
    )
    const item = { kind: "skill" as const, id }
    const open = await writeRepo("open")
    const review = await shareReview(ctx, open, item, {
      publicUrl: PUBLIC_URL,
    })

    expect(review.public).toBe(true)
    expect(review.hits.map((hit) => [hit.kind, hit.match])).toEqual([
      ["email", "kevin@kaperkun.de"],
      ["phone", "+31 6 1234 5678"],
    ])
    expect(review.hits[0]!.fixes).toEqual(["edit_description", "move_to_note"])
    expect(review.hits[0]!.locations).toEqual([
      { path: "skills/notes/SKILL.md", line: 3, column: 29 },
    ])

    for (const acknowledged of [[], [review.hits[0]!.id]]) {
      await expect(
        confirmShare(ctx, open, item, {
          basis: review.basis,
          acknowledged,
          publicUrl: PUBLIC_URL,
        }),
      ).rejects.toThrow(/still looks? personal/)
    }
    expect(fake.log("kevin", "open")).toHaveLength(1)

    await confirmShare(ctx, open, item, {
      basis: review.basis,
      acknowledged: acknowledgeAll(review),
      publicUrl: PUBLIC_URL,
    })
    expect(fake.log("kevin", "open")).toHaveLength(2)

    // The same item to a private repository: the hits are advice.
    await db().repoItem.deleteMany({})
    const closed = await writeRepo("closed", { private: true })
    const advice = await shareReview(ctx, closed, item, {
      publicUrl: PUBLIC_URL,
    })
    expect(advice.public).toBe(false)
    expect(advice.hits).toHaveLength(2)
    await confirmShare(ctx, closed, item, {
      basis: advice.basis,
      acknowledged: [],
      publicUrl: PUBLIC_URL,
    })
    expect(fake.log("kevin", "closed")).toHaveLength(2)
  })

  it("is blocked for a read-only repository, and one linked elsewhere", async () => {
    const id = await noteSkill("Take notes.")
    const item = { kind: "skill" as const, id }
    const readOnly = await writeRepo("theirs", { access: "read" })

    const review = await shareReview(ctx, readOnly, item)
    expect(review.blocked).toMatch(/read-only here/)
    await expect(
      confirmShare(ctx, readOnly, item, {
        basis: review.basis,
        acknowledged: [],
      }),
    ).rejects.toThrow(/read-only here/)

    const mine = await writeRepo("mine")
    const shown = await shareReview(ctx, mine, item)
    await confirmShare(ctx, mine, item, {
      basis: shown.basis,
      acknowledged: [],
    })
    const other = await writeRepo("other")
    expect((await shareReview(ctx, other, item)).blocked).toMatch(
      /linked to kevin\/mine/,
    )
  })
})

describe("fixing a hit", () => {
  it("moves a sentence to the note, leaves the address out of the schema, and renames what is shared", async () => {
    const repoId = await writeRepo("shared")
    const id = await coolify()
    const item = { kind: "endpoint" as const, id }
    const review = await shareReview(ctx, repoId, item, {
      publicUrl: PUBLIC_URL,
    })
    const byMatch = new Map(review.hits.map((hit) => [hit.match, hit]))

    expect([...byMatch.keys()]).toEqual(["gaaf.kaperkun.de", "gaaf"])
    expect(byMatch.get("gaaf.kaperkun.de")!.fixes).toEqual([
      "edit_description",
      "move_to_note",
      "instance_address",
    ])
    // Every place here that holds the text, so fixing any of them helps.
    expect(byMatch.get("gaaf")!.fixes).toEqual([
      "edit_description",
      "move_to_note",
      "rename",
      "instance_address",
    ])

    expect(await moveToNote(ctx, item, "gaaf.kaperkun.de")).toEqual({
      description: "Lists the apps.",
      note: "Coolify on gaaf.kaperkun.de.",
    })
    const row = await db().mcpServer.findUniqueOrThrow({ where: { id } })
    expect(row.description).toBe("Lists the apps.")
    expect(readServerNote(ctx, row)).toBe("Coolify on gaaf.kaperkun.de.")

    await keepAddressPrivate(ctx, id)
    expect(JSON.parse((await storedSpec(id))!.text)).not.toHaveProperty(
      "servers",
    )
    expect(row.url).toBe("https://gaaf.kaperkun.de/v1")

    await renameShared(ctx, id, { name: "Coolify", slug: "coolify" })
    const after = await shareReview(ctx, repoId, item, {
      publicUrl: PUBLIC_URL,
    })
    expect(after.root).toBe("endpoints/coolify")
    expect(after.hits).toEqual([])
    expect(
      (await db().mcpServer.findUniqueOrThrow({ where: { id } })).name,
    ).toBe("Coolify gaaf")
  })

  it("refuses to grow the note past its length, changing nothing", async () => {
    const id = await noteSkill(`Mail kevin@kaperkun.de. ${"Long. ".repeat(10)}`)
    await setPersonalNote(ctx, "skill", id, "x".repeat(290))

    await expect(
      moveToNote(ctx, { kind: "skill", id }, "kevin@kaperkun.de"),
    ).rejects.toThrow(/300 characters/)
    expect((await getSkill(ctx, id)).description).toContain("kevin@kaperkun.de")
  })
})

describe("excluded items", () => {
  it("are kept out per repository and item, and a push takes one back in", async () => {
    const repoId = await writeRepo("shared")
    const skill = await noteSkill("Take notes.")
    const endpoint = await coolify()

    await setExcluded(ctx, repoId, { kind: "skill", id: skill }, true)
    await setExcluded(ctx, repoId, { kind: "endpoint", id: endpoint }, true)
    await setExcluded(ctx, repoId, { kind: "endpoint", id: endpoint }, true)
    const definitionKey = await exclusionKey(ctx, "endpoint", endpoint)
    expect(definitionKey).toMatch(/^definition:/)
    expect(await listExclusions(ctx, repoId)).toEqual(
      new Set([`skill:${skill}`, definitionKey]),
    )

    await setExcluded(ctx, repoId, { kind: "endpoint", id: endpoint }, false)
    expect(await listExclusions(ctx, repoId)).toEqual(
      new Set([`skill:${skill}`]),
    )

    const item = { kind: "skill" as const, id: skill }
    const review = await shareReview(ctx, repoId, item)
    await confirmShare(ctx, repoId, item, {
      basis: review.basis,
      acknowledged: [],
    })
    expect(await listExclusions(ctx, repoId)).toEqual(new Set())
    expect(await findRepoItem(ctx, "skill", skill)).toMatchObject({ repoId })
  })
})
