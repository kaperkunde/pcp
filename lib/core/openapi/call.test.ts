import { afterEach, describe, expect, it } from "vitest"

import { executeCall, redactSecrets } from "./call"
import type { BuiltRequest } from "./request"
import { json, startTestApi, type TestApi } from "./test-api"

let api: TestApi | null = null

afterEach(async () => {
  await api?.close()
  api = null
})

function get(path: string, headers: Record<string, string> = {}): BuiltRequest {
  return { url: `${api!.origin}${path}`, method: "GET", headers }
}

const text = (outcome: Awaited<ReturnType<typeof executeCall>>) => {
  const block = outcome.result.content[0]
  return block?.type === "text" ? block.text : ""
}

describe("executeCall", () => {
  it("sends the method, headers and body it was given", async () => {
    api = await startTestApi((_, res) => json(res, 201, { ok: true }))
    await executeCall({
      url: `${api.origin}/pets?x=1`,
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k" },
      body: '{"a":1}',
    })
    expect(api.requests[0]).toMatchObject({
      method: "POST",
      url: "/pets?x=1",
      body: '{"a":1}',
      headers: { "content-type": "application/json", "x-api-key": "k" },
    })
  })

  it("passes JSON on as pretty text and as structured content", async () => {
    api = await startTestApi((_, res) => json(res, 200, { id: 1, tags: ["a"] }))
    const outcome = await executeCall(get("/pets/1"))
    expect(outcome.status).toBe(200)
    expect(text(outcome)).toBe('{\n  "id": 1,\n  "tags": [\n    "a"\n  ]\n}')
    expect(outcome.result.structuredContent).toEqual({ id: 1, tags: ["a"] })
    expect(outcome.result.isError).toBeUndefined()
  })

  it("wraps an array so structured content stays an object", async () => {
    api = await startTestApi((_, res) => json(res, 200, [1, 2]))
    const outcome = await executeCall(get("/pets"))
    expect(outcome.result.structuredContent).toEqual({ value: [1, 2] })
  })

  it("passes text through and describes binary instead of dumping it", async () => {
    api = await startTestApi((req, res) => {
      if (req.url === "/text") {
        res.setHeader("content-type", "text/plain; charset=utf-8")
        res.end("plain words")
      } else {
        res.setHeader("content-type", "image/png")
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      }
    })
    expect(text(await executeCall(get("/text")))).toBe("plain words")
    const binary = await executeCall(get("/image"))
    expect(text(binary)).toMatch(/4 bytes of image\/png/)
    expect(binary.result.isError).toBeUndefined()
  })

  it("reports an empty answer by its status", async () => {
    api = await startTestApi((_, res) => {
      res.statusCode = 204
      res.end()
    })
    expect(text(await executeCall(get("/pets/1")))).toBe(
      "(no content, HTTP 204 No Content)",
    )
  })

  it("turns an error status into an error result with an excerpt", async () => {
    api = await startTestApi((_, res) =>
      json(res, 404, { error: "no such pet" }),
    )
    const outcome = await executeCall(get("/pets/9"))
    expect(outcome.status).toBe(404)
    expect(outcome.result.isError).toBe(true)
    expect(text(outcome)).toMatch(/^HTTP 404 Not Found\n.*no such pet/s)
  })

  it("cuts a long error body", async () => {
    api = await startTestApi((_, res) => {
      res.statusCode = 500
      res.setHeader("content-type", "text/plain")
      res.end("e".repeat(10_000))
    })
    const outcome = await executeCall(get("/boom"))
    expect(text(outcome).length).toBeLessThan(2100)
  })

  it("does not follow a redirect, so a header never reaches the target", async () => {
    const target = await startTestApi((_, res) => res.end("secret place"))
    api = await startTestApi((_, res) => {
      res.statusCode = 302
      res.setHeader("location", `${target.origin}/elsewhere`)
      res.end()
    })
    const outcome = await executeCall(get("/go", { "x-api-key": "the-secret" }))
    await target.close()

    expect(outcome.status).toBe(302)
    expect(outcome.result.isError).toBe(true)
    expect(text(outcome)).toMatch(
      /redirected to http:\/\/127\.0\.0\.1:\d+\/elsewhere/,
    )
    expect(text(outcome)).toMatch(/does not follow redirects/)
    expect(target.requests).toHaveLength(0)
  })

  it("stops reading at the byte cap and says so", async () => {
    api = await startTestApi((_, res) => {
      res.setHeader("content-type", "text/plain")
      res.end("x".repeat(5000))
    })
    const outcome = await executeCall(get("/big"), { maxResponseBytes: 1000 })
    expect(text(outcome)).toMatch(/^x{1000}\n… \(truncated by PCP/)
  })

  it("does not parse or structure a truncated JSON answer", async () => {
    api = await startTestApi((_, res) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ items: "y".repeat(5000) }))
    })
    const outcome = await executeCall(get("/big"), { maxResponseBytes: 100 })
    expect(outcome.result.structuredContent).toBeUndefined()
    expect(text(outcome)).toMatch(/truncated by PCP/)
  })

  it("gives up on an API that never answers", async () => {
    api = await startTestApi(() => {
      // Never responds.
    })
    await expect(executeCall(get("/slow"), { timeoutMs: 200 })).rejects.toThrow(
      /no answer within/,
    )
  })

  it("reports a refused connection", async () => {
    api = await startTestApi()
    const origin = api.origin
    await api.close()
    api = null
    await expect(
      executeCall({ url: `${origin}/x`, method: "GET", headers: {} }),
    ).rejects.toThrow(/ECONNREFUSED/)
  })
})

describe("redaction", () => {
  it("removes a credential the API repeats, in text, JSON and errors", async () => {
    api = await startTestApi((req, res) => {
      if (req.url === "/echo") {
        // A debugging endpoint that reflects the request's headers.
        return json(res, 200, {
          headers: req.headers,
          raw: "Bearer sk-live-0123456789",
        })
      }
      res.statusCode = 401
      res.setHeader("content-type", "text/plain")
      res.end("Invalid API key: sk-live-0123456789")
    })
    const redact = ["sk-live-0123456789", "Bearer sk-live-0123456789"]

    const echoed = await executeCall(
      get("/echo", { authorization: "Bearer sk-live-0123456789" }),
      { redact },
    )
    expect(JSON.stringify(echoed.result)).not.toContain("sk-live-0123456789")
    expect(text(echoed)).toContain("[redacted]")
    expect(echoed.result.structuredContent).toMatchObject({ raw: "[redacted]" })

    const rejected = await executeCall(get("/nope"), { redact })
    expect(text(rejected)).toBe(
      "HTTP 401 Unauthorized\nInvalid API key: [redacted]",
    )
  })

  it("catches the form a JSON string would hold", () => {
    const secret = 'pa"ss\\word'
    expect(redactSecrets(JSON.stringify({ k: secret }), [secret])).toBe(
      '{"k":"[redacted]"}',
    )
  })

  it("leaves very short values alone, and everything else as it was", () => {
    expect(redactSecrets("a cat sat", ["a", ""])).toBe("a cat sat")
    expect(redactSecrets("nothing here", ["sk-live-0123456789"])).toBe(
      "nothing here",
    )
  })
})
