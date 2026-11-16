import { afterEach, describe, expect, it } from "vitest"

import { DavClient } from "../caldav/client"
import { startTestApi, type TestApi } from "../openapi/test-api"
import { parseRetryAfter, throttleOf } from "../throttle-signal"
import { describeImapError } from "./imap"
import {
  fetchJmapSession,
  jmapRequest,
  knownJmapLimits,
  rememberJmapLimits,
} from "./jmap"
import { imapThrottle, noticeThrottle } from "./throttle"
import type { MailCredential } from "./types"

// Every protocol's own "slow down" comes out as an Error carrying
// pcpThrottle, for the call gate to read; the message stays the server's.

describe("Retry-After", () => {
  it("reads seconds and dates, and bounds them", () => {
    expect(parseRetryAfter("30")).toBe(30_000)
    expect(
      parseRetryAfter(
        "Wed, 21 Oct 2026 07:28:30 GMT",
        Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"),
      ),
    ).toBe(30_000)
    expect(parseRetryAfter("999999999")).toBe(60 * 60 * 1000)
    expect(parseRetryAfter("soon")).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
  })
})

describe("IMAP answers that went through but say [THROTTLED]", () => {
  // Gmail, throttling an account, still answers OK but marks each answer
  // and takes seconds over each (seen live on 15 Nov 2026).
  it("are a request to go slower, not a refusal", () => {
    expect(
      noticeThrottle(["4 OK Success [THROTTLED]", "5 OK Success [THROTTLED]"]),
    ).toEqual({
      reason:
        "The IMAP server marks its answers [THROTTLED]: it is slowing PCP down",
      slow: true,
    })
  })

  it("are not an alert or an answer without the mark", () => {
    expect(noticeThrottle([])).toBeNull()
    expect(
      noticeThrottle(["* OK [ALERT] Please log in via your web browser"]),
    ).toBeNull()
  })
})

describe("IMAP", () => {
  const imapError = (fields: Record<string, unknown>) =>
    Object.assign(new Error("Command failed"), fields)

  it("reads [THROTTLED] on a tagged answer", () => {
    expect(
      imapThrottle(
        imapError({
          responseStatus: "NO",
          serverResponseCode: "THROTTLED",
          responseText: "Too many commands",
        }),
      ),
    ).toMatchObject({ reason: expect.stringMatching(/throttl/i) })
  })

  it("reads the back-off a server names", () => {
    expect(
      imapThrottle(
        imapError({
          code: "ETHROTTLE",
          throttleReset: 92_415,
          responseText:
            "Request is throttled. Suggested Backoff Time: 92415 milliseconds",
        }),
      ),
    ).toMatchObject({ retryAfterMs: 92_415 })
  })

  it("reads a BYE that says to slow down or names a limit", () => {
    expect(
      imapThrottle(
        imapError({
          code: "NoConnection",
          reason: "Too many simultaneous connections.",
        }),
      ),
    ).not.toBeNull()
    expect(
      imapThrottle(
        imapError({
          code: "NoConnection",
          reason: "Rate limit exceeded, try later",
        }),
      ),
    ).not.toBeNull()
  })

  it("reads LIMIT and UNAVAILABLE only where they mean rate", () => {
    expect(
      imapThrottle(
        imapError({
          responseStatus: "NO",
          serverResponseCode: "LIMIT",
          responseText: "Too many requests from this client",
        }),
      ),
    ).not.toBeNull()
    expect(
      imapThrottle(
        imapError({
          responseStatus: "NO",
          serverResponseCode: "UNAVAILABLE",
          responseText: "Temporary authentication failure, try again later",
        }),
      ),
    ).not.toBeNull()
    // A mailbox that is too big, or a server that is down, is not a rate.
    expect(
      imapThrottle(
        imapError({
          responseStatus: "NO",
          serverResponseCode: "LIMIT",
          responseText: "Message too large",
        }),
      ),
    ).toBeNull()
    expect(
      imapThrottle(
        imapError({
          responseStatus: "NO",
          serverResponseCode: "UNAVAILABLE",
          responseText: "Backend down",
        }),
      ),
    ).toBeNull()
  })

  it("does not take a plain outage or a size limit for throttling", () => {
    expect(
      imapThrottle(
        imapError({
          responseStatus: "NO",
          responseText: "Temporary failure, try again later",
        }),
      ),
    ).toBeNull()
    expect(
      imapThrottle(
        imapError({
          responseStatus: "NO",
          serverResponseCode: "LIMIT",
          responseText: "Message exceeded the size limit",
        }),
      ),
    ).toBeNull()
    expect(
      imapThrottle(
        imapError({
          responseStatus: "NO",
          responseText: "Mailbox size limit exceeded",
        }),
      ),
    ).toBeNull()
  })

  it("keeps the login out of the reason", () => {
    const slow = imapThrottle(
      imapError({
        serverResponseCode: "THROTTLED",
        responseText: "Slow down hunter2-secret",
      }),
      ["hunter2-secret"],
    )

    expect(slow?.reason).not.toMatch(/hunter2-secret/)
  })

  it("leaves a wrong password and an ordinary no alone", () => {
    expect(
      imapThrottle(
        imapError({
          authenticationFailed: true,
          responseText: "Invalid credentials",
        }),
      ),
    ).toBeNull()
    expect(
      imapThrottle(
        imapError({ responseStatus: "NO", responseText: "No such mailbox" }),
      ),
    ).toBeNull()
  })

  it("comes out of describeImapError as a transport error that says so", () => {
    const described = describeImapError(
      imapError({
        responseStatus: "NO",
        serverResponseCode: "THROTTLED",
        responseText: "Slow down",
      }),
      "IMAP",
    )

    expect(described.name).toBe("MailTransportError")
    expect(described.message).toMatch(/Slow down/)
    expect(throttleOf(described)).toMatchObject({ reason: expect.any(String) })
  })

  it("does not turn a refused login into a throttle", () => {
    const described = describeImapError(
      imapError({ authenticationFailed: true, code: "EAUTH" }),
      "IMAP",
    )

    expect(described.name).toBe("MailAuthError")
    expect(throttleOf(described)).toBeNull()
  })
})

