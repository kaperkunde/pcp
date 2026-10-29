import { randomUUID } from "node:crypto"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createApiToken,
  resolveApiToken,
  resolveTokenForOwner,
} from "./api-tokens"
import {
  MAX_SKILL_BODY,
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_FILE_CHARS,
  MAX_SKILL_FILES,
  MAX_SKILLS,
} from "./constants"
import type { VaultContext } from "./context"
import { asBytes, encryptString } from "./crypto"
import { db } from "./db"
import {
  buildGatewayServer,
  buildInstructions,
  DESCRIBE_TOOL_RENAMED,
  instructionsPreview,
  loadGatewayServers,
  READ_MEMORY_NOTE,
  SEARCH_TOOLS_RENAMED,
  skillInstructions,
  type GatewayScope,
} from "./gateway"
import { createMemory } from "./memories"
import {
  checkPermission,
  decidePermission,
  getPermissionView,
  withPermission,
} from "./permissions"
import { appendRequestLog } from "./request-log"
import { createServer } from "./servers"
import {
  checkSkill,
  createSkill,
  deleteSkill,
  describeSkillAsk,
  getSkill,
  importSkill,
  instructionSkills,
  listSkills,
  MAX_INSTRUCTION_SKILLS,
  parseSkillMd,
  runSkillCommand,
  saveSkillFile,
  serializeSkillMd,
  setTokenSkills,
  SKILL_FRAME,
  SKILL_INSTRUCTIONS_CHARS,
  skillsFor,
  skillText,
  tokenSkills,
  updateSkill,
  type SkillAsk,
  type SkillOutcome,
  type SkillScope,
} from "./skills"
import { scratchDatabase } from "./test-db"
import { copyTokenAccess, writeToolAccess } from "./tool-access"
import { setupVault } from "./vault"

// Skills against a scratch database: the SKILL.md format, what a skill may
// hold, which tokens see which, an assistant's change that waits for the
// owner and writes only what they read, and how search and describe find
// skills beside tools and memories.

vi.mock("./request-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./request-log")>()),
  appendRequestLog: vi.fn(async () => {}),
}))

const PUBLIC_URL = "http://localhost:3000"
const web = { publicUrl: PUBLIC_URL }

let cleanup: () => Promise<void>
let ctx: VaultContext
let scope: GatewayScope

const POSTCARDS = `---
name: send-postcards
description: "Send a postcard to a friend: who, what to write, and when."
tools:
  - postcards/send_postcard
  - postcards/gone_tool
---

# Sending postcards

1. Look up the address in addresses.md.
2. Send it with postcards/send_postcard.
`

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  vi.mocked(appendRequestLog).mockClear()

  const { id: serverId } = await createServer(ctx, {
    name: "Postcards",
    url: "https://postcards.example.com/mcp",
    authType: "none",
  })

  for (const name of ["send_postcard", "list_cards"]) {
    await db().mcpTool.create({
      data: {
        id: randomUUID(),
        serverId,
        name,
        description: `${name.replace("_", " ")}s for the owner.`,
        inputSchema: JSON.stringify({ type: "object" }),
      },
    })
  }

  const { id: tokenId, token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    keepMemories: true,
  })
  await writeToolAccess(tokenId, serverId, "list_cards", "allowed")
  scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
})

afterEach(async () => {
  await cleanup()
})

function skillScope(): SkillScope {
  return { ctx, tokenId: scope.tokenId, skillIds: scope.skillIds }
}

function said(outcome: SkillOutcome): string {
  if (!("text" in outcome)) {
    throw new Error(`expected a result, got an ask: ${outcome.lead}`)
  }
  return outcome.text
}

function askOf(outcome: SkillOutcome): SkillAsk {
  if (!("ask" in outcome)) {
    throw new Error(`expected an ask, got: ${outcome.text}`)
  }
  if (outcome.ask.kind !== "skill_change") {
    throw new Error(`expected a skill's change, got: ${outcome.ask.kind}`)
  }
  return outcome.ask
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text?: string }> }).content
    .map((part) => part.text ?? "")
    .join("")
}

async function onlyRequestId(): Promise<string> {
  const [row] = await db().permissionRequest.findMany({
    where: { status: "pending" },
  })
  return row!.id
}

async function ownerSkill() {
  return importSkill(ctx, POSTCARDS)
}

