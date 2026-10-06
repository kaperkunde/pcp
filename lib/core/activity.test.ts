import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { activityLog, readActivityQuery } from "./activity"
import { createApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { logDir } from "./data-dir"
import { db } from "./db"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// The Log page's lines: the request log's, with names and answers filled in.

let cleanup: () => Promise<void>
let ctx: VaultContext
let tokenId: string

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  ;({ id: tokenId } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    serverIds: [],
  }))
})

afterEach(async () => {
  await cleanup()
})

function writeLog(lines: object[]): void {
  mkdirSync(logDir(), { recursive: true })
  writeFileSync(
    path.join(logDir(), "mcp-2026-10-06.jsonl"),
    lines
      .map((line) =>
        JSON.stringify({
          ts: "2026-10-06T10:00:00.000Z",
          vaultId: ctx.vaultId,
          tokenId,
          tool: "call_tool",
          ok: true,
          ms: 1,
          ...line,
        }),
      )
      .map((line) => `${line}\n`)
      .join(""),
  )
}

async function request(id: string, status: string, expiresAt: Date) {
  await db().permissionRequest.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      tokenId,
      kind: "call",
      toolName: "send",
      argsCiphertext: new Uint8Array([1]),
      argsHash: id,
      status,
      expiresAt,
    },
  })
}

describe("activityLog", () => {
  it("names each token, and says a deleted one is gone", async () => {
    writeLog([{ tool: "search_tools" }, { tokenId: "gone", tool: "memory" }])

    const { entries, tokens } = await activityLog(ctx, {})

    expect(entries.map((entry) => [entry.tool, entry.tokenName])).toEqual([
      ["memory", null],
      ["search_tools", "Claude"],
    ])
    expect(tokens).toEqual([{ id: tokenId, name: "Claude", revoked: false }])
  })

  it("says how a request a call made was answered, while PCP keeps it", async () => {
    const later = new Date(Date.now() + 60_000)
    const earlier = new Date(Date.now() - 60_000)
    await request("r-waiting", "pending", later)
    await request("r-expired", "pending", earlier)
    await request("r-ran", "executed", earlier)
    await request("r-no", "declined", later)
    writeLog([
      { asked: true, request: "r-waiting" },
      { asked: true, request: "r-expired" },
      { asked: true, request: "r-ran" },
      { asked: true, request: "r-no" },
      { asked: true, request: "r-pruned" },
      { asked: true },
    ])

    const { entries } = await activityLog(ctx, {})

    expect(entries.map((entry) => entry.requestState).reverse()).toEqual([
      "waiting",
      "expired",
      "allowed",
      "declined",
      null,
      null,
    ])
  })
})

describe("readActivityQuery", () => {
  it("keeps the address to what the log takes", () => {
    expect(
      readActivityQuery({
        token: "t1",
        outcome: "asked",
        q: `  ${"x".repeat(200)}  `,
        before: "2026-10-01:4",
      }),
    ).toEqual({
      tokenId: "t1",
      outcome: "asked",
      text: "x".repeat(80),
      cursor: "2026-10-01:4",
    })
    expect(
      readActivityQuery({ outcome: "everything", token: ["a", "b"] }),
    ).toEqual({
      tokenId: undefined,
      outcome: undefined,
      text: undefined,
      cursor: undefined,
    })
  })
})
