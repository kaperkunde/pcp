import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, describe, expect, it } from "vitest"

import {
  answerWalled,
  json,
  startTestApi,
  type TestApi,
} from "../openapi/test-api"
import { CHALLENGE_LINE } from "./challenge"
import { fetchWeb, isPcpSite, withNote } from "./fetch"
import { MAX_FETCH_RESPONSE_BYTES } from "./limits"
import { prepareFetch, type FetchInput } from "./request"

// web_fetch's request and what it hands back, against a local server. The
// address check is replaced so 127.0.0.1 can be reached; the last test
// shows it is there without that.

let api: TestApi | null = null

afterEach(async () => {
  await api?.close()
  api = null
})

const reachLoopback = { addressCheck: () => true }

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
}

async function fetchFrom(input: Omit<FetchInput, "url"> & { path: string }) {
  const { path, ...rest } = input
  const { result } = await fetchWeb(
    prepareFetch({ ...rest, url: `${api!.origin}${path}` }),
    reachLoopback,
  )
  return result
}

describe("PCP's own site", () => {
  it("is PCP's public address, whatever the case or a trailing dot", () => {
    const own = "https://pcp.example.com"

    expect(isPcpSite(new URL("https://pcp.example.com/x"), own)).toBe(true)
    expect(isPcpSite(new URL("https://PCP.example.com./x"), own)).toBe(true)
    expect(isPcpSite(new URL("http://pcp.example.com./"), own)).toBe(true)
    expect(isPcpSite(new URL("https://example.com/"), own)).toBe(false)
    expect(isPcpSite(new URL("https://pcp.example.com/"), undefined)).toBe(
      false,
    )
  })
})

describe("fetching a page", () => {
  it("returns HTML as Markdown with the address, status and length in front", async () => {
    api = await startTestApi((_, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end(
        "<html><head><title>Pets</title></head><body><h1>All pets</h1><p>Rex is a <a href='/dogs/rex'>dog</a>.</p></body></html>",
      )
    })

    const result = await fetchFrom({ path: "/pets" })
    const text = textOf(result)

    expect(result.isError).toBeUndefined()
    expect(text).toContain(`URL: ${api.origin}/pets`)
    expect(text).toContain("Status: HTTP 200 OK")
    expect(text).toContain("Title: Pets")
    expect(text).toContain("Type: text/html, as Markdown")
    expect(text).toContain("# All pets")
    expect(text).toContain(`[dog](${api.origin}/dogs/rex)`)
    expect(api.requests[0]!.headers["user-agent"]).toMatch(/^pcp\/.+web_fetch/)
    expect(api.requests[0]!.headers.cookie).toBeUndefined()

    const raw = textOf(await fetchFrom({ path: "/pets", raw: true }))
    expect(raw).toContain("<h1>All pets</h1>")
  })

  it("pretty-prints JSON and hands a long text back in parts", async () => {
    api = await startTestApi((req, res) =>
      req.url === "/json"
        ? json(res, 200, { name: "Rex" })
        : (res.setHeader("content-type", "text/plain"),
          res.end("0123456789".repeat(3))),
    )

    expect(textOf(await fetchFrom({ path: "/json" }))).toContain(
      '{\n  "name": "Rex"\n}',
    )

    const first = textOf(await fetchFrom({ path: "/text", max_length: 12 }))
    expect(first).toContain(
      "Characters 0 to 12 of 30; call again with start_index 12 for the rest.",
    )
    expect(first.endsWith("\n\n012345678901")).toBe(true)

    const last = textOf(
      await fetchFrom({ path: "/text", max_length: 12, start_index: 24 }),
    )
    expect(last).toContain("Characters 24 to 30 of 30: the end.")

    const past = await fetchFrom({ path: "/text", start_index: 99 })
    expect(past.isError).toBe(true)
    expect(textOf(past)).toContain("past the end")
  })

  it("sends the method, the body and the assistant's headers", async () => {
    api = await startTestApi((_, res) => json(res, 201, { ok: true }))

    const result = await fetchFrom({
      path: "/orders",
      method: "POST",
      headers: { "X-Request-Id": "abc" },
      body: '{"pet":"Rex"}',
    })

    expect(textOf(result)).toContain("HTTP 201")
    expect(api.requests[0]).toMatchObject({
      method: "POST",
      url: "/orders",
      body: '{"pet":"Rex"}',
    })
    expect(api.requests[0]!.headers["content-type"]).toBe("application/json")
    expect(api.requests[0]!.headers["x-request-id"]).toBe("abc")
  })

  it("makes an error status an error result, with the page", async () => {
    api = await startTestApi((_, res) => {
      res.statusCode = 404
      res.setHeader("content-type", "text/plain")
      res.end("No such pet")
    })

    const result = await fetchFrom({ path: "/pets/9" })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("HTTP 404")
    expect(textOf(result)).toContain("No such pet")
  })

  it("describes what is not text instead of passing it on", async () => {
    api = await startTestApi((_, res) => {
      res.setHeader("content-type", "image/png")
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
    })

    expect(textOf(await fetchFrom({ path: "/logo.png" }))).toContain(
      "7 bytes of image/png; web_fetch passes on HTML, text and JSON only",
    )
  })

  it("reads no more than its limit of an answer", async () => {
    api = await startTestApi((_, res) => {
      res.setHeader("content-type", "text/plain")
      res.end("x".repeat(MAX_FETCH_RESPONSE_BYTES + 10))
    })

    const text = textOf(await fetchFrom({ path: "/big", max_length: 10 }))
    expect(text).toContain("read the first 2 MB of the answer only")
    expect(text).toContain(`of ${MAX_FETCH_RESPONSE_BYTES};`)
  })
})