describe("SKILL.md", () => {
  it("reads the frontmatter and the body", () => {
    expect(parseSkillMd(POSTCARDS)).toEqual({
      name: "send-postcards",
      description: "Send a postcard to a friend: who, what to write, and when.",
      version: null,
      tools: ["postcards/send_postcard", "postcards/gone_tool"],
      body: "# Sending postcards\n\n1. Look up the address in addresses.md.\n2. Send it with postcards/send_postcard.",
      extra: {},
      format: null,
    })
  })

  it("writes what it reads, version and all", () => {
    const skill = {
      name: "release-notes",
      description: "Notes: what changed, and why # not a comment",
      version: 3,
      body: "---\nA rule inside the body stays.\n\n- one\n- two",
      tools: ["github/list_pull_requests"],
    }
    const text = serializeSkillMd(skill)

    expect(text.startsWith("---\nname: release-notes\n")).toBe(true)
    expect(parseSkillMd(text)).toEqual({ ...skill, extra: {}, format: null })
    expect(
      parseSkillMd(serializeSkillMd({ ...skill, tools: [] })).tools,
    ).toEqual([])
  })

  it("takes tools as one line, keeps what other tools write, and refuses what is not plain YAML", () => {
    const text =
      "---\nname: a\ndescription: b\ntools: x/y, z/w\nlicense: MIT\nallowed-tools: Bash\nrun: rm -rf /\n---\nBody"

    expect(parseSkillMd(text)).toMatchObject({
      tools: ["x/y", "z/w"],
      body: "Body",
      extra: { license: "MIT", "allowed-tools": "Bash", run: "rm -rf /" },
    })
    // Written back out after PCP's own keys, as they were.
    expect(serializeSkillMd({ ...parseSkillMd(text), version: 2 })).toContain(
      "license: MIT\nallowed-tools: Bash\nrun: rm -rf /\n---",
    )
    expect(() => parseSkillMd("# No frontmatter")).toThrow(/frontmatter/)
    expect(() => parseSkillMd("---\nname: a\n# never closed")).toThrow(
      /closing ---/,
    )
    expect(() =>
      parseSkillMd("---\nname: &n a\ndescription: *n\n---\nx"),
    ).toThrow(/YAML/)
    expect(() =>
      parseSkillMd("---\nname: &n a\ndescription: b\n---\nx"),
    ).toThrow(/anchor/)
    expect(() =>
      parseSkillMd("---\nname: a\ndescription: !!binary aGk=\n---\nx"),
    ).toThrow(/tag/)
    expect(() =>
      parseSkillMd("---\nname: a\ndescription: b\nversion: two\n---\nx"),
    ).toThrow(/whole number/)
  })
})

describe("what a skill may hold", () => {
  const base = {
    name: "release-notes",
    description: "Write release notes.",
    body: "List the changes.",
    tools: [],
  }

  it("is a slug of a name, a short description and steps of bounded length", () => {
    expect(checkSkill({ ...base, description: " Two\n lines " })).toMatchObject(
      {
        description: "Two lines",
      },
    )
    expect(() => checkSkill({ ...base, name: "Release Notes" })).toThrow(
      /lower-case/,
    )
    expect(() => checkSkill({ ...base, name: "a".repeat(65) })).toThrow(
      /lower-case/,
    )
    expect(() =>
      checkSkill({
        ...base,
        description: "x".repeat(MAX_SKILL_DESCRIPTION + 1),
      }),
    ).toThrow(/at most 300/)
    expect(() =>
      checkSkill({ ...base, body: "x".repeat(MAX_SKILL_BODY + 1) }),
    ).toThrow(/at most 20,000/)
    expect(() => checkSkill({ ...base, tools: ["not a tool"] })).toThrow(
      /server\/tool/,
    )
  })

  it("carries a few text files, never the skill itself or a path that climbs", () => {
    const file = (path: string, text = "text") => ({ path, text })

    expect(
      checkSkill({ ...base, files: [file("reference/api.md")] }).files,
    ).toEqual([file("reference/api.md")])
    expect(() =>
      checkSkill({
        ...base,
        files: Array.from({ length: MAX_SKILL_FILES + 1 }, (_, index) =>
          file(`f${index}.md`),
        ),
      }),
    ).toThrow(/at most 10 files/)
    expect(() =>
      checkSkill({
        ...base,
        files: [file("big.md", "x".repeat(MAX_SKILL_FILE_CHARS + 1))],
      }),
    ).toThrow(/at most 20,000/)
    expect(() => checkSkill({ ...base, files: [file("SKILL.md")] })).toThrow(
      /the skill itself/,
    )
    expect(() => checkSkill({ ...base, files: [file("../up.md")] })).toThrow(
      /not a usable file path/,
    )
    expect(() =>
      checkSkill({ ...base, files: [file("a.md"), file("a.md")] }),
    ).toThrow(/two files/)
  })

  it("refuses characters that do not show on screen, and drops emoji selectors as they arrive", async () => {
    expect(() => checkSkill({ ...base, body: "hidden​here" })).toThrow(
      /U\+200B/,
    )
    expect(() => checkSkill({ ...base, description: "right‮left" })).toThrow(
      /U\+202E/,
    )
    expect(() =>
      checkSkill({ ...base, files: [{ path: "a.md", text: "tag\u{E0041}" }] }),
    ).toThrow(/U\+E0041/)

    const { id } = await createSkill(ctx, { ...base, body: "Say ❤️ to Grace." })
    expect((await getSkill(ctx, id)).body).toBe("Say ❤ to Grace.")
  })

  it("is unique by name, and a vault keeps a bounded number", async () => {
    await createSkill(ctx, base)
    await expect(createSkill(ctx, base)).rejects.toThrow(/exists already/)

    await db().skill.createMany({
      data: Array.from({ length: MAX_SKILLS - 1 }, (_, index) => {
        const id = randomUUID()
        const skill = {
          ...base,
          name: `filler-${index}`,
          version: 1,
          files: [],
        }

        return {
          id,
          vaultId: ctx.vaultId,
          ciphertext: asBytes(
            encryptString(ctx.dek, JSON.stringify(skill), `skill:${id}`),
          ),
        }
      }),
    })
    await expect(
      createSkill(ctx, { ...base, name: "one-too-many" }),
    ).rejects.toThrow(/200 skills/)
  })

  it("keeps other tools' frontmatter keys through the owner's import and edits, and checks them", async () => {
    const { id } = await importSkill(
      ctx,
      "---\nname: pdf\ndescription: Read PDFs.\nlicense: Apache-2.0\nmetadata:\n  author: someone\n  tags: [a, b]\n---\nSteps.",
    )
    const extra = {
      license: "Apache-2.0",
      metadata: { author: "someone", tags: ["a", "b"] },
    }
    expect((await getSkill(ctx, id)).extra).toEqual(extra)

    await updateSkill(ctx, id, {
      name: "pdf",
      description: "Read PDF files.",
      body: "Steps.",
      tools: [],
    })
    const skill = await getSkill(ctx, id)
    expect(skill.extra).toEqual(extra)
    expect(skill.text).toContain("license: Apache-2.0")

    expect(() =>
      checkSkill({ ...base, extra: { note: "hidden\u200Bhere" } }),
    ).toThrow(/does not show/)
    expect(() => checkSkill({ ...base, extra: { name: "x" } })).toThrow(
      /skill's own/,
    )
    expect(() =>
      checkSkill({ ...base, extra: { big: "x".repeat(5_000) } }),
    ).toThrow(/under/)
  })

  it("counts a new version with each of the owner's changes", async () => {
    const { id } = await ownerSkill()
    expect((await getSkill(ctx, id)).version).toBe(1)

    await updateSkill(ctx, id, {
      name: "send-postcards",
      description: "Send a postcard.",
      body: "Just send it.",
      tools: [],
    })
    const skill = await getSkill(ctx, id)
    expect(skill).toMatchObject({ version: 2, author: "owner" })
    expect(skill.text).toContain("version: 2")

    // Ciphertext under the row, never the text.
    const row = await db().skill.findUniqueOrThrow({ where: { id } })
    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain(
      "postcard",
    )
  })
})

