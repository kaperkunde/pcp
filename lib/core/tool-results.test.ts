import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { shapeAnswer } from "./answers"
import { createApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import {
  describeResults,
  handleOf,
  keepBytes,
  keepResult,
  MAX_KEPT_RESULT_BYTES,
  MAX_KEPT_RESULT_CHARS,
  MAX_KEPT_RESULTS_PER_TOKEN,
  keepWholeAnswer,
  openResult,
  pruneToolResults,
  readResult,
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

describe("keepWholeAnswer", () => {
  const context = { serverId: null, toolName: "long" }

  async function shown(raw: CallToolResult, fields?: string[]) {
    return keepWholeAnswer(
      {
        raw,
        shown: shapeAnswer(raw, { fields }),
        whole: () => shapeAnswer(raw, { fields, max: MAX_KEPT_RESULT_CHARS }),
      },
      resultKeeper(ctx, tokenId),
      context,
    )
  }

  it("leaves an answer that fits alone, and keeps nothing", async () => {
    const raw: CallToolResult = { content: [{ type: "text", text: "short" }] }

    expect(await shown(raw)).toEqual(shapeAnswer(raw))
    expect(await db().toolResult.count()).toBe(0)
  })

  it("keeps a long text whole behind the cut, and says where", async () => {
    const text = `${"a".repeat(RESULT_PAGE_CHARS)}THE END`
    const answer = await shown({
      content: [{ type: "text", text }],
      isError: true,
    })
    const visible = textOf(answer)

    expect(answer.isError).toBe(true)
    expect(visible).toContain("truncated by PCP")
    expect(visible).not.toContain("THE END")

    const [notice] = resultNotices([visible])
    expect(notice).toContain(
      `${text.length.toLocaleString("en-US")} characters`,
    )
    const id = /as result ([0-9a-f-]+),/.exec(notice!)![1]!
    const rest = await readResult(ctx, { tokenId, id, find: "THE END" })
    expect(rest.text).toBe("THE END")
    expect(rest.mediaType).toBe("text/plain")
  })

  it("keeps a long JSON answer whole beside its preview", async () => {
    const items = Array.from({ length: 5_000 }, (_, i) => ({
      id: i,
      note: "x".repeat(20),
    }))
    const raw: CallToolResult = {
      content: [{ type: "text", text: JSON.stringify({ items }) }],
    }
    const answer = await shown(raw)
    const [kept] = await db().toolResult.findMany()

    expect(textOf(answer)).toContain("so this is a preview")
    expect(textOf(answer)).toContain(`as result ${kept!.id}`)
    expect(kept!.mediaType).toBe("application/json")
    const whole = await readResult(ctx, {
      tokenId,
      id: kept!.id,
      find: '"id":4999',
      length: 9,
    })
    expect(whole.text).toBe('"id":4999')
  })

  it("keeps nothing when the fields asked for already fit", async () => {
    const items = Array.from({ length: 3_000 }, (_, i) => ({
      id: i,
      note: "x".repeat(40),
    }))
    const answer = await shown(
      { content: [{ type: "text", text: JSON.stringify({ items }) }] },
      ["items.id"],
    )

    expect(textOf(answer)).not.toContain("PCP kept the whole answer")
    expect(await db().toolResult.count()).toBe(0)
  })
})

// Files: bytes kept for the token, opened for use, described without content.

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3,
])

function keepFile(
  bytes: Buffer,
  mediaType: string,
  name: string | null = "file",
  now?: Date,
) {
  return keepBytes(
    ctx,
    {
      tokenId,
      serverId: null,
      toolName: "get_attachment",
      bytes,
      mediaType,
      name,
    },
    now,
  )
}

describe("keeping a file", () => {
  it("keeps the bytes, their size, name and type, encrypted", async () => {
    const kept = await keepFile(PNG, "image/png", "dot.png")

    expect(kept).toMatchObject({
      kind: "bytes",
      mediaType: "image/png",
      name: "dot.png",
      length: PNG.length,
      dropped: 0,
    })

    const row = await db().toolResult.findFirstOrThrow({
      where: { id: kept.id },
    })

    expect(row).toMatchObject({ kind: "bytes", name: "dot.png" })
    expect(Buffer.from(row.ciphertext).includes(PNG)).toBe(false)

    const opened = await openResult(ctx, { tokenId, id: kept.id })

    expect(opened?.bytes().equals(PNG)).toBe(true)
  })

  it("refuses a file over the cap instead of cutting it", async () => {
    await expect(
      keepFile(Buffer.alloc(MAX_KEPT_RESULT_BYTES + 1), "application/pdf"),
    ).rejects.toThrow(/more than PCP keeps/)
  })

  it("cleans a name of paths and control characters, and drops an empty one", async () => {
    const kept = await keepFile(PNG, "image/png", "../a/b\nc.png\u0000")

    expect(kept.name).toBe("b c.png")
    expect((await keepFile(PNG, "image/png", "  ")).name).toBeNull()
  })

  it("counts bytes with characters against the token's caps", async () => {
    const big = Buffer.alloc(9_000_000, 1)
    const kept = []

    for (let n = 0; n < 6; n++) {
      kept.push(await keepFile(big, "application/octet-stream", `f${n}`))
    }

    // 6 x 9 MB passes the 50 M cap: the oldest goes, the newest stays.
    expect(await openResult(ctx, { tokenId, id: kept[0]!.id })).toBeNull()
    expect(await openResult(ctx, { tokenId, id: kept[5]!.id })).not.toBeNull()
  })
})

