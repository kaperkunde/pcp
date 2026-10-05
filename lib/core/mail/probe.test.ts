import { afterEach, describe, expect, it } from "vitest"

import { json, startTestApi, type TestApi } from "../openapi/test-api"
import { completeSessionUrl } from "./addresses"
import { createFakeJmap } from "./fake-jmap"
import { probeJmapSession } from "./probe"

// The look at a JMAP session URL an assistant proposed, against servers on
// 127.0.0.1 (which is why the address check is switched off, except where
// the test is about it).

const open = () => true
let api: TestApi | null = null

afterEach(async () => {
  await api?.close()
  api = null
})

async function serve(
  handler: Parameters<typeof startTestApi>[0],
): Promise<string> {
  api = await startTestApi(handler)
  return `${api.origin}/jmap/session`
}

describe("probeJmapSession", () => {
  it("says which sign-in a server that asks for one offers", async () => {
    const url = await serve((_, res) => {
      res.setHeader("www-authenticate", 'Basic realm="mail", Bearer')
      json(res, 401, { error: "unauthorized" })
    })

    expect(await probeJmapSession(url, { addressCheck: open })).toEqual({
      checked: `A server answers at ${url} and asks for a sign-in (Basic or Bearer).`,
      privateAddress: null,
    })
  })

  it("takes a 401 that names no scheme, and a Stalwart-like JMAP server", async () => {
    const fake = createFakeJmap({ authorize: () => false })
    const url = await serve((request, res) => {
      const answer = fake.handle(request)
      res.statusCode = answer?.status ?? 404
      res.setHeader("content-type", answer?.type ?? "text/plain")
      res.end(answer?.body ?? "")
    })

    const probe = await probeJmapSession(url, { addressCheck: open })
    expect(probe.checked).toBe(
      `A server answers at ${url} and asks for a sign-in.`,
    )
  })

  it("recognises an open session as a JMAP server for mail", async () => {
    const url = await serve((_, res) =>
      json(res, 200, {
        capabilities: { "urn:ietf:params:jmap:mail": {} },
      }),
    )

    expect(await probeJmapSession(url, { addressCheck: open })).toEqual({
      checked: `A JMAP server answers at ${url}.`,
      privateAddress: null,
    })
  })

  it("sends no credential, whatever the server is", async () => {
    const url = await serve((_, res) => json(res, 401, {}))
    await probeJmapSession(url, { addressCheck: open })

    expect(api!.requests).toHaveLength(1)
    expect(api!.requests[0]!.method).toBe("GET")
    expect(api!.requests[0]!.headers.authorization).toBeUndefined()
    expect(api!.requests[0]!.headers.cookie).toBeUndefined()
  })

  it("refuses an address that is not a JMAP session", async () => {
    const notJson = await serve((_, res) => {
      res.setHeader("content-type", "text/html")
      res.end("<html>Welcome</html>")
    })
    await expect(
      probeJmapSession(notJson, { addressCheck: open }),
    ).rejects.toThrow(/answered, but not with a JMAP session for mail/)
    await api!.close()

    const noMail = await serve((_, res) =>
      json(res, 200, { capabilities: { "urn:ietf:params:jmap:core": {} } }),
    )
    await expect(
      probeJmapSession(noMail, { addressCheck: open }),
    ).rejects.toThrow(/not with a JMAP session for mail/)
    await api!.close()

    const missing = await serve((_, res) => json(res, 404, {}))
    await expect(
      probeJmapSession(missing, { addressCheck: open }),
    ).rejects.toThrow(/answered HTTP 404.*\.well-known\/jmap/)
  })

  it("names where a redirect pointed, and does not follow it", async () => {
    const url = await serve((_, res) => {
      res.statusCode = 301
      res.setHeader("location", "/.well-known/jmap")
      res.end()
    })

    await expect(probeJmapSession(url, { addressCheck: open })).rejects.toThrow(
      /answered with a redirect to http:\/\/127\.0\.0\.1:\d+\/\.well-known\/jmap.*propose that address instead/,
    )
    expect(api!.requests).toHaveLength(1)
  })

  it("says when nothing answers", async () => {
    const url = await serve((_, res) => res.end())
    await api!.close()

    await expect(probeJmapSession(url, { addressCheck: open })).rejects.toThrow(
      /could not be reached: .*Check the address/,
    )
  })

  it("does not look at a private or local address, and says so", async () => {
    const url = await serve((_, res) => json(res, 200, {}))
    const probe = await probeJmapSession(url)

    expect(probe.checked).toBeNull()
    expect(probe.privateAddress).toMatch(
      /127\.0\.0\.1 is, or resolves to, a private or local address/,
    )
    // Nothing was sent there.
    expect(api!.requests).toHaveLength(0)
  })
})

describe("completeSessionUrl", () => {
  it("puts a server with no path at the well-known address", () => {
    expect(completeSessionUrl("https://mail.example.com")).toBe(
      "https://mail.example.com/.well-known/jmap",
    )
    expect(completeSessionUrl(" https://mail.example.com/ ")).toBe(
      "https://mail.example.com/.well-known/jmap",
    )
    expect(completeSessionUrl("mail.example.com")).toBe(
      "https://mail.example.com/.well-known/jmap",
    )
  })

  it("keeps a full session URL as it is", () => {
    expect(completeSessionUrl("https://mail.example.com/jmap/session")).toBe(
      "https://mail.example.com/jmap/session",
    )
    expect(completeSessionUrl("http://192.168.1.5:8080/.well-known/jmap")).toBe(
      "http://192.168.1.5:8080/.well-known/jmap",
    )
  })

  it("refuses what the owner's own form refuses", () => {
    expect(() => completeSessionUrl("")).toThrow(/session URL/)
    expect(() => completeSessionUrl("ftp://mail.example.com")).toThrow(
      /https:\/\//,
    )
    expect(() =>
      completeSessionUrl("https://ada:secret@mail.example.com"),
    ).toThrow(/user name or password/)
    expect(() => completeSessionUrl("https://mail.example.com/?x=1")).toThrow(
      /query/,
    )
  })
})
