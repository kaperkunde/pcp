import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createBrowserServer } from "../browser/server"
import type { VaultContext } from "../context"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"

import { applyItem } from "./apply"
import {
  PCP_FORMAT,
  readRepo,
  serializeItem,
  programHeader,
  type ItemDocument,
  type SkillDocument,
  type WrapperDocument,
} from "./documents"
import { localHash } from "./hash"
import { checkDistinct, groupRepoFiles, type RepoFiles } from "./layout"
import { MAX_FILE_BYTES, MAX_ITEM_FILES } from "./limits"
import { localItem, localItems } from "./local"
import {
  addSecrets,
  ANTHROPIC_SKILL,
  CLIENT_SECRET,
  OAUTH_TOKEN,
  PETS_KEY,
  populate,
  REFRESH_TOKEN,
  yamlText,
} from "./test-vault"

// Shared items as a repository's files: written from one vault, read back,
// applied into another and written again, unchanged; never a secret's value;
// and what a hostile repository holds, refused.

const PASSWORD = "correct horse battery staple"

let cleanup: (() => Promise<void>) | null = null

async function freshVault(): Promise<VaultContext> {
  await cleanup?.()
  ;({ cleanup } = await scratchDatabase())
  return setupVault({ name: "Ada", password: PASSWORD })
}

beforeEach(() => {
  cleanup = null
})

afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

async function vaultFiles(ctx: VaultContext): Promise<RepoFiles> {
  const files: RepoFiles = {}

  for (const item of await localItems(ctx)) {
    Object.assign(files, serializeItem(item.document))
  }

  return files
}

/** Applied in the order things depend on each other. */
const ORDER = ["skill", "server", "endpoint", "wrapper", "flow"]

function inOrder(items: ItemDocument[]): ItemDocument[] {
  return [...items].sort(
    (a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind),
  )
}

describe("a round trip", () => {
  it("writes every kind, reads it back, applies it into another vault, and writes the same files", async () => {
    const first = await freshVault()
    await populate(first)
    const files = await vaultFiles(first)

    expect(Object.keys(files).sort()).toEqual([
      "endpoints/notes/openapi.yaml",
      "endpoints/notes/pcp.yaml",
      "endpoints/pets/openapi.json",
      "endpoints/pets/pcp.yaml",
      "flows/open-the-shop/open.js",
      "flows/open-the-shop/wrapper.yaml",
      "servers/calendar-hub.yaml",
      "servers/docs.yaml",
      "skills/release-notes/SKILL.md",
      "skills/release-notes/reference/style.md",
      "wrappers/pet-tools/add.js",
      "wrappers/pet-tools/dogs.js",
      "wrappers/pet-tools/wrapper.yaml",
    ])
    expect(files["skills/release-notes/SKILL.md"]).toContain("version: 2\n")
    expect(files["skills/release-notes/SKILL.md"]).toContain("pcp_format: 1\n")
    expect(files["wrappers/pet-tools/dogs.js"]).toMatch(
      /^\/\/ dogs: a tool of the PCP wrapper pet-tools\./,
    )

    const { items, problems } = await readRepo(files)
    expect(problems).toEqual([])
    expect(items.map((item) => `${item.kind}:${item.name}`).sort()).toEqual([
      "endpoint:notes",
      "endpoint:pets",
      "flow:open-the-shop",
      "server:calendar-hub",
      "server:docs",
      "skill:release-notes",
      "wrapper:pet-tools",
    ])

    // Another vault, with secrets of the same names (and other values) and
    // a browser of its own.
    const second = await freshVault()
    await addSecrets(second, { pets: "another-key", client: "another" })
    await createBrowserServer(second)

    for (const item of inOrder(items)) {
      const { notes } = await applyItem(second, item, { id: null })
      expect(notes).toEqual([])
    }

    const again = await vaultFiles(second)
    expect(again).toEqual(files)

    // And per kind, the hash of what was read is the hash of what was made.
    for (const item of await localItems(second)) {
      const read = items.find(
        (entry) =>
          entry.kind === item.document.kind &&
          entry.name === item.document.name,
      )!
      expect(localHash(item.document)).toBe(localHash(read))
    }
  })

  it("applies each item onto itself unchanged, and hashes text however it is formatted", async () => {
    const ctx = await freshVault()
    const { ids } = await populate(ctx)

    for (const item of await localItems(ctx)) {
      const before = serializeItem(item.document)
      await applyItem(ctx, item.document, { id: item.id })
      const after = await localItem(ctx, item.document.kind, item.id)

      expect(serializeItem(after.document)).toEqual(before)
    }

    // A skill that changes gets a version past its own, whatever the
    // document says; one that does not keeps its own.
    const skill = (await localItem(ctx, "skill", ids.skill))
      .document as SkillDocument
    await applyItem(
      ctx,
      { ...skill, version: 1, body: "Other steps." },
      { id: ids.skill },
    )
    expect((await localItem(ctx, "skill", ids.skill)).document).toMatchObject({
      version: skill.version + 1,
      body: "Other steps.",
    })
    await applyItem(
      ctx,
      { ...skill, version: 9, body: "Other steps." },
      { id: ids.skill },
    )
    expect((await localItem(ctx, "skill", ids.skill)).document).toMatchObject({
      version: 9,
    })

    // The same text, formatted otherwise, hashes the same.
    const pets = await localItem(ctx, "endpoint", ids.pets)
    const files = serializeItem(pets.document)
    const reformatted = {
      ...files,
      "endpoints/pets/pcp.yaml": `# A comment\n${files["endpoints/pets/pcp.yaml"]!.replace("pcp_format: 1\n", "")}pcp_format: 1\n\n`,
    }
    const { items } = await readRepo(reformatted)
    expect(localHash(items[0]!)).toBe(localHash(pets.document))
  })
})

