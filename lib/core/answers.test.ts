import type { CallToolResult } from "@modelcontextprotocol/server"
import { describe, expect, it } from "vitest"

import {
  answerValue,
  decodeBase64Text,
  MAX_ANSWER_CHARS,
  MAX_ANSWER_IMAGE_CHARS,
  MAX_AUTO_TEXT_HANDLES,
  MAX_HANDLES_PER_ANSWER,
  pickFields,
  readFields,
  resourceFileName,
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

    // A list, as it is or as an older SDK wraps it: still the same.
    expect(
      shapeAnswer({ ...json([1]), structuredContent: [1] as never })
        .structuredContent,
    ).toBeUndefined()
    expect(
      shapeAnswer({ ...json([1]), structuredContent: { result: [1] } })
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
  /** The ids kept as pass-only: parts keep named. */
  const passOnly: string[] = []
  const keepers: AnswerKeepers = {
    text: async ({ text, mediaType, passOnly: only }) => {
      const kept_ = result("text", mediaType, text.length)
      if (only) passOnly.push(kept_.id)
      kept.push({ kind: "text", text, mediaType })
      return kept_
    },
    bytes: async ({ bytes, mediaType, name, passOnly: only }) => {
      const kept_ = result("bytes", mediaType, bytes.length, name)
      if (only) passOnly.push(kept_.id)
      kept.push({ kind: "bytes", bytes, mediaType, name })
      return kept_
    },
  }

  return { kept, keepers, passOnly }
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

  it("never shows a kept part's value: no preview, only its type and length (#149)", async () => {
    const secret = "tok_live_9f8e7d6c5b4a39281706"
    const answer = {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ token: secret, expires_at: "soon" }),
        },
      ],
      structuredContent: { token: secret, expires_at: "soon" },
    }
    const { shown, whole } = await keeping(answer, { keep: ["token"] })

    for (const result of [shown, whole()]) {
      expect(JSON.stringify(result)).not.toContain(secret.slice(0, 6))
      expect(JSON.stringify(result)).not.toContain("preview")
    }
    expect(lastJson(shown)).toEqual({
      token: {
        $result: "r0",
        type: "text/plain",
        length: secret.length,
        readableUntil: UNTIL.toISOString(),
      },
      expires_at: "soon",
    })
  })

  it("keeps a whole object at a path without a preview of it (#149)", async () => {
    const { shown } = await keeping(
      json({ credentials: { password: "hunter2-and-more" } }),
      { keep: ["credentials"] },
    )

    expect(JSON.stringify(shown)).not.toContain("hunter2")
    expect(JSON.stringify(shown)).not.toContain("preview")
  })

  it("keeps a part fields leaves out, rather than dropping it (#149)", async () => {
    const { kept, shown } = await keeping(
      json({ token: "tok_123456", expires_at: "soon", other: 1 }),
      { fields: ["expires_at"], keep: ["token"] },
    )

    expect(kept).toEqual([
      { kind: "text", text: "tok_123456", mediaType: "text/plain" },
    ])
    expect(lastJson(shown)).toEqual({
      expires_at: "soon",
      token: expect.objectContaining({ $result: "r0" }),
    })
    expect(texts(shown).join("\n")).not.toContain("Not in the answer")
  })

  it("says so when a part to keep is not in the answer", async () => {
    const { kept, shown } = await keeping(json({ expires_at: "soon" }), {
      keep: ["token"],
    })

    expect(kept).toEqual([])
    expect(texts(shown).join("\n")).toContain(
      "Nothing to keep at token: the answer has no such part.",
    )
  })

  it("leaves out, never shows, a part to keep that PCP could not keep (#149)", async () => {
    const value = {
      items: Array.from({ length: MAX_HANDLES_PER_ANSWER + 3 }, (_, i) => ({
        token: `secret-value-${i}`,
      })),
    }
    const { kept, shown } = await keeping(json(value), {
      keep: ["items.token"],
    })

    expect(kept).toHaveLength(MAX_HANDLES_PER_ANSWER)
    const text = texts(shown).join("\n")
    expect(text).not.toContain(`secret-value-${MAX_HANDLES_PER_ANSWER}`)
    expect(text).toContain("left out")
  })

  it("hands a program a handle with no preview for a part to keep (#149)", async () => {
    const fake = fakeKeepers()
    const outcome = await answerValue(
      json({ token: "tok_live_abcdef", n: 1 }),
      { keep: ["token"] },
      fake.keepers,
      { max: 100_000 },
    )

    expect(outcome).toEqual({
      ok: true,
      value: {
        token: {
          $result: "r0",
          type: "text/plain",
          length: 15,
          readableUntil: UNTIL.toISOString(),
        },
        n: 1,
      },
    })
  })

  it("keeps the whole of an answer that is not JSON when keep is asked (review 1)", async () => {
    const answer: CallToolResult = {
      content: [{ type: "text", text: "Your token: tok_plain_123456" }],
    }
    const { kept, shown, whole } = await keeping(answer, { keep: ["token"] })

    expect(kept).toEqual([
      {
        kind: "text",
        text: "Your token: tok_plain_123456",
        mediaType: "text/plain",
      },
    ])
    for (const result of [shown, whole()]) {
      expect(JSON.stringify(result)).not.toContain("tok_plain")
      expect(JSON.stringify(result)).not.toContain("preview")
    }
    expect(texts(shown).join("\n")).toContain("(the answer) → r0")
    expect(texts(shown).join("\n")).toContain("not JSON")

    const fake = fakeKeepers()
    const outcome = await answerValue(
      answer,
      { keep: ["token"] },
      fake.keepers,
      {
        max: 100_000,
      },
    )
    expect(JSON.stringify(outcome)).not.toContain("tok_plain")
    expect(outcome).toMatchObject({
      ok: true,
      value: { $result: "r0", type: "text/plain" },
      notes: [expect.stringContaining("not JSON")],
    })
  })

  it("keeps a part at any depth that fields leaves out (review 2)", async () => {
    const { kept, shown } = await keeping(
      json({ data: { token: "tok_nested_1", expires_at: "soon", n: 1 } }),
      { fields: ["data.expires_at"], keep: ["token"] },
    )

    expect(kept).toEqual([
      { kind: "text", text: "tok_nested_1", mediaType: "text/plain" },
    ])
    expect(lastJson(shown)).toEqual({
      data: {
        expires_at: "soon",
        token: expect.objectContaining({ $result: "r0" }),
      },
    })
    expect(texts(shown).join("\n")).not.toContain("Nothing to keep")
  })

  it("refuses a keep path with a list index (review 3)", () => {
    expect(() => readFields(["items[0].token"], "keep")).toThrow(/any depth/)
    expect(readFields(["items.token"], "keep")).toEqual(["items.token"])
  })

  it("links no resource for a part to keep, and says it is for passing on (review 4)", async () => {
    const fake = fakeKeepers()
    const { shown } = await shapeAnswerKeeping(
      json({ token: "tok_link_1", file: PNG.toString("base64") }),
      { keep: ["token"] },
      fake.keepers,
      { wholeMax: 4_000_000, links: true },
    )
    const links = shown.content.filter(
      (block) => block.type === "resource_link",
    )

    expect(links).toHaveLength(1)
    expect(JSON.stringify(links)).not.toContain('"r0"')
    expect(texts(shown)[0]).toMatch(/token → r0[^;]*; file → r1/)
    expect(texts(shown).join("\n")).toMatch(
      /token: pass (it|them) on as (it is|they are); do not read/i,
    )
  })

  it("withholds what keep names in an error's JSON (review 5)", async () => {
    for (const text of [
      JSON.stringify({ message: "already made", token: "tok_err_1" }),
      `HTTP 422 Unprocessable\n${JSON.stringify({ token: "tok_err_1" })}`,
    ]) {
      const error: CallToolResult = {
        content: [{ type: "text", text }],
        isError: true,
      }
      const { shown } = await keeping(error, { keep: ["token"] })
      expect(JSON.stringify(shown)).not.toContain("tok_err_1")
      expect(JSON.stringify(shown)).toContain("[left out")

      const outcome = await answerValue(
        error,
        { keep: ["token"] },
        fakeKeepers().keepers,
        { max: 100_000 },
      )
      expect(JSON.stringify(outcome)).not.toContain("tok_err_1")
    }
  })

  it("withholds a part to keep nested deeper than PCP looks (review 8)", async () => {
    let deep: Record<string, unknown> = { token: "tok_deep_1" }
    for (let i = 0; i < 70; i++) deep = { d: deep }
    const { shown } = await keeping(json(deep), { keep: ["token"] })

    expect(JSON.stringify(shown)).not.toContain("tok_deep_1")
  })

  it("tells a program what keep could not do (review 8)", async () => {
    const outcome = await answerValue(
      json({ expires_at: "soon" }),
      { keep: ["token"] },
      fakeKeepers().keepers,
      { max: 100_000 },
    )

    expect(outcome).toMatchObject({
      ok: true,
      notes: ["Nothing to keep at token: the answer has no such part."],
    })
  })

  it("keeps an embedded text resource whole when the answer has no JSON (final 1, 2)", async () => {
    const { kept, shown } = await keeping(
      {
        content: [
          {
            type: "resource",
            resource: {
              uri: "file:///token.txt",
              mimeType: "text/plain",
              text: "tok_resource_998877",
            },
          },
        ],
      },
      { keep: ["token"] },
    )

    expect(kept).toEqual([
      { kind: "text", text: "tok_resource_998877", mediaType: "text/plain" },
    ])
    const said = texts(shown).join("\n")
    expect(JSON.stringify(shown)).not.toContain("tok_resource")
    expect(said).not.toContain("((the answer))")
    expect(said).not.toContain("keep was not applied")
  })

  it("marks what keep named pass-only, and nothing kept on sight (final 3)", async () => {
    const fake = fakeKeepers()
    await shapeAnswerKeeping(
      json({ token: "tok_only_1", file: PNG.toString("base64") }),
      { keep: ["token"] },
      fake.keepers,
      { wholeMax: 4_000_000 },
    )
    expect(fake.passOnly).toEqual(["r0"])

    const whole = fakeKeepers()
    await answerValue(
      { content: [{ type: "text", text: "tok_only_2" }] },
      { keep: ["token"] },
      whole.keepers,
      { max: 100_000 },
    )
    expect(whole.passOnly).toEqual(["r0"])
  })

  it("puts a kept value out of sight in the text beside the JSON (final 4)", async () => {
    const { shown } = await keeping(
      {
        content: [
          { type: "text", text: "Created tok_beside_445566 for you." },
          {
            type: "text",
            text: JSON.stringify({ token: "tok_beside_445566", n: 1 }),
          },
          { type: "text", text: "short: 1" },
        ],
      },
      { keep: ["token"] },
    )

    const said = texts(shown).join("\n")
    expect(said).not.toContain("tok_beside")
    expect(said).toContain("Created [kept: token] for you.")
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
  it("passes an image on up to its own budget, not the text's: a screenshot larger than MAX_ANSWER_CHARS still shows", async () => {
    const screenshot = Buffer.concat([PNG, Buffer.alloc(48_000, 1)])
    expect(screenshot.toString("base64").length).toBeGreaterThan(
      MAX_ANSWER_CHARS,
    )
    const { shown } = await keeping({
      content: [
        {
          type: "image",
          data: screenshot.toString("base64"),
          mimeType: "image/jpeg",
        },
      ],
    })

    expect(shown.content.map((block) => block.type)).toEqual(["image", "text"])
  })

  it("replaces an image too large to pass on with its handle, and keeps a small one beside a note", async () => {
    const big = Buffer.concat([
      PNG,
      Buffer.alloc((MAX_ANSWER_IMAGE_CHARS / 4) * 3, 1),
    ])
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

  it("keeps an embedded file under the decoded last part of its address", async () => {
    const { kept } = await keeping({
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///data/my%20file.pdf",
            mimeType: "application/pdf",
            blob: Buffer.from("%PDF-1.7 ...").toString("base64"),
          },
        },
      ],
    })

    expect(kept[0]).toMatchObject({ kind: "bytes", name: "my file.pdf" })
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

describe("resourceFileName", () => {
  it("URL-decodes the last part of the address", () => {
    expect(resourceFileName("file:///data/my%20file.pdf")).toBe("my file.pdf")
    expect(resourceFileName("https://x.test/r/%C3%A9t%C3%A9.txt")).toBe(
      "été.txt",
    )
    expect(resourceFileName("file:///reports/q3.pdf")).toBe("q3.pdf")
  })

  it("leaves out the query and fragment", () => {
    expect(resourceFileName("https://x.test/a/q3.pdf?v=2#page=1")).toBe(
      "q3.pdf",
    )
  })

  it("keeps a malformed escape as written", () => {
    expect(resourceFileName("file:///data/100%.pdf")).toBe("100%.pdf")
    expect(resourceFileName("file:///data/a%E0%A4.pdf")).toBe("a%E0%A4.pdf")
  })

  it("never makes a path of a decoded separator", () => {
    expect(resourceFileName("file:///data/..%2F..%2Fetc%2Fpasswd")).toBe(
      "passwd",
    )
    expect(resourceFileName("file:///data/dir%5Cname.txt")).toBe("name.txt")
    expect(resourceFileName("file:///data/sub%2F")).toBe("sub")
  })

  it("is null when no name is left", () => {
    expect(resourceFileName("file:///")).toBeNull()
    expect(resourceFileName("file:///data/%2E%2E")).toBeNull()
    expect(resourceFileName("file:///data/%2F")).toBeNull()
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

  it("keeps an answer that is not JSON whole when keep is asked, rather than show it", async () => {
    const { kept, shown } = await keeping(
      { content: [{ type: "text", text: "just words" }] },
      { keep: ["a"] },
    )

    expect(kept).toEqual([
      { kind: "text", text: "just words", mediaType: "text/plain" },
    ])
    expect(texts(shown).join("\n")).not.toContain("just words")
    expect(texts(shown).join("\n")).toContain(
      "The answer is not JSON, so there are no parts to keep",
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

// What a program run by run_code is handed: values, not text to read.

describe("answerValue", () => {
  const MAX = 100_000

  it("hands over JSON whole, as a value, with fields applied", async () => {
    const { keepers } = fakeKeepers()

    expect(
      await answerValue(json(invoices), {}, keepers, { max: MAX }),
    ).toEqual({ ok: true, value: invoices })
    expect(
      await answerValue(json(invoices), { fields: ["data.number"] }, keepers, {
        max: MAX,
      }),
    ).toEqual({
      ok: true,
      value: { data: [{ number: "0001" }, { number: "0002" }] },
    })
  })

  it("takes structuredContent when only it is JSON, and text as text", async () => {
    const { keepers } = fakeKeepers()

    expect(
      await answerValue(
        {
          content: [{ type: "text", text: "Two invoices." }],
          structuredContent: { count: 2 },
        },
        {},
        keepers,
        { max: MAX },
      ),
    ).toEqual({ ok: true, value: { count: 2 } })
    expect(
      await answerValue(
        {
          content: [
            { type: "text", text: "one" },
            { type: "text", text: "two" },
          ],
        },
        {},
        keepers,
        { max: MAX },
      ),
    ).toEqual({ ok: true, value: "one\n\ntwo" })
  })

  it("keeps files as handles, so their bytes never reach the program", async () => {
    const { kept, keepers } = fakeKeepers()
    const answer = await answerValue(
      {
        content: [
          { type: "text", text: "Here it is." },
          {
            type: "image",
            data: PNG.toString("base64"),
            mimeType: "image/png",
          },
        ],
      },
      {},
      keepers,
      { max: MAX },
    )

    expect(answer).toEqual({
      ok: true,
      value: [
        "Here it is.",
        {
          $result: "r0",
          type: "image/png",
          size: PNG.length,
          readableUntil: UNTIL.toISOString(),
        },
      ],
    })
    expect(kept[0]).toMatchObject({ kind: "bytes", mediaType: "image/png" })
  })

  it("keeps the longest texts when it is too long, and refuses what still is", async () => {
    const { keepers } = fakeKeepers()
    const shrunk = await answerValue(json(invoices), {}, keepers, {
      max: 2_000,
    })

    expect(shrunk.ok).toBe(true)
    expect(
      (shrunk as { value: typeof invoices }).value.data[0]!.terms,
    ).toMatchObject({ $result: expect.any(String) })

    const many = Array.from({ length: 1000 }, (_, id) => ({ id }))
    const refused = await answerValue(json(many), {}, keepers, { max: 2_000 })
    expect(refused.ok).toBe(false)
    expect((refused as { error: string }).error).toContain(
      "more than a program is handed (2,000)",
    )
  })

  it("is an error with the tool's own text when the tool failed", async () => {
    const { keepers } = fakeKeepers()

    expect(
      await answerValue(
        { content: [{ type: "text", text: "Not found." }], isError: true },
        {},
        keepers,
        { max: MAX },
      ),
    ).toEqual({ ok: false, error: "Not found." })
  })
})