let api: TestApi | null = null

afterEach(async () => {
  await api?.close()
  api = null
})

function basic(): MailCredential {
  return { headers: { Authorization: "Basic x" }, login: null, redact: [] }
}

describe("JMAP", () => {
  async function serve(
    answer: (request: { url: string }) => {
      status: number
      headers?: Record<string, string>
      body?: string
    },
  ) {
    api = await startTestApi((request, res) => {
      const { status, headers, body } = answer({ url: request.url ?? "" })
      res.statusCode = status
      for (const [name, value] of Object.entries(headers ?? {})) {
        res.setHeader(name, value)
      }
      res.end(body ?? "")
    })
    return `${api.origin}/jmap/api`
  }

  it("reads HTTP 429 with its Retry-After", async () => {
    const url = await serve(() => ({
      status: 429,
      headers: { "retry-after": "7" },
    }))
    const error = await jmapRequest(url, basic(), []).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect(throttleOf(error)).toMatchObject({ retryAfterMs: 7_000 })
    expect((error as Error).message).toMatch(/429/)
  })

  it("reads 503 with a Retry-After, and a 503 without one as a plain failure", async () => {
    let with503 = true
    const url = await serve(() =>
      with503
        ? { status: 503, headers: { "retry-after": "3" } }
        : { status: 503 },
    )

    expect(
      throttleOf(await jmapRequest(url, basic(), []).catch((e: unknown) => e)),
    ).toMatchObject({ retryAfterMs: 3_000 })
    with503 = false
    expect(
      throttleOf(await jmapRequest(url, basic(), []).catch((e: unknown) => e)),
    ).toBeNull()
  })

  it("reads the limit error of RFC 8620 when it is about concurrency", async () => {
    const url = await serve(() => ({
      status: 400,
      headers: { "content-type": "application/problem+json" },
      body: JSON.stringify({
        type: "urn:ietf:params:jmap:error:limit",
        limit: "maxConcurrentRequests",
        status: 400,
        detail: "Too many requests at once",
      }),
    }))
    const error = await jmapRequest(url, basic(), []).catch((e: unknown) => e)

    expect(throttleOf(error)).not.toBeNull()
    expect((error as Error).message).toMatch(/Too many requests/)
  })

  it("leaves a limit about size as the request's own problem", async () => {
    const url = await serve(() => ({
      status: 400,
      body: JSON.stringify({
        type: "urn:ietf:params:jmap:error:limit",
        limit: "maxSizeRequest",
      }),
    }))
    const error = await jmapRequest(url, basic(), []).catch((e: unknown) => e)

    expect(throttleOf(error)).toBeNull()
  })

  it("reads a method that answers rateLimit", async () => {
    const url = await serve(() => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        methodResponses: [
          ["error", { type: "rateLimit", description: "Slow down" }, "a"],
        ],
      }),
    }))
    const error = await jmapRequest(url, basic(), [
      ["Mailbox/get", {}, "a"],
    ]).catch((e: unknown) => e)

    expect(throttleOf(error)).not.toBeNull()
  })
})