describe("a skill written elsewhere", () => {
  it("imports an Agent Skill with other tools' frontmatter, and keeps it through a round trip", async () => {
    const ctx = await freshVault()
    const files = {
      "README.md": "# Some skills",
      "skills/pdf-tools/SKILL.md": ANTHROPIC_SKILL,
      "skills/pdf-tools/reference.md": "# Reference\n\nPages start at 1.\n",
      "skills/pdf-tools/LICENSE.txt": "All rights reserved.\n",
      "skills/pdf-tools/.DS_Store": "\u0000junk",
    }
    const { items, problems } = await readRepo(files)

    expect(problems).toEqual([])
    expect(items).toHaveLength(1)
    const skill = items[0]!
    expect(skill).toMatchObject({
      kind: "skill",
      name: "pdf-tools",
      // No version in the frontmatter reads as 1.
      version: 1,
      extra: {
        license: "Proprietary. LICENSE.txt has complete terms",
        "allowed-tools": "Bash, Read",
        compatibility: "claude-code",
        metadata: { author: "someone", tags: ["pdf", "documents"] },
      },
      files: [
        { path: "LICENSE.txt", text: "All rights reserved." },
        { path: "reference.md", text: "# Reference\n\nPages start at 1." },
      ],
    })

    const { id } = await applyItem(ctx, skill, { id: null })
    const local = await localItem(ctx, "skill", id)
    expect(local.document).toEqual(skill)

    const written = serializeItem(local.document)["skills/pdf-tools/SKILL.md"]!
    expect(written).toContain(
      "license: Proprietary. LICENSE.txt has complete terms\n",
    )
    expect(written).toContain("allowed-tools: Bash, Read\n")
    expect(written).toContain("metadata:\n  author: someone\n")
    expect((await readRepo(serializeItem(local.document))).items[0]).toEqual(
      skill,
    )
  })
})

describe("secrets", () => {
  it("never puts a secret's value or an OAuth token in a file", async () => {
    const ctx = await freshVault()
    await populate(ctx)
    const items = await localItems(ctx)
    const everything = [
      ...Object.values(await vaultFiles(ctx)),
      JSON.stringify(items),
    ].join("\n")

    for (const value of [PETS_KEY, CLIENT_SECRET, OAUTH_TOKEN, REFRESH_TOKEN]) {
      expect(everything).not.toContain(value)
    }

    // The names are there, which is all a repository holds.
    expect(everything).toContain("Pets key")
    expect(everything).toContain("Notes client secret")
    expect(everything).not.toContain("Calendar Hub OAuth")
  })
})

function wrapperFiles(
  yaml: Record<string, unknown> | string,
  program = "return 1",
) {
  return {
    "wrappers/simple/wrapper.yaml":
      typeof yaml === "string" ? yaml : yamlText(yaml),
    "wrappers/simple/one.js": program,
  }
}

