import type { CallToolResult } from "@modelcontextprotocol/server"
import { describe, expect, it } from "vitest"

import {
  decodeBase64Text,
  pickFields,
  readFields,
  shapeAnswer,
} from "./answers"

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