describe("JMAP limits the session names", () => {
  afterEach(() => {
    for (const url of seen) rememberJmapLimits(url, undefined)
    seen.length = 0
  })
  const seen: string[] = []

  it("reads maxConcurrentRequests and maxCallsInRequest from the session", async () => {
    api = await startTestApi((request, res) => {
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          capabilities: {
            "urn:ietf:params:jmap:core": {
              maxConcurrentRequests: 2,
              maxCallsInRequest: 3,
            },
            "urn:ietf:params:jmap:mail": {},
          },
          primaryAccounts: { "urn:ietf:params:jmap:mail": "a1" },
          accounts: { a1: {} },
          apiUrl: `${api!.origin}/api`,
        }),
      )
      void request
    })
    const session = await fetchJmapSession(`${api.origin}/session`, basic())
    seen.push(session.apiUrl)

    expect(knownJmapLimits(session.apiUrl)).toEqual({
      maxConcurrentRequests: 2,
      maxCallsInRequest: 3,
    })
  })

  it("keeps limits per account, though the address is shared", () => {
    rememberJmapLimits(
      "https://shared.example/api",
      { maxCallsInRequest: 2 },
      "a",
    )
    seen.push("https://shared.example/api")

    expect(knownJmapLimits("https://shared.example/api", "a")).toEqual({
      maxCallsInRequest: 2,
    })
    expect(knownJmapLimits("https://shared.example/api", "b")).toBeUndefined()
    rememberJmapLimits("https://shared.example/api", undefined, "a")
  })

  it("never has more requests open than the server allows", async () => {
    let open = 0
    let most = 0
    api = await startTestApi((_request, res) => {
      open++
      most = Math.max(most, open)
      setTimeout(() => {
        open--
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ methodResponses: [] }))
      }, 15)
    })
    const url = `${api.origin}/api`
    seen.push(url)
    rememberJmapLimits(url, { maxConcurrentRequests: 2 })

    await Promise.all(
      Array.from({ length: 6 }, () => jmapRequest(url, basic(), [])),
    )

    expect(most).toBe(2)
  })

  it("sends more calls than the server takes in parts, answered together", async () => {
    const sizes: number[] = []
    api = await startTestApi((request, res) => {
      const sent = JSON.parse(request.body) as {
        methodCalls: Array<[string, object, string]>
      }
      sizes.push(sent.methodCalls.length)
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          methodResponses: sent.methodCalls.map(([name, , id]) => [
            name,
            { ok: id },
            id,
          ]),
        }),
      )
    })
    const url = `${api.origin}/api`
    seen.push(url)
    rememberJmapLimits(url, { maxCallsInRequest: 2 })

    const answers = await jmapRequest(
      url,
      basic(),
      ["a", "b", "c", "d", "e"].map((id) => ["Mailbox/get", {}, id]),
    )

    expect(sizes).toEqual([2, 2, 1])
    expect([...answers.keys()]).toEqual(["a", "b", "c", "d", "e"])
  })
})

describe("CalDAV", () => {
  async function client(answer: {
    status: number
    headers?: Record<string, string>
  }) {
    api = await startTestApi((_request, res) => {
      res.statusCode = answer.status
      for (const [name, value] of Object.entries(answer.headers ?? {})) {
        res.setHeader(name, value)
      }
      res.end("")
    })
    return new DavClient(`${api.origin}/dav/`, { headers: {}, redact: [] })
  }

  it("reads 429 and 503 with Retry-After", async () => {
    const limited = await client({
      status: 429,
      headers: { "retry-after": "12" },
    })
    const error = await limited
      .request(`${api!.origin}/dav/`, { method: "PROPFIND", depth: "0" })
      .catch((e: unknown) => e)

    expect(throttleOf(error)).toMatchObject({ retryAfterMs: 12_000 })
    await api!.close()

    const busy = await client({ status: 503, headers: { "retry-after": "5" } })
    expect(
      throttleOf(
        await busy
          .request(`${api!.origin}/dav/`, { method: "PROPFIND", depth: "0" })
          .catch((e: unknown) => e),
      ),
    ).toMatchObject({ retryAfterMs: 5_000 })
  })

  it("leaves a plain 503 alone", async () => {
    const down = await client({ status: 503 })
    const answer = await down.request(`${api!.origin}/dav/`, {
      method: "PROPFIND",
      depth: "0",
    })

    expect(answer.status).toBe(503)
  })
})
