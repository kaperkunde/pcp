import type { CallToolResult } from "@modelcontextprotocol/server"
import { describe, expect, it } from "vitest"

import {
  decodeBase64Text,
  MAX_AUTO_TEXT_HANDLES,
  MAX_HANDLES_PER_ANSWER,
  pickFields,
  readFields,
  shapeAnswer,
  resultUri,
  shapeAnswerKeeping,
  type AnswerKeepers,
} from "./answers"
import type { KeptResult } from "./tool-results"

const invoices = {
  data: [
    { id: "a1", number: "0001", terms: "x".repeat(5000), lines: [{ cost: 1 }] },
    { id: "b2", number: "0002", terms: "y".repeat(5000), lines: [{ cost: 2 }] },
  ],
  meta: { pagination: { total: 2 } },
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

const texts = (result: CallToolResult) =>
  result.content.map((block) => (block.type === "text" ? block.text : ""))

describe("fields", () => {
  it("keeps only the paths asked for, looking into lists", () => {
    expect(
      pickFields(invoices, ["data.number", "data.lines.cost", "meta"]),
    ).toEqual({
      value: {
        data: [
          { number: "0001", lines: [{ cost: 1 }] },
          { number: "0002", lines: [{ cost: 2 }] },
        ],
        meta: { pagination: { total: 2 } },
      },
      missing: [],
    })
  })

  it("names the paths the answer does not have", () => {
    const shaped = shapeAnswer(json(invoices), {
      fields: ["data.numbr", "data.id", "meta.pagination.total.deep"],
    })

    expect(texts(shaped)).toEqual([
      "Not in the answer: data.numbr, meta.pagination.total.deep. Kept only the fields asked for that it has.",
      '{"data":[{"id":"a1"},{"id":"b2"}],"meta":{"pagination":{}}}',
    ])
  })

  it("is a list of dotted paths", () => {
    expect(readFields(undefined)).toBeUndefined()
    expect(readFields(["data.id"])).toEqual(["data.id"])
    expect(() => readFields([])).toThrow(/1 to 50/)
    expect(() => readFields(["data..id"])).toThrow(/joined by dots/)
    expect(() => readFields([3])).toThrow(/joined by dots/)
  })

  it("says so when the answer is not JSON", () => {
    const shaped = shapeAnswer(
      { content: [{ type: "text", text: "plain words" }] },
      { fields: ["data"] },
    )

    expect(texts(shaped)).toEqual([
      "fields was not applied: the answer is not JSON.",
      "plain words",
    ])
  })

  it("picks from structured content when the text is not the JSON", () => {
    const shaped = shapeAnswer(
      {
        content: [{ type: "text", text: "Found 2 invoices." }],
        structuredContent: invoices,
      },
      { fields: ["data.number"] },
    )

    expect(texts(shaped)).toEqual([
      "Found 2 invoices.",
      '{"data":[{"number":"0001"},{"number":"0002"}]}',
    ])
    expect(shaped.structuredContent).toBeUndefined()
  })
})

describe("decode", () => {
  const b64url = (text: string) => Buffer.from(text).toString("base64url")
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]).toString(
    "base64url",
  )
  // A Gmail message: parts nest, and a body is base64url.
  const message = {
    id: "m1",
    payload: {
      mimeType: "multipart/mixed",
      body: { size: 0 },
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              body: { data: b64url("Hi Ada,\r\n¿Qué tal? 👋") },
            },
            { mimeType: "text/html", body: { data: b64url("<p>Hi Ada</p>") } },
          ],
        },
        {
          mimeType: "image/png",
          body: { data: png },
        },
      ],
    },
  }

  it("decodes base64 and base64url text, and nothing else", () => {
    expect(decodeBase64Text(b64url("é?>>"))).toBe("é?>>")
    expect(decodeBase64Text(Buffer.from("é?>>").toString("base64"))).toBe(
      "é?>>",
    )
    // MIME wraps its base64 in lines.
    expect(decodeBase64Text("SGVs\r\nbG8=")).toBe("Hello")
    expect(decodeBase64Text("not base64!")).toBeNull()
    expect(decodeBase64Text("abcde")).toBeNull()
    // Bytes that are not UTF-8, and UTF-8 with control characters.
    expect(
      decodeBase64Text(Buffer.from([0xff, 0xfe]).toString("base64")),
    ).toBeNull()
    expect(
      decodeBase64Text(Buffer.from("a\u0000b").toString("base64")),
    ).toBeNull()
  })

  it("decodes text at every path that ends with one asked for, and says what it did", () => {
    const shaped = shapeAnswer(json(message), {
      decode: ["body.data", "snippet"],
    })
    const [decoded, left, missing, answer] = texts(shaped)

    expect(decoded).toBe("Decoded from base64: body.data (2).")
    expect(left).toMatch(
      /^Left as they were, not base64 text .*: body\.data \(1\)\.$/,
    )
    expect(missing).toBe("Nothing to decode at: snippet.")
    const parts = JSON.parse(answer!).payload.parts
    expect(
      parts[0].parts.map((part: { body: { data: string } }) => part.body.data),
    ).toEqual(["Hi Ada,\r\n¿Qué tal? 👋", "<p>Hi Ada</p>"])
    expect(parts[1].body.data).toBe(png)
    expect(shaped.structuredContent).toBeUndefined()
  })

  it("decodes only what fields kept", () => {
    const shaped = shapeAnswer(json(message), {
      fields: ["id", "payload.parts.parts.body"],
      decode: ["body.data"],
    })

    expect(texts(shaped)).toEqual([
      "Decoded from base64: body.data (2).",
      '{"id":"m1","payload":{"parts":[{"parts":[{"body":{"data":"Hi Ada,\\r\\n¿Qué tal? 👋"}},{"body":{"data":"<p>Hi Ada</p>"}}]},{}]}}',
    ])
  })

  it("says so when the answer is not JSON", () => {
    const shaped = shapeAnswer(
      { content: [{ type: "text", text: "plain words" }] },
      { fields: ["data"], decode: ["data"] },
    )

    expect(texts(shaped)[0]).toBe(
      "fields and decode were not applied: the answer is not JSON.",
    )
    expect(() => readFields(["a..b"], "decode")).toThrow(/Each of decode/)
  })
})