describe("which tokens see which skills", () => {
  it("is every skill, or the ones chosen, resolved with the token", async () => {
    const { id: postcards } = await ownerSkill()
    await createSkill(ctx, {
      name: "other",
      description: "Another.",
      body: "Steps.",
      tools: [],
    })
    expect(scope.skillIds).toBeNull()
    expect((await skillsFor(ctx, null)).map((skill) => skill.name)).toEqual([
      "other",
      "send-postcards",
    ])

    await setTokenSkills(ctx, scope.tokenId, {
      all: false,
      skillIds: [postcards],
    })
    expect((await resolveTokenForOwner(ctx, scope.tokenId)).skillIds).toEqual([
      postcards,
    ])
    expect(await tokenSkills(ctx, scope.tokenId)).toEqual({
      all: false,
      skillIds: [postcards],
    })

    const seen = { ctx, tokenId: scope.tokenId, skillIds: [postcards] }
    expect(
      said(await runSkillCommand(seen, { command: "view", path: "/skills" })),
    ).not.toContain("/skills/other/")
    await expect(
      runSkillCommand(seen, {
        command: "view",
        path: "/skills/other/SKILL.md",
      }),
    ).rejects.toThrow(/no skill/)

    await expect(
      setTokenSkills(ctx, scope.tokenId, { all: false, skillIds: ["gone"] }),
    ).rejects.toThrow(/does not exist/)

    // Deleting a skill takes it from every token's list.
    await deleteSkill(ctx, postcards)
    expect(await db().apiTokenSkill.count()).toBe(0)
  })

  it("is copied with the rest of a token's access", async () => {
    const { id: postcards } = await ownerSkill()
    const { id: other } = await createApiToken(ctx, {
      name: "Other",
      allowAllServers: true,
    })
    await setTokenSkills(ctx, scope.tokenId, {
      all: false,
      skillIds: [postcards],
    })

    await copyTokenAccess(ctx, other, scope.tokenId)

    expect(await tokenSkills(ctx, other)).toEqual({
      all: false,
      skillIds: [postcards],
    })

    await setTokenSkills(ctx, scope.tokenId, { all: true, skillIds: [] })
    await copyTokenAccess(ctx, other, scope.tokenId)
    expect(await tokenSkills(ctx, other)).toEqual({ all: true, skillIds: [] })
  })
})

