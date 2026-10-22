import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createApiToken,
  createOAuthApiToken,
  resolveApiToken,
  revokeApiToken,
} from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import {
  buildGatewayServer,
  buildInstructions,
  CORE_RULE,
  instructionsPreview,
  loadGatewayServers,
} from "./gateway"
import {
  getTokenInstructions,
  keepOwnInstructions,
  outdatedInstructions,
  saveTokenInstructions,
  sealInstructions,
  takeSuggestedInstructions,
} from "./instructions"
import { INSTRUCTIONS_LEAD } from "./instructions-block"
import { createMemory, instructionMemories, runMemoryCommand } from "./memories"
import { listOwnerNotices } from "./owner-notices"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// Each token's own instructions, copied from PCP's suggestion: given at the
// start of every conversation, edited by the owner, and offered for a merge
// when a newer suggestion ships. Two versions of the suggestion here, so a
// token can follow an older one.

const { V1, V2 } = vi.hoisted(() => ({
  V1: [
    "- Describe before calling.",
    "- Read a memory before changing it.",
    "- Check before retrying.",
    "- Use run_code when call_tool is missing.",
  ].join("\n"),
  V2: [
    "- Describe before calling, and pass the call_handle.",
    "- Read a memory before changing it.",
    "- Check before retrying.",
    "- Use run_code when call_tool is missing.",
    "- End with PCP's link.",
  ].join("\n"),
}))

vi.mock("./instructions-defaults", () => {
  const templates = [
    { version: 1, text: V1 },
    { version: 2, text: V2 },
  ]

  return {
    INSTRUCTION_TEMPLATES: templates,
    currentTemplate: () => templates[templates.length - 1],
    templateText: (version: number) =>
      templates.find((template) => template.version === version)?.text ?? null,
  }
})

let cleanup: () => Promise<void>
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
})

afterEach(async () => {
  await cleanup()
})

async function newToken(
  input: Partial<Parameters<typeof createApiToken>[1]> = {},
) {
  return createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    ...input,
  })
}

/** A token as tokens made before instructions are: none of its own. */
async function tokenWithout() {
  const { id, token } = await newToken({ name: "Older" })
  await db().apiToken.update({
    where: { id },
    data: { instructions: null, instructionsBase: null },
  })
  return { id, token }
}

/** A token that copied version 1 and changed a line of it. */
async function tokenOnV1(text = V1.replace("Check", "Always check")) {
  const { id } = await newToken({ name: "Follower" })
  await db().apiToken.update({
    where: { id },
    data: {
      instructions: sealInstructions(ctx, id, text),
      instructionsBase: 1,
    },
  })
  return id
}

describe("a new token", () => {
  it("gets a copy of the current suggestion, encrypted under its own row", async () => {
    const { id, token } = await newToken()
    const row = await db().apiToken.findUniqueOrThrow({ where: { id } })

    expect(row.instructionsBase).toBe(2)
    expect(Buffer.from(row.instructions!).toString("utf8")).not.toContain(
      "Describe",
    )
    expect((await resolveApiToken(token))!.instructions).toBe(V2)
    expect(await getTokenInstructions(ctx, id)).toMatchObject({
      text: V2,
      saved: true,
      base: 2,
      current: 2,
      outdated: false,
    })
  })

  it("made by an app's sign-in gets one too", async () => {
    const { id } = await createOAuthApiToken(ctx, {
      name: "Claude.ai",
      allowAllServers: true,
      clientId: "https://claude.ai/oauth/client.json",
      clientName: "Claude",
    })

    expect(await getTokenInstructions(ctx, id)).toMatchObject({
      text: V2,
      saved: true,
      base: 2,
    })
  })
})

describe("a token from before instructions", () => {
  it("shows the suggestion as not set yet, and gets nothing until the owner saves", async () => {
    const { id, token } = await tokenWithout()

    expect(await getTokenInstructions(ctx, id)).toMatchObject({
      text: V2,
      saved: false,
      base: null,
      outdated: false,
    })
    expect((await resolveApiToken(token))!.instructions).toBeNull()
    expect(await instructionsPreview(ctx, id)).not.toContain(INSTRUCTIONS_LEAD)

    await saveTokenInstructions(ctx, id, "- Answer in French.")
    expect((await resolveApiToken(token))!.instructions).toBe(
      "- Answer in French.",
    )
    expect(
      (await db().apiToken.findUniqueOrThrow({ where: { id } }))
        .instructionsBase,
    ).toBe(2)
  })
})

describe("the owner's save", () => {
  it("refuses hidden characters, conflict markers and too much text", async () => {
    const { id } = await newToken()

    await expect(saveTokenInstructions(ctx, id, "Be kind.​")).rejects.toThrow(
      "U+200B",
    )
    await expect(
      saveTokenInstructions(ctx, id, "<<<<<<< Yours\na\n=======\nb"),
    ).rejects.toThrow("settle")
    await expect(
      saveTokenInstructions(ctx, id, "x".repeat(4_001)),
    ).rejects.toThrow("at most")
    expect((await getTokenInstructions(ctx, id)).text).toBe(V2)
  })

  it("keeps the version a text follows, and changes nothing of a revoked token", async () => {
    const id = await tokenOnV1()
    await saveTokenInstructions(ctx, id, "- Mine.")
    expect(await getTokenInstructions(ctx, id)).toMatchObject({
      text: "- Mine.",
      base: 1,
      outdated: true,
    })

    await revokeApiToken(ctx, id)
    await expect(saveTokenInstructions(ctx, id, "- Other.")).rejects.toThrow(
      "revoked",
    )
  })
})