describe("redirects", () => {
  it("follows one within the site, a 303 as GET without the body", async () => {
    api = await startTestApi((req, res) => {
      if (req.url === "/old") {
        res.statusCode = 303
        res.setHeader("location", "/new")
        return res.end()
      }
      res.setHeader("content-type", "text/plain")
      res.end(`${req.method} ${req.url} ${req.body}`)
    })

    const text = textOf(
      await fetchFrom({ path: "/old", method: "POST", body: "a=1" }),
    )
    expect(text).toContain(`URL: ${api.origin}/new`)
    expect(text).toContain("GET /new ")
    expect(api.requests.map((request) => request.method)).toEqual([
      "POST",
      "GET",
    ])
  })

  it("stops at one to another site and says where it points", async () => {
    api = await startTestApi((_, res) => {
      res.statusCode = 302
      res.setHeader("location", "https://elsewhere.example/landing")
      res.end()
    })

    const result = await fetchFrom({ path: "/go" })
    expect(result.isError).toBeUndefined()
    expect(textOf(result)).toContain(
      "redirects to https://elsewhere.example/landing, which is another site",
    )
    expect(api.requests).toHaveLength(1)
  })

  it("gives up on a site that keeps redirecting", async () => {
    api = await startTestApi((req, res) => {
      res.statusCode = 307
      res.setHeader("location", `${req.url}x`)
      res.end()
    })

    const result = await fetchFrom({ path: "/loop" })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("redirected more than 5 times")
  })
})

describe("a site that checks its visitors", () => {
  it("says so, and marks the answer as one", async () => {
    api = await startTestApi((request, res) => answerWalled(request, res))

    const answer = await fetchWeb(
      prepareFetch({ url: `${api.origin}/walled` }),
      reachLoopback,
    )
    const text = textOf(answer.result)

    expect(answer.challenged).toBe(true)
    expect(answer.result.isError).toBe(true)
    expect(text).toMatch(
      new RegExp(`^URL: .*\nStatus: HTTP 403 Forbidden\n${CHALLENGE_LINE}\n`),
    )
    expect(text).toContain("Title: Just a moment...")
    expect(text).not.toContain("Behind the wall")
  })

  it("does not mark an ordinary refusal", async () => {
    api = await startTestApi((_, res) => {
      res.statusCode = 403
      res.setHeader("content-type", "text/html")
      res.end("<title>Forbidden</title><h1>No</h1>")
    })

    const answer = await fetchWeb(
      prepareFetch({ url: `${api.origin}/` }),
      reachLoopback,
    )

    expect(answer.challenged).toBe(false)
    expect(textOf(answer.result)).not.toContain(CHALLENGE_LINE)
  })

  it("adds a note to the lines in front of the page", () => {
    const noted = withNote(
      { content: [{ type: "text", text: "URL: x\nStatus: y\n\nThe page" }] },
      "A note.",
    )

    expect(textOf(noted)).toBe("URL: x\nStatus: y\nA note.\n\nThe page")
    expect(
      textOf(withNote({ content: [{ type: "text", text: "One line" }] }, "N")),
    ).toBe("One line\nN")
  })
})

describe("public addresses only", () => {
  it("refuses the loopback address before anything is sent", async () => {
    api = await startTestApi((_, res) => res.end("secret admin page"))

    await expect(
      fetchWeb(prepareFetch({ url: `${api.origin}/admin` })),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringMatching(
        /127\.0\.0\.1 .*private or local address, which the owner has not allowed/,
      ),
    })
    expect(api.requests).toHaveLength(0)
  })

  it("refuses a name that resolves to the loopback address", async () => {
    api = await startTestApi((_, res) => res.end("secret admin page"))
    const port = new URL(api.origin).port

    await expect(
      fetchWeb(prepareFetch({ url: `http://localhost:${port}/admin` })),
    ).rejects.toMatchObject({ code: "forbidden" })
    expect(api.requests).toHaveLength(0)
  })
})

describe("private addresses, where the owner allowed them", () => {
  it("reaches a server on this machine's loopback address", async () => {
    api = await startTestApi((_, res) => {
      res.setHeader("content-type", "text/plain")
      res.end("the printer's page")
    })

    const { result } = await fetchWeb(prepareFetch({ url: `${api.origin}/` }), {
      allowPrivate: true,
    })

    expect(textOf(result)).toContain("the printer's page")
    expect(api.requests).toHaveLength(1)
  })

  it("still refuses PCP's own port and its public address", async () => {
    api = await startTestApi((_, res) => res.end("PCP itself"))
    const port = new URL(api.origin).port
    const before = process.env.PORT

    try {
      process.env.PORT = port
      await expect(
        fetchWeb(prepareFetch({ url: `${api.origin}/` }), {
          allowPrivate: true,
        }),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: expect.stringMatching(/PCP's own address/),
      })
    } finally {
      if (before === undefined) delete process.env.PORT
      else process.env.PORT = before
    }

    await expect(
      fetchWeb(prepareFetch({ url: "https://pcp.example.org/settings" }), {
        allowPrivate: true,
        publicUrl: "https://pcp.example.org",
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message:
        "pcp.example.org is PCP's own address, which web_fetch never reaches.",
    })
    expect(api.requests).toHaveLength(0)
  })
})
