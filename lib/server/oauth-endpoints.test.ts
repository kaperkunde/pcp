import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))

import { formParams, jsonBody } from "./oauth-endpoints"

const FORM = { "content-type": "application/x-www-form-urlencoded" }
const TOO_LARGE = { message: "The request body is too large." }

function post(body: BodyInit, headers: Record<string, string>): Request {
  return new Request("http://pcp.test/oauth/token", {
    method: "POST",
    headers,
    body,
    // @ts-expect-error Node's fetch needs this to send a stream.
    duplex: "half",
  })
}

/** A chunked body of `chunks` pieces of `size` bytes, counting what is pulled. */
function chunked(chunks: number, size: number) {
  const pulled = { count: 0 }
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled.count >= chunks) return controller.close()
      pulled.count++
      controller.enqueue(new Uint8Array(size).fill(97))
    },
  })

  return { body, pulled }
}

describe("formParams", () => {
  it("reads a small form", async () => {
    expect(await formParams(post("a=1&b=%C3%A4", FORM))).toEqual({
      a: "1",
      b: "ä",
    })
  })

  it("refuses a declared length over the cap", async () => {
    await expect(
      formParams(post("a=1", { ...FORM, "content-length": "17000" })),
    ).rejects.toMatchObject(TOO_LARGE)
  })

  it("refuses a length that is not a count", async () => {
    for (const length of ["abc", "-1", "1e3", "0x10", " "]) {
      await expect(
        formParams(post("a=1", { ...FORM, "content-length": length })),
      ).rejects.toMatchObject(TOO_LARGE)
    }
  })

  it("stops reading a chunked body at the cap", async () => {
    // 4 GiB if it were read whole.
    const { body, pulled } = chunked(4096, 1024 * 1024)

    await expect(formParams(post(body, FORM))).rejects.toMatchObject(TOO_LARGE)
    expect(pulled.count).toBeLessThan(10)
  })

  it("takes a chunked body within the cap", async () => {
    const { body } = chunked(2, 100)

    expect(Object.keys(await formParams(post(body, FORM)))).toEqual([
      "a".repeat(200),
    ])
  })
})

describe("jsonBody", () => {
  const JSON_TYPE = { "content-type": "application/json" }

  it("reads JSON up to its cap and refuses a chunked body past it", async () => {
    expect(await jsonBody(post('{"a":1}', JSON_TYPE), 100)).toEqual({ a: 1 })

    const { body, pulled } = chunked(4096, 1024 * 1024)

    await expect(jsonBody(post(body, JSON_TYPE), 100)).rejects.toMatchObject(
      TOO_LARGE,
    )
    expect(pulled.count).toBeLessThan(10)
  })
})
