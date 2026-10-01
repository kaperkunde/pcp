import { afterEach, describe, expect, it } from "vitest"

import { executeCall } from "./call"
import { fetchSpec } from "./fetch-spec"
import { json, startTestApi, type TestApi } from "./test-api"
import { send } from "./transport"

let api: TestApi | null = null

afterEach(async () => {
  await api?.close()
  api = null
})

const text = (outcome: Awaited<ReturnType<typeof executeCall>>) => {
  const block = outcome.result.content[0]
  return block?.type === "text" ? block.text : ""
}

describe("a public-only request", () => {
  it("is refused for a loopback address before anything is sent", async () => {
    api = await startTestApi((_, res) => json(res, 200, { ok: true }))

    await expect(
      executeCall(
        { url: `${api.origin}/x`, method: "GET", headers: {} },
        { publicOnly: true },
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringMatching(/127\.0\.0\.1.*only reaches public/),
    })
    expect(api.requests).toHaveLength(0)
  })

  it("is refused for a name that resolves to a loopback address", async () => {
    api = await startTestApi((_, res) => json(res, 200, { ok: true }))
    const port = new URL(api.origin).port

    // The name is not an IP literal, so only the checked lookup can stop it:
    // this is the guard against a public-looking name aimed at the host.
    await expect(
      executeCall(
        { url: `http://localhost:${port}/x`, method: "GET", headers: {} },
        { publicOnly: true },
      ),
    ).rejects.toMatchObject({ code: "forbidden" })
    expect(api.requests).toHaveLength(0)
  })

  it("is refused for an IPv6 loopback literal and a metadata address", async () => {
    for (const url of [
      "http://[::1]:9/x",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      await expect(
        executeCall({ url, method: "GET", headers: {} }, { publicOnly: true }),
      ).rejects.toMatchObject({ code: "forbidden" })
    }
  })

  it("does not refuse the same address when the endpoint allows private ones", async () => {
    api = await startTestApi((_, res) => json(res, 200, { ok: true }))
    const outcome = await executeCall({
      url: `${api.origin}/x`,
      method: "GET",
      headers: {},
    })
    expect(outcome.status).toBe(200)
  })

  it("refuses to download a schema from a private address", async () => {
    api = await startTestApi((_, res) => json(res, 200, {}))
    await expect(
      fetchSpec(`${api.origin}/openapi.json`, { publicOnly: true }),
    ).rejects.toThrow(/only reaches public/)
    expect(api.requests).toHaveLength(0)
  })
})

describe("the checked transport itself", () => {
  // The address check is replaced so the local test server can be reached;
  // what is under test is the request, the lookup hook and the response.
  const allowAll = { publicOnly: true, addressCheck: () => true }

  it("sends the method, headers and body, and returns status, headers and body", async () => {
    api = await startTestApi((req, res) => {
      res.statusCode = 201
      res.setHeader("content-type", "application/json")
      res.setHeader("x-seen", req.headers["x-in"] ?? "")
      res.setHeader("set-cookie", ["a=1", "b=2"])
      res.end(JSON.stringify({ got: req.body }))
    })

    const response = await send(
      `${api.origin}/things?q=1`,
      {
        method: "POST",
        headers: { "x-in": "hello", "content-type": "text/plain" },
        body: "payload",
      },
      allowAll,
    )

    expect(response.status).toBe(201)
    expect(response.headers.get("x-seen")).toBe("hello")
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"])
    expect(await response.json()).toEqual({ got: "payload" })
    expect(api.requests[0]).toMatchObject({
      method: "POST",
      url: "/things?q=1",
    })
    expect(api.requests[0]!.headers["accept-encoding"]).toBe("identity")
  })

  it("passes a no-content answer and an error status through", async () => {
    api = await startTestApi((req, res) => {
      res.statusCode = req.url === "/gone" ? 204 : 404
      res.end(req.url === "/gone" ? undefined : "nope")
    })

    const gone = await send(
      `${api.origin}/gone`,
      { method: "DELETE" },
      allowAll,
    )
    expect(gone.status).toBe(204)
    expect(gone.body).toBeNull()

    const missing = await send(`${api.origin}/x`, {}, allowAll)
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe("nope")
  })

  it("does not follow a redirect", async () => {
    const target = await startTestApi((_, res) => res.end("elsewhere"))
    api = await startTestApi((_, res) => {
      res.statusCode = 302
      res.setHeader("location", `${target.origin}/x`)
      res.end()
    })

    const response = await send(`${api.origin}/go`, {}, allowAll)
    await target.close()
    expect(response.status).toBe(302)
    expect(target.requests).toHaveLength(0)
  })

  it("runs through executeCall like fetch does: JSON, redaction, byte cap, timeout", async () => {
    api = await startTestApi((req, res) => {
      if (req.url === "/slow") return
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          echoed: req.headers["x-api-key"],
          pad: "p".repeat(5000),
        }),
      )
    })

    const request = (path: string) => ({
      url: `${api!.origin}${path}`,
      method: "GET" as const,
      headers: { "x-api-key": "sk-live-0123456789" },
    })

    const ok = await executeCall(request("/x"), {
      ...allowAll,
      redact: ["sk-live-0123456789"],
    })
    expect(ok.status).toBe(200)
    expect(JSON.stringify(ok.result)).not.toContain("sk-live-0123456789")
    expect(ok.result.structuredContent).toMatchObject({ echoed: "[redacted]" })

    const capped = await executeCall(request("/x"), {
      ...allowAll,
      maxResponseBytes: 200,
    })
    expect(text(capped)).toMatch(/truncated by PCP/)

    await expect(
      executeCall(request("/slow"), { ...allowAll, timeoutMs: 200 }),
    ).rejects.toThrow(/no answer within/)
  })

  it("reports a refused connection by its code", async () => {
    api = await startTestApi()
    const origin = api.origin
    await api.close()
    api = null
    await expect(
      executeCall({ url: `${origin}/x`, method: "GET", headers: {} }, allowAll),
    ).rejects.toThrow(/ECONNREFUSED/)
  })
})
