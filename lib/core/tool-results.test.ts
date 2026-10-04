import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import {
  keepResult,
  MAX_KEPT_RESULT_CHARS,
  MAX_KEPT_RESULTS_PER_TOKEN,
  pageResult,
  pruneToolResults,
  readResult,
  RESULT_FIRST_PAGE_CHARS,
  RESULT_PAGE_CHARS,
  RESULT_TTL_MS,
  resultKeeper,
  resultNotices,
} from "./tool-results"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// Long answers kept for the token that asked, read back a slice at a time.

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

function keep(text: string, now?: Date) {
  return keepResult(
    ctx,
    {
      tokenId,
      serverId: null,
      toolName: "long",
      text,
      mediaType: "text/plain",
    },
    now,
  )
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
}

describe("keeping and reading", () => {
  it("reads back exactly what was kept, a slice at a time", async () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i}\n`).join("")
    const kept = await keep(text)

    expect(kept).toMatchObject({ length: text.length, dropped: 0 })

    let offset = 0
    let whole = ""

    while (offset < text.length) {
      const slice = await readResult(ctx, {
        tokenId,
        id: kept.id,
        offset,
        length: 7000,
      })
      expect(slice.total).toBe(text.length)
      whole += slice.text
      offset += slice.text.length
    }

    expect(whole).toBe(text)
  })

  it("keeps the text encrypted", async () => {
    const kept = await keep("a very particular sentence")
    const row = await db().toolResult.findUniqueOrThrow({
      where: { id: kept.id },
    })

    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain(
      "particular",
    )
  })

  it("starts at the text it is asked to find", async () => {
    const kept = await keep(`${"x".repeat(1000)}MARKER${"y".repeat(10)}`)

    const found = await readResult(ctx, {
      tokenId,
      id: kept.id,
      find: "MARKER",
      length: 8,
    })
    expect(found).toMatchObject({
      foundAt: 1000,
      offset: 1000,
      text: "MARKERyy",
    })

    const missing = await readResult(ctx, {
      tokenId,
      id: kept.id,
      offset: 1001,
      find: "MARKER",
    })
    expect(missing).toMatchObject({ foundAt: null, text: "" })
  })

  it("answers past the end with nothing, and never more than a page", async () => {
    const kept = await keep("y".repeat(RESULT_PAGE_CHARS + 10))

    expect(
      (await readResult(ctx, { tokenId, id: kept.id, offset: 10 ** 9 })).text,
    ).toBe("")
    expect(
      (await readResult(ctx, { tokenId, id: kept.id, length: 10 ** 9 })).text,
    ).toHaveLength(RESULT_PAGE_CHARS)
  })

  it("never splits a character in two", async () => {
    const kept = await keep(`a${"😀".repeat(10)}`)
    const slice = await readResult(ctx, { tokenId, id: kept.id, length: 2 })

    expect(slice.text).toBe("a")
  })

  it("is for the token that asked, in its vault, for a day", async () => {
    const now = new Date("2026-10-04T12:00:00Z")
    const kept = await keep("only mine", now)
    const { id: otherToken } = await createApiToken(ctx, {
      name: "Other",
      allowAllServers: true,
      serverIds: [],
    })

    await expect(
      readResult(ctx, { tokenId: otherToken, id: kept.id }, now),
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(
      readResult({ ...ctx, vaultId: "another" }, { tokenId, id: kept.id }, now),
    ).rejects.toMatchObject({ code: "not_found" })

    const later = new Date(now.getTime() + RESULT_TTL_MS + 1)
    await expect(
      readResult(ctx, { tokenId, id: kept.id }, later),
    ).rejects.toMatchObject({ code: "not_found" })
    expect(await pruneToolResults(later)).toBe(1)
  })

  it("keeps at most so much of one answer, and says what was dropped", async () => {
    const kept = await keep("z".repeat(MAX_KEPT_RESULT_CHARS + 5))

    expect(kept).toMatchObject({ length: MAX_KEPT_RESULT_CHARS, dropped: 5 })
  })

  it("lets go of a token's oldest results past its limit", async () => {
    const start = Date.parse("2026-10-04T12:00:00Z")
    const first = await keep("first", new Date(start))

    for (let i = 1; i <= MAX_KEPT_RESULTS_PER_TOKEN; i++) {
      await keep(`result ${i}`, new Date(start + i * 1000))
    }

    expect(await db().toolResult.count({ where: { tokenId } })).toBe(
      MAX_KEPT_RESULTS_PER_TOKEN,
    )
    expect(
      await db().toolResult.findUnique({ where: { id: first.id } }),
    ).toBeNull()
  })
})

describe("pageResult", () => {
  const context = { serverId: null, toolName: "long" }

  it("leaves an answer that fits alone", async () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: "short" }],
      structuredContent: { ok: true },
    }

    expect(
      await pageResult(result, resultKeeper(ctx, tokenId), context),
    ).toEqual(result)
    expect(await db().toolResult.count()).toBe(0)
  })

  it("hands over the first page and a notice, and keeps the whole text", async () => {
    const text = `${"a".repeat(RESULT_PAGE_CHARS)}THE END`
    const paged = await pageResult(
      { content: [{ type: "text", text }], isError: true },
      resultKeeper(ctx, tokenId),
      context,
    )
    const shown = textOf(paged)

    expect(paged.isError).toBe(true)
    expect(shown.startsWith("a".repeat(RESULT_FIRST_PAGE_CHARS))).toBe(true)
    expect(shown).not.toContain("THE END")

    const [notice] = resultNotices([shown])
    expect(notice).toContain(
      `${text.length.toLocaleString("en-US")} characters`,
    )
    const id = /as result ([0-9a-f-]+),/.exec(notice!)![1]!
    const rest = await readResult(ctx, {
      tokenId,
      id,
      offset: RESULT_FIRST_PAGE_CHARS,
    })
    expect(rest.text.endsWith("THE END")).toBe(true)
    expect(rest.mediaType).toBe("text/plain")
  })

  it("leaves out structured content too long for a page, keeping it when no text was", async () => {
    const big = { items: Array.from({ length: 20_000 }, (_, i) => ({ i })) }
    const paged = await pageResult(
      {
        content: [{ type: "text", text: "see the data" }],
        structuredContent: big,
      },
      resultKeeper(ctx, tokenId),
      context,
    )

    expect(paged.structuredContent).toBeUndefined()
    expect(textOf(paged)).toContain("see the data")
    const [kept] = await db().toolResult.findMany()
    expect(kept!.mediaType).toBe("application/json")
  })
})