describe("an assistant's change to a skill", () => {
  it("asks the owner, shows them the whole skill, and writes only that", async () => {
    const outcome = await runSkillCommand(skillScope(), {
      command: "create",
      path: "/skills/send-postcards/SKILL.md",
      file_text: POSTCARDS,
    })
    const ask = askOf(outcome)
    expect(await listSkills(ctx)).toEqual([])

    const asked = textOf(await withPermission(scope, ask))
    expect(asked).toContain("Not done yet")
    expect(asked).toContain("Add the skill send-postcards?")

    const id = await onlyRequestId()
    const view = await getPermissionView(ctx, id, web)
    expect(view?.kind).toBe("skill_change")
    expect(view?.tool).toBe("memory")
    expect(view?.warning).toContain("follow it as your procedure")
    expect(view?.skill?.text).toBe(skillText(ask.input.after!))
    expect(view?.skill?.text).toContain("version: 1")
    expect(view?.skill?.basis).toBeNull()

    expect(
      textOf(await decidePermission(ctx, id, "allow_once", web)),
    ).toContain("is added")
    const [skill] = await listSkills(ctx)
    expect(skill).toMatchObject({
      name: "send-postcards",
      version: 1,
      author: "assistant",
    })
    expect(skill!.text).toBe(view?.skill?.text)
    expect(textOf(await checkPermission(scope, id))).toContain("is added")
  })

  it("changes one with a diff against what it was, at the next version", async () => {
    const { id } = await ownerSkill()
    const ask = askOf(
      await runSkillCommand(skillScope(), {
        command: "str_replace",
        path: "/skills/send-postcards/SKILL.md",
        old_str: "2. Send it",
        new_str: "2. Ask the owner, then send it",
      }),
    )
    expect(ask.input).toMatchObject({ skillId: id, basis: 1 })
    expect(ask.input.after?.version).toBe(2)

    const shown = describeSkillAsk(ask)
    expect(shown.title).toBe("Change the skill send-postcards?")
    expect(shown.lines).toContain("Version: 1 → 2")
    expect(shown.skill.diff).toEqual(
      expect.arrayContaining([
        {
          kind: "removed",
          text: "2. Send it with postcards/send_postcard.",
        },
        {
          kind: "added",
          text: "2. Ask the owner, then send it with postcards/send_postcard.",
        },
        { kind: "added", text: "version: 2" },
      ]),
    )

    await withPermission(scope, ask)
    await decidePermission(ctx, await onlyRequestId(), "allow_once", web)

    expect(await getSkill(ctx, id)).toMatchObject({
      version: 2,
      author: "assistant",
      body: expect.stringContaining("2. Ask the owner, then send it"),
    })
  })

  it("is refused when the skill changed since the owner was asked", async () => {
    const { id } = await ownerSkill()
    const ask = askOf(
      await runSkillCommand(skillScope(), {
        command: "create",
        path: "/skills/send-postcards/addresses.md",
        file_text: "Grace: 1 Main Street",
      }),
    )
    await withPermission(scope, ask)
    const request = await onlyRequestId()

    await updateSkill(ctx, id, {
      name: "send-postcards",
      description: "The owner's own words.",
      body: "Changed by the owner.",
      tools: [],
    })

    const answer = await decidePermission(ctx, request, "allow_once", web)
    expect(answer.isError).toBe(true)
    expect(textOf(answer)).toContain("changed since the owner was asked")
    expect(await getSkill(ctx, id)).toMatchObject({
      version: 2,
      author: "owner",
      description: "The owner's own words.",
    })
    expect((await getPermissionView(ctx, request, web))?.status).toBe("failed")
  })

  it("writes nothing the owner says no to", async () => {
    const { id } = await ownerSkill()
    await withPermission(
      scope,
      askOf(
        await runSkillCommand(skillScope(), {
          command: "delete",
          path: "/skills/send-postcards",
        }),
      ),
    )

    await decidePermission(ctx, await onlyRequestId(), "decline", web)

    expect((await getSkill(ctx, id)).version).toBe(1)
  })

  it("renames and deletes a skill, and its files, through requests", async () => {
    const { id } = await ownerSkill()
    const approve = async (outcome: SkillOutcome) => {
      await withPermission(scope, askOf(outcome))
      const request = await onlyRequestId()
      const answer = await decidePermission(ctx, request, "allow_once", web)
      expect(answer.isError, textOf(answer)).toBeFalsy()
    }

    await approve(
      await runSkillCommand(skillScope(), {
        command: "create",
        path: "/skills/send-postcards/addresses.md",
        file_text: "Grace: 1 Main Street",
      }),
    )
    await approve(
      await runSkillCommand(skillScope(), {
        command: "rename",
        path: "/skills/send-postcards/addresses.md",
        new_path: "/skills/send-postcards/people/addresses.md",
      }),
    )
    expect((await getSkill(ctx, id)).files).toEqual([
      { path: "people/addresses.md", text: "Grace: 1 Main Street" },
    ])

    const rename = await runSkillCommand(skillScope(), {
      command: "rename",
      path: "/skills/send-postcards",
      new_path: "/skills/postcards",
    })
    expect(describeSkillAsk(askOf(rename)).skill.newName).toBe("postcards")
    await approve(rename)
    expect(await getSkill(ctx, id)).toMatchObject({
      name: "postcards",
      version: 4,
    })

    await approve(
      await runSkillCommand(skillScope(), {
        command: "delete",
        path: "/skills/postcards/people/addresses.md",
      }),
    )
    expect((await getSkill(ctx, id)).files).toEqual([])

    const remove = await runSkillCommand(skillScope(), {
      command: "delete",
      path: "/skills/postcards/SKILL.md",
    })
    expect(describeSkillAsk(askOf(remove)).title).toBe(
      "Delete the skill postcards?",
    )
    await approve(remove)
    expect(await listSkills(ctx)).toEqual([])
  })

  it("refuses what cannot be asked, before asking", async () => {
    await ownerSkill()

    await expect(
      runSkillCommand(skillScope(), {
        command: "create",
        path: "/skills/other-name/SKILL.md",
        file_text: POSTCARDS,
      }),
    ).rejects.toThrow(/frontmatter names the skill send-postcards/)
    await expect(
      runSkillCommand(skillScope(), {
        command: "create",
        path: "/skills/send-postcards/notes.md",
        file_text: "hidden​",
      }),
    ).rejects.toThrow(/U\+200B/)
    expect(
      said(
        await runSkillCommand(skillScope(), {
          command: "create",
          path: "/skills/send-postcards/SKILL.md",
          file_text: POSTCARDS,
        }),
      ),
    ).toContain("Nothing changed")
    expect(await db().permissionRequest.count()).toBe(0)
  })
})