describe("long answers", () => {
  it("passes JSON on compact, once", () => {
    const shaped = shapeAnswer({
      ...json({ id: 1 }),
      structuredContent: { id: 1 },
    })

    expect(texts(shaped)).toEqual(['{"id":1}'])
    expect(shaped.structuredContent).toBeUndefined()

    // An API's list is { value } in structured content: still the same.
    expect(
      shapeAnswer({ ...json([1]), structuredContent: { value: [1] } })
        .structuredContent,
    ).toBeUndefined()
  })

  it("keeps structured content that says something the text does not", () => {
    const shaped = shapeAnswer({
      content: [{ type: "text", text: "Done." }],
      structuredContent: { id: 1 },
    })

    expect(shaped.structuredContent).toEqual({ id: 1 })
  })

  it("turns a JSON answer that is too long into a preview that is still JSON", () => {
    const many = {
      data: Array.from({ length: 50 }, (_, i) => ({
        id: `id${i}`,
        number: String(i).padStart(4, "0"),
        terms: "t".repeat(3000),
      })),
    }
    const [note, preview] = texts(shapeAnswer(json(many), { max: 10_000 }))

    expect(note).toMatch(/more than PCP passes on \(10,000\)/)
    expect(note).toContain('["data.id","data.number","data.terms"]')
    expect(JSON.parse(preview!)).toEqual({
      data: [
        {
          id: "id0",
          number: "0000",
          terms: `${"t".repeat(200)}… (3,000 characters)`,
        },
        "… 49 more",
      ],
    })
  })

  it("cuts deeper when the first item alone is too long", () => {
    const wide = {
      data: [
        Object.fromEntries(
          Array.from({ length: 400 }, (_, i) => [`k${i}`, "v".repeat(100)]),
        ),
      ],
    }
    const [note, preview] = texts(shapeAnswer(json(wide), { max: 10_000 }))

    expect(note!.length + preview!.length).toBeLessThanOrEqual(10_000)
    expect(() => JSON.parse(preview!)).not.toThrow()
  })

  it("cuts text that is not JSON, and errors, as before", () => {
    const long = "z".repeat(200)

    expect(
      texts(
        shapeAnswer(
          { content: [{ type: "text", text: long }], isError: true },
          { max: 100 },
        ),
      ),
    ).toEqual([`${"z".repeat(100)}\n… (truncated by PCP)`])
    expect(
      texts(
        shapeAnswer({ content: [{ type: "text", text: long }] }, { max: 100 }),
      ),
    ).toEqual([`${"z".repeat(100)}\n… (truncated by PCP)`])
  })
})