describe("opening a result", () => {
  it("gives a text as UTF-8 bytes, and a text file as its text in its charset", async () => {
    const kept = await keep("héllo")
    const opened = await openResult(ctx, { tokenId, id: kept.id })

    expect(opened?.text()).toBe("héllo")
    expect(opened?.bytes().toString("utf8")).toBe("héllo")

    const latin = await keepFile(
      Buffer.from([0x63, 0x61, 0x66, 0xe9]),
      "text/csv; charset=iso-8859-1",
    )

    expect((await openResult(ctx, { tokenId, id: latin.id }))?.text()).toBe(
      "café",
    )
  })

  it("refuses the text of a binary file, naming it", async () => {
    const kept = await keepFile(PNG, "image/png")
    const opened = await openResult(ctx, { tokenId, id: kept.id })

    expect(() => opened?.text()).toThrow(
      new RegExp(`Result ${kept.id} is image/png, not text`),
    )
  })

  it("is null for another token, another vault, an expired result and an unknown id", async () => {
    const kept = await keepFile(PNG, "image/png")
    const { id: other } = await createApiToken(ctx, {
      name: "Other",
      allowAllServers: true,
      serverIds: [],
    })

    expect(await openResult(ctx, { tokenId: other, id: kept.id })).toBeNull()
    expect(
      await openResult(
        { ...ctx, vaultId: "another" },
        { tokenId, id: kept.id },
      ),
    ).toBeNull()
    expect(
      await openResult(
        ctx,
        { tokenId, id: kept.id },
        new Date(Date.now() + RESULT_TTL_MS + 1000),
      ),
    ).toBeNull()
    expect(await openResult(ctx, { tokenId, id: "nope" })).toBeNull()
  })
})

describe("reading a file", () => {
  it("pages a text file as decoded text", async () => {
    const kept = await keepFile(
      Buffer.from("a,b\n1,é\n", "utf8"),
      "text/csv; charset=utf-8",
      "t.csv",
    )
    const slice = await readResult(ctx, { tokenId, id: kept.id, length: 4 })

    expect(slice).toMatchObject({
      kind: "bytes",
      name: "t.csv",
      binary: false,
      total: 8,
      text: "a,b\n",
    })
  })

  it("describes a binary file and shows none of it", async () => {
    const kept = await keepFile(PNG, "image/png", "dot.png")
    const slice = await readResult(ctx, { tokenId, id: kept.id })

    expect(slice).toMatchObject({
      binary: true,
      text: "",
      total: PNG.length,
      name: "dot.png",
      mediaType: "image/png",
    })
  })
})

describe("handles and descriptions", () => {
  it("names a text by its length and a file by its size", async () => {
    const text = await keep("hello")
    const file = await keepFile(PNG, "image/png", "dot.png")

    expect(handleOf(text, "hel")).toEqual({
      $result: text.id,
      type: "text/plain",
      length: 5,
      preview: "hel",
      readableUntil: text.expiresAt.toISOString(),
    })
    expect(handleOf(file)).toEqual({
      $result: file.id,
      type: "image/png",
      size: PNG.length,
      name: "dot.png",
      readableUntil: file.expiresAt.toISOString(),
    })
  })

  it("describes each id for the token without its content", async () => {
    const file = await keepFile(PNG, "image/png", "dot.png")
    const described = await describeResults(ctx, tokenId, ["missing", file.id])

    expect(described[0]).toEqual({ id: "missing", found: false })
    expect(described[1]).toMatchObject({
      id: file.id,
      found: true,
      kind: "bytes",
      name: "dot.png",
      length: PNG.length,
      toolName: "get_attachment",
    })
    expect(JSON.stringify(described)).not.toContain("ciphertext")
    expect(await describeResults(ctx, tokenId, [])).toEqual([])
  })
})