describe("several changes to one skill while a request waits", () => {
  const path = "/skills/send-postcards/SKILL.md"
  const edit = (scoped: SkillScope, old_str: string, new_str: string) =>
    runSkillCommand(scoped, { command: "str_replace", path, old_str, new_str })
  const ask = async (on: GatewayScope, outcome: SkillOutcome) =>
    withPermission(on, askOf(outcome))

  async function otherToken(): Promise<GatewayScope> {
    const { token } = await createApiToken(ctx, {
      name: "Codex",
      allowAllServers: true,
      keepMemories: true,
    })
    return { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  }

  it("folds a second edit into the request still waiting, which the owner approves whole", async () => {
    const { id } = await ownerSkill()

    await ask(scope, await edit(skillScope(), "1. Look up", "1. First look up"))
    const first = await onlyRequestId()
    const folded = textOf(
      await ask(
        scope,
        await edit(skillScope(), "2. Send it", "2. Then send it"),
      ),
    )

    expect(folded).toContain(
      `Folded into the open request ${first} (now shows both changes); the owner approves them together.`,
    )
    // The link still ends the answer.
    expect(folded.trimEnd()).toMatch(new RegExp(`/permissions/${first}\\)?$`))
    expect(await db().permissionRequest.count()).toBe(1)

    const view = await getPermissionView(ctx, first, web)
    expect(view?.lines).toContain("Version: 1 → 2")
    expect(view?.skill?.diff).toEqual(
      expect.arrayContaining([
        {
          kind: "added",
          text: "1. First look up the address in addresses.md.",
        },
        {
          kind: "added",
          text: "2. Then send it with postcards/send_postcard.",
        },
      ]),
    )

    const answer = await decidePermission(ctx, first, "allow_once", {
      ...web,
      revision: view!.revision,
    })
    expect(answer.isError, textOf(answer)).toBeFalsy()
    expect(await getSkill(ctx, id)).toMatchObject({
      version: 2,
      body: expect.stringMatching(/First look up[\s\S]*Then send it/),
    })
  })

  it("finds the same request when an edit is asked again, and refuses an answer to what the owner did not read", async () => {
    await ownerSkill()

    await ask(scope, await edit(skillScope(), "1. Look up", "1. First look up"))
    const first = await onlyRequestId()
    const before = (await getPermissionView(ctx, first, web))!.revision
    await ask(scope, await edit(skillScope(), "1. Look up", "1. First look up"))
    expect((await getPermissionView(ctx, first, web))!.revision).toBe(before)

    await ask(scope, await edit(skillScope(), "2. Send it", "2. Then send it"))
    expect(await db().permissionRequest.count()).toBe(1)

    const stale = await decidePermission(ctx, first, "allow_once", {
      ...web,
      revision: before,
    })
    expect(stale.isError).toBe(true)
    expect(textOf(stale)).toContain(
      "added to this request while you had it open",
    )
    expect((await getPermissionView(ctx, first, web))?.status).toBe("pending")

    await expect(
      edit(skillScope(), "2. Send it", "2. Then send it"),
    ).rejects.toThrow(`Your open request ${first} holds your earlier changes`)
  })

  it("adds a file to a skill whose adding still waits", async () => {
    await ask(
      scope,
      await runSkillCommand(skillScope(), {
        command: "create",
        path,
        file_text: POSTCARDS,
      }),
    )
    const first = await onlyRequestId()
    await ask(
      scope,
      await runSkillCommand(skillScope(), {
        command: "create",
        path: "/skills/send-postcards/addresses.md",
        file_text: "Grace: 1 Main Street",
      }),
    )
    expect(await db().permissionRequest.count()).toBe(1)

    await expect(
      runSkillCommand(skillScope(), {
        command: "delete",
        path: "/skills/send-postcards",
      }),
    ).rejects.toThrow(/not added yet: your open request/)

    await decidePermission(ctx, first, "allow_once", web)
    const [skill] = await listSkills(ctx)
    expect(skill).toMatchObject({ name: "send-postcards", version: 1 })
    expect(skill!.files).toEqual([
      { path: "addresses.md", text: "Grace: 1 Main Street" },
    ])
  })

  it("asks anew once the owner answered, and explains a change that went stale", async () => {
    await ownerSkill()

    await ask(scope, await edit(skillScope(), "1. Look up", "1. First look up"))
    const first = await onlyRequestId()
    await decidePermission(ctx, first, "decline", web)

    await ask(scope, await edit(skillScope(), "2. Send it", "2. Then send it"))
    const second = await onlyRequestId()
    expect(second).not.toBe(first)
    expect((await getSkill(ctx, (await listSkills(ctx))[0]!.id)).version).toBe(
      1,
    )

    // Another token's change to the same skill: a request of its own, and
    // each page says the two conflict.
    const codex = await otherToken()
    await ask(
      codex,
      await edit(
        { ctx, tokenId: codex.tokenId, skillIds: codex.skillIds },
        "1. Look up",
        "1. Find",
      ),
    )
    const theirs = (await db().permissionRequest.findFirst({
      where: { tokenId: codex.tokenId },
    }))!.id
    const mine = await getPermissionView(ctx, second, web)
    const other = await getPermissionView(ctx, theirs, web)
    expect(mine?.conflicts).toEqual([
      expect.objectContaining({ id: theirs, tokenName: "Codex" }),
    ])
    expect(other?.conflicts).toEqual([
      expect.objectContaining({ id: second, tokenName: "Claude" }),
    ])
    // Not the assistant's to read.
    expect(
      textOf(
        await ask(
          scope,
          await edit(skillScope(), "2. Send it", "2. Then send it"),
        ),
      ),
    ).not.toContain(theirs)

    await decidePermission(ctx, theirs, "allow_once", web)
    expect((await getPermissionView(ctx, second, web))?.conflicts).toEqual([])

    const answer = await decidePermission(ctx, second, "allow_once", web)
    expect(answer.isError).toBe(true)
    const told = textOf(await checkPermission(scope, second))
    expect(told).toContain("did not go through")
    expect(told).toContain(
      "they were shown a change to version 1; it is at version 2 now",
    )
    expect(told).toContain("propose your change anew on top of version 2")
  })
})

describe("the owner's note on a skill, as an assistant proposes it", () => {
  const notePath = "/skills/send-postcards/.note"

  it("is the memory tool's .note: shown whole, written only as shown, never a file of the skill", async () => {
    const { id } = await ownerSkill()
    const before = await getSkill(ctx, id)

    expect(
      said(
        await runSkillCommand(skillScope(), {
          command: "view",
          path: notePath,
        }),
      ),
    ).toContain("has no note of the owner's")

    const outcome = await runSkillCommand(skillScope(), {
      command: "create",
      path: notePath,
      file_text: "For the family ones only.",
    })
    if (!("ask" in outcome) || outcome.ask.kind !== "note_change") {
      throw new Error("expected a note's request")
    }
    expect(outcome.ask.input).toMatchObject({
      target: "skill",
      id,
      via: "memory",
      note: "For the family ones only.",
    })
    expect(textOf(await withPermission(scope, outcome.ask))).toContain(
      "Save this as your note on send-postcards?",
    )
    const requestId = await onlyRequestId()
    const view = await getPermissionView(ctx, requestId, web)
    expect(view?.kind).toBe("note_change")
    expect(view?.tool).toBe("memory")
    expect(view?.lines).toContain(
      "Your note after, which every assistant that sees this skill reads as yours:\nFor the family ones only.",
    )
    expect((await getSkill(ctx, id)).note).toBeNull()

    await decidePermission(ctx, requestId, "allow_once", web)

    const after = await getSkill(ctx, id)
    expect(after.note).toBe("For the family ones only.")
    // The skill itself is as it was: no file, no new version.
    expect(after.files).toEqual(before.files)
    expect(after.version).toBe(before.version)
    expect(skillText(after)).not.toContain("family ones")
    expect(
      said(
        await runSkillCommand(skillScope(), {
          command: "view",
          path: notePath,
        }),
      ),
    ).toContain("For the family ones only.")

    const away = await runSkillCommand(skillScope(), {
      command: "delete",
      path: notePath,
    })
    expect("ask" in away && away.ask.kind).toBe("note_change")
  })

  it("is proposed again in the request still waiting, the newer note replacing the older", async () => {
    await ownerSkill()
    const propose = async (note: string) => {
      const outcome = await runSkillCommand(skillScope(), {
        command: "create",
        path: notePath,
        file_text: note,
      })
      if (!("ask" in outcome)) {
        throw new Error("expected a note's request")
      }
      return textOf(await withPermission(scope, outcome.ask))
    }

    await propose("For the family ones only.")
    const first = await onlyRequestId()
    expect(await propose("For friends and family.")).toContain(
      `Replaced the note in your open request ${first}`,
    )
    expect(await db().permissionRequest.count()).toBe(1)
    expect((await getPermissionView(ctx, first, web))?.lines).toContain(
      "Your note after, which every assistant that sees this skill reads as yours:\nFor friends and family.",
    )
  })

  it("is refused when it is not one line that fits, and is never a file's name", async () => {
    await ownerSkill()

    await expect(
      runSkillCommand(skillScope(), {
        command: "create",
        path: notePath,
        file_text: "One\nTwo",
      }),
    ).rejects.toThrow(/one line/)
    await expect(
      runSkillCommand(skillScope(), {
        command: "str_replace",
        path: notePath,
        old_str: "a",
        new_str: "b",
      }),
    ).rejects.toThrow(/takes view, create/)
    await expect(
      runSkillCommand(skillScope(), {
        command: "rename",
        path: "/skills/send-postcards/addresses.md",
        new_path: notePath,
      }),
    ).rejects.toThrow(/the owner's note, not a file/)
    expect(await db().permissionRequest.count()).toBe(0)
  })
})

describe("the skills paragraph of the instructions", () => {
  it("frames skills apart from memories and names each one", () => {
    const lines = skillInstructions([
      { name: "release-notes", description: "Write release notes." },
    ])

    expect(lines[0]).toContain("procedures the owner approved")
    expect(lines[0]).toContain("not a note to weigh, as a memory is")
    expect(lines).toContain("- skill:release-notes: Write release notes.")
    expect(skillInstructions([])).toEqual([])
  })

  it("names skills past its budget only, and past its count not at all", () => {
    const skills = Array.from(
      { length: MAX_INSTRUCTION_SKILLS + 5 },
      (_, i) => ({
        name: `skill-${String(i).padStart(3, "0")}`,
        description: "x".repeat(290),
      }),
    )
    const lines = skillInstructions(skills).slice(1)
    const full = lines.filter((line) => line.includes(": x"))
    const named = lines.filter((line) => /^- skill:skill-\d+$/.test(line))

    expect(full.join("").length).toBeLessThanOrEqual(SKILL_INSTRUCTIONS_CHARS)
    expect(full.length).toBeGreaterThan(0)
    expect(full.length + named.length).toBe(MAX_INSTRUCTION_SKILLS)
    expect(lines.at(-1)).toBe("- and 5 more: search finds the rest.")
  })

  it("goes into what a token is told, with search and describe as the way to find it", async () => {
    await ownerSkill()
    const told = await instructionsPreview(ctx, scope.tokenId)

    expect(told).toContain(
      "- skill:send-postcards: Send a postcard to a friend: who, what to write, and when.",
    )
    expect(told).toContain(
      "call search with a few words about what you need (it finds tools, the owner's skills and memories)",
    )
    expect(told).not.toContain("search_tools")
    expect(
      buildInstructions([], {
        skills: await instructionSkills(ctx, null),
      }),
    ).toContain("search finds the owner's skills by a few words")
  })
})

describe("search and describe", () => {
  async function connect() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildGatewayServer(scope, await loadGatewayServers(scope), {
      skills: await instructionSkills(ctx, scope.skillIds),
    }).connect(serverSide)
    const client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientSide)
    return client
  }

  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ) {
    const result = await client.callTool({ name, arguments: args })
    return { isError: result.isError === true, text: textOf(result) }
  }

  beforeEach(async () => {
    const { id } = await ownerSkill()
    await saveSkillFile(ctx, id, {
      path: "addresses.md",
      text: "Grace: 1 Main Street",
    })
    await createMemory(ctx, {
      path: "friends.md",
      text: "# Friends\nGrace likes postcards from the sea.",
    })
  })

  it("ranks tools, skills and memories together, each with its kind and ref", async () => {
    const client = await connect()
    const found = await call(client, "search", { query: "send a postcard" })

    expect(found.isError).toBe(false)
    const lines = found.text.split("\n")
    // The tool and the skill both name the task; the memory only mentions it.
    expect(lines.slice(0, 2).sort()).toEqual([
      "skill skill:send-postcards — Send a postcard to a friend: who, what to write, and when.",
      "tool postcards/send_postcard — send postcards for the owner.",
    ])
    expect(lines.slice(2)).toContain(
      "memory /memories/shared/friends.md — Grace likes postcards from the sea.",
    )
    expect(lines.at(-1)).toBe("describe takes a ref as it is here.")

    // Words no tool has find the skill and the memory alone.
    const friend = await call(client, "search", {
      query: "what to write to a friend",
    })
    expect(friend.text).toContain("skill skill:send-postcards")
    expect(friend.text).toContain("memory /memories/shared/friends.md")
    expect(friend.text).not.toContain("tool ")

    const skillsOnly = await call(client, "search", {
      query: "postcard",
      kind: "skill",
    })
    expect(skillsOnly.text).not.toContain("tool ")
    const oneServer = await call(client, "search", {
      query: "postcard",
      server: "postcards",
    })
    expect(oneServer.text).not.toContain("skill ")
    expect(oneServer.text).not.toContain("memory ")
    await client.close()
  })

  it("leaves out the skills a token does not see, and memories for a token that keeps none", async () => {
    await setTokenSkills(ctx, scope.tokenId, { all: false, skillIds: [] })
    await db().apiToken.update({
      where: { id: scope.tokenId },
      data: { keepMemories: false },
    })
    scope = { ...scope, skillIds: [], keepMemories: false }
    const client = await connect()
    const found = await call(client, "search", { query: "postcard" })

    expect(found.text).toContain("tool postcards/send_postcard")
    expect(found.text).not.toContain("skill:")
    expect(found.text).not.toContain("/memories/")
    expect(
      (await call(client, "describe", { ref: "skill:send-postcards" })).text,
    ).toContain("no skill called send-postcards")
    await client.close()
  })

  it("describes a skill whole, with its files and the call_handles of its tools", async () => {
    const client = await connect()
    const described = await call(client, "describe", {
      ref: "skill:send-postcards",
    })

    expect(described.isError).toBe(false)
    expect(
      described.text.startsWith(`${SKILL_FRAME}\n\n---\nname: send-postcards`),
    ).toBe(true)
    expect(described.text).toContain("1. Look up the address in addresses.md.")
    expect(described.text).toContain(
      "- skill:send-postcards/addresses.md (20 characters)",
    )
    expect(described.text).toMatch(
      /- postcards\/send_postcard \(asks the owner first\): call_handle ch_\S+/,
    )
    expect(described.text).toContain(
      "- postcards/gone_tool: not a tool this token can call",
    )

    const file = await call(client, "describe", {
      ref: "skill:send-postcards/addresses.md",
    })
    expect(file.text).toBe(
      "A file of the skill send-postcards (version 2), which the owner approved with it:\n\nGrace: 1 Main Street",
    )
    expect(
      (await call(client, "describe", { ref: "skill:send-postcards/nope.md" }))
        .text,
    ).toContain("Its files: addresses.md")
    await client.close()
  })

  it("describes a tool as describe_tool did, by ref or by server and tool, and a memory as view does", async () => {
    const client = await connect()
    const byRef = await call(client, "describe", {
      ref: "postcards/send_postcard",
    })
    const byName = await call(client, "describe", {
      server: "postcards",
      tool: "send_postcard",
    })
    const bare = await call(client, "describe", { ref: "send_postcard" })

    expect(JSON.parse(byRef.text)).toMatchObject({
      server: "postcards",
      tool: "send_postcard",
      access: "ask",
    })
    expect(Object.keys(JSON.parse(byRef.text))[0]).toBe("call_handle")
    expect(JSON.parse(byName.text).tool).toBe("send_postcard")
    expect(JSON.parse(bare.text).tool).toBe("send_postcard")

    const memory = await call(client, "describe", {
      ref: "/memories/shared/friends.md",
    })
    expect(memory.text).toContain("/memories/shared/friends.md: shared")
    expect(memory.text).toContain("Grace likes postcards from the sea.")

    const unknown = await call(client, "describe", { ref: "nothing-here" })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain("search finds tools, skills and memories")
    await client.close()
  })

  it("keeps search_tools and describe_tool working as before, each saying what took its place", async () => {
    const client = await connect()
    const search = await call(client, "search_tools", { query: "postcard" })
    const [lead, blank, ...rest] = search.text.split("\n")

    expect(lead).toBe(SEARCH_TOOLS_RENAMED)
    expect(lead).toBe(
      "search_tools is now search (tools, skills and memories); use search.",
    )
    expect(blank).toBe("")
    expect(rest[0]).toMatch(/^postcards\/send_postcard — /)
    expect(search.text).not.toContain("skill:")

    const described = await call(client, "describe_tool", {
      server: "postcards",
      tool: "send_postcard",
    })
    expect(described.text.startsWith(`${DESCRIBE_TOOL_RENAMED}\n\n`)).toBe(true)
    expect(
      JSON.parse(described.text.slice(DESCRIBE_TOOL_RENAMED.length + 2)),
    ).toMatchObject({ tool: "send_postcard" })

    const missing = await call(client, "describe_tool", {
      server: "postcards",
      tool: "nope",
    })
    expect(missing.isError).toBe(true)
    expect(missing.text.startsWith(DESCRIBE_TOOL_RENAMED)).toBe(true)
    await client.close()
  })

  it("reads and asks about skills through the memory tools", async () => {
    const client = await connect()
    const view = await call(client, "read_memory", {
      command: "view",
      path: "/skills/send-postcards/SKILL.md",
    })
    expect(view.text).toContain("version 2, written by the owner")
    expect(view.text).toContain("     1\t---")
    expect(view.text.endsWith(READ_MEMORY_NOTE)).toBe(true)

    const every = await call(client, "read_memory", { command: "every" })
    expect(every.text).not.toContain(READ_MEMORY_NOTE)

    const asked = await call(client, "memory", {
      command: "str_replace",
      path: "/skills/send-postcards/SKILL.md",
      old_str: "Look up",
      new_str: "Find",
    })
    expect(asked.text).toContain("Changing a skill asks the owner.")
    expect(asked.text).toContain("Not done yet")
    expect((await listSkills(ctx))[0]!.version).toBe(2)

    const mixed = await call(client, "memory", {
      command: "rename",
      path: "/memories/shared/friends.md",
      new_path: "/skills/friends",
    })
    expect(mixed.isError).toBe(true)
    expect(mixed.text).toContain("kept apart")
    await client.close()
  })
})