// Large values kept as results and shown as handles. The keeper is a fake
// that hands out ids r1, r2, … and records what it was given.

const UNTIL = new Date("2026-10-06T00:00:00Z")

function fakeKeepers() {
  const kept: Array<
    | { kind: "text"; text: string; mediaType: string }
    | { kind: "bytes"; bytes: Buffer; mediaType: string; name: string | null }
  > = []
  const result = (
    kind: KeptResult["kind"],
    mediaType: string,
    length: number,
    name: string | null = null,
  ): KeptResult => ({
    id: `r${kept.length}`,
    kind,
    mediaType,
    name,
    length,
    expiresAt: UNTIL,
    dropped: 0,
  })
  const keepers: AnswerKeepers = {
    text: async ({ text, mediaType }) => {
      const kept_ = result("text", mediaType, text.length)
      kept.push({ kind: "text", text, mediaType })
      return kept_
    },
    bytes: async ({ bytes, mediaType, name }) => {
      const kept_ = result("bytes", mediaType, bytes.length, name)
      kept.push({ kind: "bytes", bytes, mediaType, name })
      return kept_
    },
  }

  return { kept, keepers }
}

/** A PNG's header and enough bytes after it to be worth keeping. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(1_000, 7),
])

async function keeping(
  result: CallToolResult,
  shape: Parameters<typeof shapeAnswerKeeping>[1] = {},
  max?: number,
) {
  const fake = fakeKeepers()
  const shaped = await shapeAnswerKeeping(result, shape, fake.keepers, {
    ...(max ? { max } : {}),
    wholeMax: 4_000_000,
  })

  return { ...fake, ...shaped }
}

function lastJson(result: CallToolResult): unknown {
  return JSON.parse(texts(result).at(-1)!)
}

describe("keep", () => {
  it("keeps the parts asked for as handles, with a note naming them", async () => {
    const { kept, shown } = await keeping(json(invoices), {
      keep: ["data.terms"],
    })

    expect(kept.map((entry) => entry.kind)).toEqual(["text", "text"])
    expect(lastJson(shown)).toEqual({
      data: [
        {
          id: "a1",
          number: "0001",
          terms: {
            $result: "r0",
            type: "text/plain",
            length: 5000,
            preview: "x".repeat(200),
            readableUntil: UNTIL.toISOString(),
          },
          lines: [{ cost: 1 }],
        },
        expect.objectContaining({
          terms: expect.objectContaining({ $result: "r1" }),
        }),
      ],
      meta: { pagination: { total: 2 } },
    })
    expect(texts(shown)[0]).toMatch(
      /^PCP kept 2 values of this answer as results, each shown as \{"\$result": …\}: data\[0\]\.terms → r0 \(text\/plain, 5,000 characters\); data\[1\]\.terms → r1/,
    )
  })

  it("keeps a whole object or list at a path as JSON", async () => {
    const { kept, shown } = await keeping(json(invoices), { keep: ["data"] })

    expect(kept).toEqual([
      {
        kind: "text",
        text: JSON.stringify(invoices.data),
        mediaType: "application/json",
      },
    ])
    expect(lastJson(shown)).toMatchObject({
      data: { $result: "r0", type: "application/json" },
      meta: { pagination: { total: 2 } },
    })
  })

  it("keeps base64 at a path as the file it is", async () => {
    const { kept, shown } = await keeping(
      json({ filename: "dot.png", data: PNG.toString("base64url") }),
      { keep: ["data"] },
    )

    expect(kept[0]).toMatchObject({
      kind: "bytes",
      mediaType: "image/png",
      name: "dot.png",
    })
    expect((kept[0] as { bytes: Buffer }).bytes.equals(PNG)).toBe(true)
    expect(lastJson(shown)).toMatchObject({
      data: { $result: "r0", type: "image/png", size: PNG.length },
    })
  })

  it("keeps a short word at a path as text, not as bytes", async () => {
    const { kept } = await keeping(json({ code: "word" }), { keep: ["code"] })

    expect(kept).toEqual([
      { kind: "text", text: "word", mediaType: "text/plain" },
    ])
  })
})

describe("files on sight", () => {
  it("keeps base64 that is a file without being asked, typed by its first bytes", async () => {
    const { kept, shown } = await keeping(
      json({
        parts: [
          { mimeType: "image/png", body: { data: PNG.toString("base64") } },
        ],
      }),
    )

    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ kind: "bytes", mediaType: "image/png" })
    expect(JSON.stringify(shown)).not.toContain(
      PNG.toString("base64").slice(20, 60),
    )
  })

  it("takes the declared type beside base64 of a file it cannot name", async () => {
    const bytes = Buffer.alloc(1_200)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256
    const data = bytes.toString("base64")
    expect(data).toMatch(/[+/]/)

    const { kept } = await keeping(
      json({ attachment: { contentType: "application/x-thing", data } }),
    )

    expect(kept[0]).toMatchObject({
      kind: "bytes",
      mediaType: "application/x-thing",
    })
  })

  it("leaves text alone: base64 of text, hex digests, URL-safe ids and short base64", async () => {
    const value = {
      text: Buffer.from("plain words ".repeat(200)).toString("base64"),
      hex: "ab12".repeat(400),
      id: "Ab9_-".repeat(300),
      jwtish: `${"eyJhbGciOi".repeat(120)}.abc.def`,
      short: PNG.subarray(0, 300).toString("base64"),
    }
    const { kept, shown } = await keeping(json(value))

    expect(kept).toEqual([])
    expect(lastJson(shown)).toEqual(value)
  })
})

describe("an answer still too long", () => {
  it("keeps its longest texts first, until it fits", async () => {
    const value = {
      a: "a".repeat(30_000),
      b: "b".repeat(20_000),
      c: "c".repeat(3_000),
      d: "d".repeat(100),
    }
    const { kept, shown } = await keeping(json(value), {}, 15_000)

    expect(kept.map((entry) => (entry as { text: string }).text[0])).toEqual([
      "a",
      "b",
    ])
    expect(lastJson(shown)).toMatchObject({
      a: { $result: "r0" },
      b: { $result: "r1" },
      c: "c".repeat(3_000),
      d: "d".repeat(100),
    })
  })

  it("stops after a few, then previews as before", async () => {
    const value = {
      items: Array.from({ length: 40 }, (_, i) => `${i}`.padEnd(3_000, "x")),
    }
    const { kept, shown } = await keeping(json(value), {}, 20_000)

    expect(kept).toHaveLength(MAX_AUTO_TEXT_HANDLES)
    expect(texts(shown).join("\n")).toMatch(/so this is a preview/)
  })

  it("keeps the same handles in what is shown and in the whole", async () => {
    const { shown, whole } = await keeping(json({ a: "a".repeat(70_000) }))
    const fullText = texts(whole()).join("\n")

    expect(texts(shown).join("\n")).toContain('"$result":"r0"')
    expect(fullText).toContain('"$result":"r0"')
    expect(fullText).not.toContain("a".repeat(5_000))
  })

  it("never makes more handles than its cap, and says so", async () => {
    const value = Object.fromEntries(
      Array.from({ length: MAX_HANDLES_PER_ANSWER + 5 }, (_, i) => [
        `f${i}`,
        PNG.toString("base64"),
      ]),
    )
    const { kept, shown } = await keeping(json(value))

    expect(kept).toHaveLength(MAX_HANDLES_PER_ANSWER)
    expect(texts(shown)[0]).toMatch(
      new RegExp(`at most ${MAX_HANDLES_PER_ANSWER} per answer`),
    )
  })
})

describe("files in other blocks", () => {
  it("replaces an image too large to pass on with its handle, and keeps a small one beside a note", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(60_000, 1)])
    const { kept, shown } = await keeping({
      content: [
        { type: "image", data: big.toString("base64"), mimeType: "image/png" },
        { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
      ],
    })

    expect(kept.map((entry) => entry.kind)).toEqual(["bytes", "bytes"])
    expect(shown.content.map((block) => block.type)).toEqual([
      "text",
      "image",
      "text",
    ])
    expect(texts(shown)[0]).toMatch(
      /^PCP kept this image as a result, too large to pass on here: \{"\$result":"r0"/,
    )
    expect(texts(shown)[2]).toMatch(/a result too, to hand to another tool/)
  })

  it("keeps an embedded file under the last part of its address", async () => {
    const { kept } = await keeping({
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///reports/q3.pdf",
            mimeType: "application/pdf",
            blob: Buffer.from("%PDF-1.7 ...").toString("base64"),
          },
        },
      ],
    })

    expect(kept[0]).toMatchObject({
      kind: "bytes",
      mediaType: "application/pdf",
      name: "q3.pdf",
    })
  })
})

describe("what keeping leaves as it was", () => {
  it("does nothing to an error, or to an answer with nothing large", async () => {
    const error = await keeping({
      content: [
        {
          type: "text",
          text: JSON.stringify({ data: PNG.toString("base64") }),
        },
      ],
      isError: true,
    })
    const small = await keeping(json({ a: 1 }))

    expect(error.kept).toEqual([])
    expect(small.kept).toEqual([])
    expect(texts(small.shown)).toEqual(['{"a":1}'])
  })

  it("drops structuredContent once handles changed the text", async () => {
    const value = { data: PNG.toString("base64") }
    const { shown } = await keeping({
      ...json(value),
      structuredContent: value,
    })

    expect(shown.structuredContent).toBeUndefined()
  })

  it("keeps from structuredContent when that is where the JSON is", async () => {
    const { kept, shown } = await keeping(
      {
        content: [{ type: "text", text: "Here you go." }],
        structuredContent: { report: "r".repeat(100) },
      },
      { keep: ["report"] },
    )

    expect(kept).toHaveLength(1)
    expect(texts(shown).at(-1)).toContain('"$result":"r0"')
  })

  it("says keep was not applied to an answer that is not JSON", async () => {
    const { kept, shown } = await keeping(
      { content: [{ type: "text", text: "just words" }] },
      { keep: ["a"] },
    )

    expect(kept).toEqual([])
    expect(texts(shown)[0]).toBe(
      "keep was not applied: the answer is not JSON.",
    )
  })
})

describe("resource links", () => {
  it("links each handle once, those it made and those already in the answer", async () => {
    const mailHandle = {
      $result: "mail-1",
      type: "text/csv; charset=utf-8",
      size: 18,
      name: "parts.csv",
      readableUntil: UNTIL.toISOString(),
    }
    const fake = fakeKeepers()
    const { shown } = await shapeAnswerKeeping(
      json({
        attachment: mailHandle,
        again: mailHandle,
        filename: "dot.png",
        data: PNG.toString("base64"),
      }),
      {},
      fake.keepers,
      { wholeMax: 4_000_000, links: true },
    )
    const links = shown.content.filter(
      (block) => block.type === "resource_link",
    )

    expect(links).toEqual([
      expect.objectContaining({
        uri: resultUri("r0"),
        name: "dot.png",
        mimeType: "image/png",
      }),
      expect.objectContaining({
        uri: "pcp://results/mail-1",
        name: "parts.csv",
        mimeType: "text/csv; charset=utf-8",
      }),
    ])
    expect(fake.kept).toHaveLength(1)
  })

  it("adds none unless asked, and none for an answer without handles", async () => {
    const plain = await keeping(json({ data: PNG.toString("base64") }))
    const fake = fakeKeepers()
    const small = await shapeAnswerKeeping(json({ a: 1 }), {}, fake.keepers, {
      wholeMax: 4_000_000,
      links: true,
    })

    expect(plain.shown.content.some((b) => b.type === "resource_link")).toBe(
      false,
    )
    expect(small.shown.content.map((b) => b.type)).toEqual(["text"])
  })
})
