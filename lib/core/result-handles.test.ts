import { afterEach, describe, expect, it } from "vitest"

import { isPcpError } from "./errors"
import {
  collectHandleIds,
  MAX_HANDLE_DEPTH,
  MAX_HANDLE_NODES,
  parseHandle,
  resolveHandles,
} from "./result-handles"
import {
  EMPTY_CONFIG,
  forgetResourceLimits,
  useResourceConfig,
} from "./resources/state"
import type { OpenedResult, ResultOpener } from "./tool-results"

// Handles in a call's arguments, resolved from a token's kept results.

afterEach(() => forgetResourceLimits())

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function text(id: string, value: string): OpenedResult {
  return {
    id,
    kind: "text",
    mediaType: "text/plain",
    name: null,
    length: value.length,
    text: () => value,
    bytes: () => Buffer.from(value, "utf8"),
  }
}

function file(id: string, bytes: Buffer, mediaType: string): OpenedResult {
  return {
    id,
    kind: "bytes",
    mediaType,
    name: "f",
    length: bytes.length,
    text: () => {
      if (!mediaType.startsWith("text/")) {
        throw new Error(`Result ${id} is ${mediaType}, not text`)
      }

      return bytes.toString("utf8")
    },
    bytes: () => bytes,
  }
}

function opener(results: OpenedResult[]) {
  const calls: string[] = []
  const open: ResultOpener = async (id) => {
    calls.push(id)
    return results.find((result) => result.id === id) ?? null
  }

  return { open, calls }
}

const RESULTS = [
  text("t1", "hello"),
  file("b1", PNG, "image/png"),
  file("c1", Buffer.from("a,b\n1,2\n"), "text/csv"),
]

describe("parseHandle", () => {
  it("takes only an object of $result and as", () => {
    expect(parseHandle({ $result: "r1" })).toEqual({ $result: "r1" })
    expect(parseHandle({ $result: "r1", as: "base64" })).toEqual({
      $result: "r1",
      as: "base64",
    })
    expect(parseHandle({ $result: "r1", name: "x" })).toBeNull()
    expect(parseHandle({ $result: 5 })).toBeNull()
    expect(parseHandle({ $result: "" })).toBeNull()
    expect(parseHandle({ $result: "x".repeat(65) })).toBeNull()
    expect(parseHandle("r1")).toBeNull()
    expect(parseHandle([{ $result: "r1" }])).toBeNull()
  })

  it("refuses an as that is not text or base64", () => {
    expect(() => parseHandle({ $result: "r1", as: "hex" })).toThrow(/"as"/)
  })
})

describe("collectHandleIds", () => {
  it("lists each id once, in order, however deep", () => {
    expect(
      collectHandleIds({
        a: { $result: "x" },
        b: [{ c: { $result: "y" } }, { $result: "x" }],
        d: { $result: "z", extra: 1 },
      }),
    ).toEqual(["x", "y"])
  })

  it("with loose, also lists attachments that carry a name and type, never other objects", () => {
    const args = {
      attachments: [{ $result: "a", name: "f.pdf", type: "application/pdf" }],
      api: { $result: "b", other: 1 },
      text: { $result: "c" },
    }

    expect(collectHandleIds(args)).toEqual(["c"])
    expect(collectHandleIds(args, { loose: true })).toEqual(["a", "c"])
  })
})

describe("resolveHandles", () => {
  it("replaces a text handle with the text, and a file with base64", async () => {
    const { open } = opener(RESULTS)

    expect(
      await resolveHandles(
        { body: { $result: "t1" }, data: { $result: "b1" }, n: 3 },
        open,
      ),
    ).toEqual({ body: "hello", data: PNG.toString("base64"), n: 3 })
  })

  it("honours as: a text as base64, a text file as its text, a binary file as text refused", async () => {
    const { open } = opener(RESULTS)

    expect(
      await resolveHandles({ a: { $result: "t1", as: "base64" } }, open),
    ).toEqual({ a: Buffer.from("hello").toString("base64") })
    expect(
      await resolveHandles({ a: { $result: "c1", as: "text" } }, open),
    ).toEqual({ a: "a,b\n1,2\n" })
    await expect(
      resolveHandles({ a: { $result: "b1", as: "text" } }, open),
    ).rejects.toThrow(/Result b1 is image\/png, not text/)
  })

  it("resolves in nested objects and arrays, and leaves everything else alone", async () => {
    const { open } = opener(RESULTS)
    const args = {
      list: [{ v: { $result: "t1" } }, "plain", 4, null, true],
      same: { $result: "t1", other: "key" },
    }

    expect(await resolveHandles(args, open)).toEqual({
      list: [{ v: "hello" }, "plain", 4, null, true],
      same: { $result: "t1", other: "key" },
    })
  })

  it("opens each id once however often it is named", async () => {
    const { open, calls } = opener(RESULTS)

    await resolveHandles(
      { a: { $result: "t1" }, b: [{ $result: "t1" }, { $result: "t1" }] },
      open,
    )

    expect(calls).toEqual(["t1"])
  })

  it("returns the arguments as they are when there is no handle, without opening", async () => {
    const { open, calls } = opener(RESULTS)
    const args = { a: 1 }

    expect(await resolveHandles(args, open)).toBe(args)
    expect(calls).toEqual([])
  })

  it("refuses an unknown id by name, and says what to do", async () => {
    const { open } = opener(RESULTS)
    const refused = resolveHandles(
      { a: { $result: "t1" }, b: { $result: "gone" } },
      open,
    )

    await expect(refused).rejects.toThrow(
      /No kept result "gone" for this token/,
    )
    await refused.catch((error) => expect(isPcpError(error)).toBe(true))
  })

  it("leaves skipped arguments alone, unopened", async () => {
    const { open, calls } = opener(RESULTS)
    const attachments = [{ $result: "b1" }]

    expect(
      await resolveHandles({ text: { $result: "t1" }, attachments }, open, {
        skip: ["attachments"],
      }),
    ).toEqual({ text: "hello", attachments })
    expect(calls).toEqual(["t1"])
  })

  it("refuses arguments nested too deep or holding too many values", async () => {
    const { open } = opener(RESULTS)
    let deep: unknown = { $result: "t1" }

    for (let i = 0; i <= MAX_HANDLE_DEPTH; i++) {
      deep = { next: deep }
    }

    await expect(resolveHandles({ deep }, open)).rejects.toThrow(/nest deeper/)
    await expect(
      resolveHandles(
        { many: Array.from({ length: MAX_HANDLE_NODES }, () => 1) },
        open,
      ),
    ).rejects.toThrow(/more than/)
  })

  it("refuses handles that add up to more than a call may carry", async () => {
    // The largest file at 1 MB: a call carries 16 million characters.
    useResourceConfig({ ...EMPTY_CONFIG, fileMb: 1 })
    const big = file(
      "big",
      Buffer.alloc(8_000_000, 1),
      "application/octet-stream",
    )
    const { open } = opener([big])

    await expect(
      resolveHandles(
        { a: { $result: "big" }, b: { $result: "big" }, c: { $result: "big" } },
        open,
      ),
    ).rejects.toThrow(/add up to more than/)
  })
})