const WRAPPER = {
  pcp_format: 1,
  version: 1,
  name: "Simple",
  description: "A wrapper.",
  callLevels: "token",
  tools: [
    {
      name: "one",
      description: "The one tool.",
      inputSchema: { type: "object" },
      calls: ["pets/list_pets"],
    },
  ],
}

async function problemOf(files: RepoFiles): Promise<string> {
  const { items, problems } = await readRepo(files)
  expect(items).toEqual([])
  expect(problems).toHaveLength(1)
  return problems[0]!.message
}

describe("a hostile repository", () => {
  it("parses a plain wrapper, as the cases below start from", async () => {
    const { items, problems } = await readRepo(wrapperFiles(WRAPPER))
    expect(problems).toEqual([])
    expect(items[0]).toMatchObject({ kind: "wrapper", name: "simple" })

    // The header PCP writes above a program is not the program, whatever
    // the folder was called when it was written.
    const { items: renamed } = await readRepo(
      wrapperFiles(
        WRAPPER,
        `${programHeader("old-name", "one")}\r\nreturn 1\r\n`,
      ),
    )
    expect((renamed[0] as WrapperDocument).tools[0]!.program).toBe("return 1")
  })

  it("is refused whole for a path that leaves its folder", async () => {
    for (const path of [
      "../outside.md",
      "skills/../../etc/passwd",
      "/skills/a/SKILL.md",
      "skills//a/SKILL.md",
      "skills/a/./SKILL.md",
      "skills\\a\\SKILL.md",
      "skills/a​/SKILL.md",
    ]) {
      await expect(readRepo({ [path]: "x" })).rejects.toThrow(
        /leaves its folder|plain path|does not show/,
      )
    }

    await expect(
      readRepo({ "skills/a/SKILL.md": "x", "skills/a/skill.md": "y" }),
    ).rejects.toThrow(/only in case/)
  })

  it("is refused whole for a file too large, or too many of them", async () => {
    await expect(
      readRepo({ "skills/big/SKILL.md": "x".repeat(MAX_FILE_BYTES + 1) }),
    ).rejects.toThrow(/bytes/)

    const many: RepoFiles = { "skills/many/SKILL.md": ANTHROPIC_SKILL }
    for (let index = 0; index < MAX_ITEM_FILES; index++) {
      many[`skills/many/file-${index}.md`] = "text"
    }
    await expect(readRepo(many)).rejects.toThrow(/at most 40/)
  })

  it("is refused whole for two items with one name", async () => {
    await expect(
      readRepo({
        ...wrapperFiles(WRAPPER),
        "endpoints/simple/pcp.yaml": "pcp_format: 1",
        "endpoints/simple/openapi.json": "{}",
      }),
    ).rejects.toThrow(/one name, simple/)
    await expect(
      readRepo({
        ...wrapperFiles(WRAPPER),
        "flows/simple/wrapper.yaml": "pcp_format: 1",
      }),
    ).rejects.toThrow(/one name, simple/)
    expect(() =>
      checkDistinct([
        { kind: "skill", name: "a" },
        { kind: "skill", name: "a" },
      ]),
    ).toThrow(/Two items go at skills\/a/)
  })

  it("leaves out an item whose folder is not a name, saying why", async () => {
    const { items, problems } = await readRepo({
      "skills/Not A Slug/SKILL.md": ANTHROPIC_SKILL,
      "servers/docs.json": "{}",
    })

    expect(items).toEqual([])
    expect(problems.map((problem) => problem.path)).toEqual([
      "skills/Not A Slug/SKILL.md",
      "servers/docs.json",
    ])
  })

  it("refuses characters that do not show on screen", async () => {
    expect(
      await problemOf(
        wrapperFiles({ ...WRAPPER, description: "Looks​ plain." }),
      ),
    ).toMatch(/does not show on screen at description \(U\+200B\)/)
    expect(await problemOf(wrapperFiles(WRAPPER, 'return "‮evil"'))).toMatch(
      /does not show on screen \(U\+202E\)/,
    )
    expect(
      await problemOf({
        "skills/pdf-tools/SKILL.md": ANTHROPIC_SKILL.replace(
          "Read reference.md",
          "Read⁠ reference.md",
        ),
      }),
    ).toMatch(/does not show on screen/)
    // An emoji's presentation selector is dropped from prose, as PCP does
    // with text that arrives.
    const { items } = await readRepo(
      wrapperFiles({ ...WRAPPER, description: "Pets ❤️" }),
    )
    expect(items[0]).toMatchObject({ description: "Pets ❤" })
  })

  it("refuses YAML anchors, aliases and tags, custom or not", async () => {
    expect(
      await problemOf(
        wrapperFiles(
          `pcp_format: 1\nname: &n Simple\ndescription: A wrapper.\ntools:\n  - name: one\n    description: One.\n    inputSchema: {type: object}\n    calls: [pets/list_pets]\n`,
        ),
      ),
    ).toMatch(/anchor/)
    expect(
      await problemOf(
        wrapperFiles(
          `pcp_format: 1\nname: &n Simple\ndescription: *n\ntools: []\n`,
        ),
      ),
    ).toMatch(/YAML/)
    expect(
      await problemOf(
        wrapperFiles(
          `pcp_format: 1\nname: !!js/function "function () {}"\ntools: []\n`,
        ),
      ),
    ).toMatch(/tag/)
    expect(
      await problemOf(
        wrapperFiles(`pcp_format: 1\nname: !custom Simple\ntools: []\n`),
      ),
    ).toMatch(/tag/)
    expect(
      await problemOf({
        "skills/pdf-tools/SKILL.md": ANTHROPIC_SKILL.replace(
          "compatibility: claude-code",
          "compatibility: !!binary aGk=",
        ),
      }),
    ).toMatch(/tag/)
  })

  it("refuses a newer pcp_format in so many words, and takes every one up to its own", async () => {
    expect(
      await problemOf(
        wrapperFiles({ ...WRAPPER, pcp_format: PCP_FORMAT + 1, more: "new" }),
      ),
    ).toMatch(/format 2, written by a newer PCP; this one reads format 1/)
    expect(
      await problemOf({
        "skills/pdf-tools/SKILL.md": ANTHROPIC_SKILL.replace(
          "license:",
          `pcp_format: ${PCP_FORMAT + 1}\nlicense:`,
        ),
      }),
    ).toMatch(/newer PCP/)
    expect(
      await problemOf(wrapperFiles({ ...WRAPPER, pcp_format: undefined })),
    ).toMatch(/no pcp_format/)
    expect(
      (await readRepo(wrapperFiles({ ...WRAPPER, pcp_format: 1 }))).items,
    ).toHaveLength(1)
  })

  it("refuses what a document does not take, and what does not check out", async () => {
    expect(
      await problemOf(wrapperFiles({ ...WRAPPER, secretValue: "x" })),
    ).toMatch(/secretValue/)
    expect(await problemOf(wrapperFiles(WRAPPER, "return ("))).toMatch(
      /does not compile/,
    )
    expect(
      await problemOf({
        ...wrapperFiles(WRAPPER),
        "wrappers/simple/other.js": "return 2",
      }),
    ).toMatch(/none of its files/)
    expect(
      await problemOf({
        "wrappers/simple/wrapper.yaml": yamlText(WRAPPER),
      }),
    ).toMatch(/one\.js/)
    expect(
      await problemOf({
        "endpoints/api/pcp.yaml": yamlText({
          pcp_format: 1,
          name: "API",
          baseUrl: "https://api.example.com",
          auth: { kind: "none" },
        }),
        "endpoints/api/openapi.json": "{ not json",
      }),
    ).toMatch(/openapi\.json/)
    expect(
      await problemOf({
        "endpoints/api/pcp.yaml": yamlText({
          pcp_format: 1,
          name: "API",
          baseUrl: "https://api.example.com",
          auth: { kind: "none" },
        }),
        "endpoints/api/openapi.yaml": '{"openapi": "3.0.3"}',
      }),
    ).toMatch(/name it openapi\.json/)
  })

  it("sorts a repository into items before reading any", () => {
    expect(
      groupRepoFiles({
        "servers/docs.yaml": "x",
        "skills/a/SKILL.md": "x",
        "skills/a/ref/b.md": "x",
        ".github/workflows/ci.yml": "x",
      }).items,
    ).toEqual([
      { ref: { kind: "server", name: "docs" }, files: { "docs.yaml": "x" } },
      {
        ref: { kind: "skill", name: "a" },
        files: { "SKILL.md": "x", "ref/b.md": "x" },
      },
    ])
  })
})