describe("delivery", () => {
  it("puts the owner's instructions right after the memory lead", () => {
    const text = buildInstructions([], {
      memories: { shared: [], always: [] },
      ownerInstructions: "- Answer in French.",
    })
    const lines = text.split("\n")

    expect(lines[0]).toContain('CALL THE read_memory TOOL WITH command "every"')
    expect(lines[1]).toBe(INSTRUCTIONS_LEAD)
    expect(lines[2]).toBe("- Answer in French.")
    expect(lines[3]).toContain("PCP is a gateway")
    expect(buildInstructions([], { ownerInstructions: "  " })).not.toContain(
      INSTRUCTIONS_LEAD,
    )
  })

  it("is in what a token is told at the start of a conversation, and in every", async () => {
    const { id, token } = await newToken({ keepMemories: true })
    await createMemory(ctx, { path: "units.md", text: "SI units." })
    const scope = {
      ...(await resolveApiToken(token))!,
      publicUrl: "http://localhost:3000",
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    // As /mcp builds it (app/mcp/route.ts).
    await buildGatewayServer(scope, await loadGatewayServers(scope), {
      memories: await instructionMemories(ctx, id),
    }).connect(serverSide)
    const client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientSide)
    const told = client.getInstructions() ?? ""
    const { tools } = await client.listTools()
    const every = await client.callTool({
      name: "read_memory",
      arguments: { command: "every" },
    })
    await client.close()

    expect(told).toContain(`${INSTRUCTIONS_LEAD}\n${V2}`)
    expect(await instructionsPreview(ctx, id)).toBe(told)
    expect(
      tools.find((tool) => tool.name === "search_tools")?.description,
    ).toContain(CORE_RULE)
    const everyText = (every.content as Array<{ text?: string }>)[0]!.text!
    expect(everyText.startsWith(`${INSTRUCTIONS_LEAD}\n${V2}`)).toBe(true)
    expect(everyText).toContain("/memories/shared/units.md")

    const without = await runMemoryCommand(
      { ctx, tokenId: id, instructions: null },
      { command: "every" },
    )
    expect("text" in without && without.text).not.toContain(INSTRUCTIONS_LEAD)
  })
})

describe("a newer suggestion", () => {
  it("is a notice for the owner while a token follows an older one", async () => {
    await newToken()
    await tokenWithout()
    expect(
      (await listOwnerNotices(ctx)).filter(
        (notice) => notice.kind === "instructions",
      ),
    ).toEqual([])

    await tokenOnV1()
    await tokenOnV1()
    const revoked = await tokenOnV1()
    await revokeApiToken(ctx, revoked)

    expect(
      (await listOwnerNotices(ctx)).filter(
        (notice) => notice.kind === "instructions",
      ),
    ).toEqual([
      {
        id: "instructions",
        kind: "instructions",
        title: "PCP's suggested instructions changed for 2 assistants",
        href: "/tokens/instructions",
        detail: "Keep yours, take PCP's, or merge them",
      },
    ])
  })

  it("offers the owner's changes and PCP's merged", async () => {
    const id = await tokenOnV1()
    const [update] = await outdatedInstructions(ctx)

    expect(update).toMatchObject({ tokenId: id, tokenName: "Follower" })
    expect(update!.merge).toEqual({
      text: [
        "- Describe before calling, and pass the call_handle.",
        "- Read a memory before changing it.",
        "- Always check before retrying.",
        "- Use run_code when call_tool is missing.",
        "- End with PCP's link.",
      ].join("\n"),
      conflicts: 0,
    })

    await saveTokenInstructions(ctx, id, update!.merge.text, { merged: true })
    expect(await getTokenInstructions(ctx, id)).toMatchObject({
      text: update!.merge.text,
      base: 2,
      outdated: false,
    })
    expect(await outdatedInstructions(ctx)).toEqual([])
  })

  it("marks a line both changed, and saves nothing until the owner settles it", async () => {
    const id = await tokenOnV1(
      V1.replace("Describe before calling.", "Describe first."),
    )
    const [update] = await outdatedInstructions(ctx)

    expect(update!.merge.conflicts).toBe(1)
    await expect(
      saveTokenInstructions(ctx, id, update!.merge.text, { merged: true }),
    ).rejects.toThrow("settle")
  })

  it("lets the owner keep theirs or take PCP's", async () => {
    const kept = await tokenOnV1()
    const taken = await tokenOnV1()

    await keepOwnInstructions(ctx, kept)
    await takeSuggestedInstructions(ctx, taken)

    expect(await getTokenInstructions(ctx, kept)).toMatchObject({
      text: V1.replace("Check", "Always check"),
      base: 2,
      outdated: false,
    })
    expect(await getTokenInstructions(ctx, taken)).toMatchObject({
      text: V2,
      base: 2,
      outdated: false,
    })
    expect(await outdatedInstructions(ctx)).toEqual([])
  })
})
