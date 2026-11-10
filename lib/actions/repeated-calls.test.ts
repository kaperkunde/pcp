import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  duplicateCallsOverview,
  readDuplicateCalls,
} from "@/lib/core/calls/config"
import type { VaultContext } from "@/lib/core/context"
import { db } from "@/lib/core/db"
import { createServer } from "@/lib/core/servers"
import { scratchDatabase } from "@/lib/core/test-db"
import { setupVault } from "@/lib/core/vault"

// Settings → Repeated calls: the owner's default and a tool's own time
// (or none) for the duplicate guard, through the session's own vault.

const signedIn = vi.hoisted(() => ({ ctx: null as unknown }))

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: () => {} }))
vi.mock("@/lib/server/session", () => ({
  requireContext: async () => signedIn.ctx,
}))

const {
  removeRepeatedCallsToolAction,
  saveRepeatedCallsDefaultAction,
  saveRepeatedCallsToolAction,
} = await import("./repeated-calls")

const IDLE = { status: "idle" } as const

let cleanup: () => Promise<void>
let ctx: VaultContext
let serverId: string

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  signedIn.ctx = ctx
  ;({ id: serverId } = await createServer(ctx, {
    name: "Postcards",
    url: "https://postcards.example.com/mcp",
    authType: "none",
  }))
  for (const [name, annotations] of [
    ["send_postcard", null],
    ["list_cards", { readOnlyHint: true }],
  ] as const) {
    await db().mcpTool.create({
      data: {
        id: `${name}-id`,
        serverId,
        name,
        inputSchema: JSON.stringify({ type: "object" }),
        ...(annotations ? { annotations: JSON.stringify(annotations) } : {}),
      },
    })
  }
})

afterEach(async () => {
  await cleanup()
})

function form(values: Record<string, string>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(values)) data.set(name, value)
  return data
}

describe("repeated calls on Settings", () => {
  it("saves the owner's default, and empty goes back to PCP's", async () => {
    expect(
      await saveRepeatedCallsDefaultAction(IDLE, form({ minutes: "90" })),
    ).toMatchObject({ status: "ok" })
    expect((await readDuplicateCalls(ctx)).defaultMinutes).toBe(90)
    expect(await duplicateCallsOverview(ctx)).toMatchObject({
      defaultMinutes: 90,
      ownDefault: true,
    })

    expect(
      await saveRepeatedCallsDefaultAction(IDLE, form({ minutes: "0" })),
    ).toMatchObject({
      status: "error",
      error: expect.stringMatching(/between/),
    })
    expect(
      await saveRepeatedCallsDefaultAction(IDLE, form({ minutes: "soon" })),
    ).toMatchObject({ status: "error" })

    await saveRepeatedCallsDefaultAction(IDLE, form({ minutes: "" }))
    expect(await readDuplicateCalls(ctx)).toEqual({ tools: {} })
  })

  it("gives a tool its own time or none, and takes it away", async () => {
    const tool = `${serverId}/send_postcard`

    // Only tools that change things are offered.
    expect(
      (await duplicateCallsOverview(ctx)).choices.map((entry) => entry.tool),
    ).toEqual(["send_postcard"])

    expect(
      await saveRepeatedCallsToolAction(
        IDLE,
        form({ tool, mode: "minutes", minutes: "5" }),
      ),
    ).toMatchObject({ status: "ok" })
    expect((await readDuplicateCalls(ctx)).tools).toEqual({
      [tool]: 5,
    })

    await saveRepeatedCallsToolAction(IDLE, form({ tool, mode: "never" }))
    expect((await duplicateCallsOverview(ctx)).tools).toMatchObject([
      { tool: "send_postcard", server: "Postcards", value: "exempt" },
    ])

    expect(
      await saveRepeatedCallsToolAction(
        IDLE,
        form({ tool: "nope/send", mode: "never" }),
      ),
    ).toMatchObject({ status: "error" })
    expect(
      await saveRepeatedCallsToolAction(
        IDLE,
        form({ tool: "", mode: "never" }),
      ),
    ).toMatchObject({ status: "error", error: "Choose a tool." })

    await removeRepeatedCallsToolAction(IDLE, form({ tool }))
    expect(await readDuplicateCalls(ctx)).toEqual({ tools: {} })
  })
})
