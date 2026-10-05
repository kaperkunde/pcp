import { describe, expect, it } from "vitest"

import { PCP_VERSION } from "../version"
import { runUpdateRound, updateDue } from "./check"
import {
  MAX_NOTES_CHARS,
  releaseApiUrl,
  releasePageUrl,
  UPDATE_BACKOFF_MS,
  UPDATE_CHECK_EVERY_MS,
} from "./limits"
import { fetchLatestRelease, parseRelease, USER_AGENT } from "./release"
import { newerRelease, type UpdateStatus } from "./state"

// The update check: reading what GitHub answers (an untrusted document),
// asking within limits, and when a round is due.

const URL_ = "https://api.example.test/repos/o/r/releases/latest"

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v9.9.9",
    published_at: "2026-10-01T10:00:00Z",
    body: "## What's new\n- things",
    assets: [{ name: "PCP-mac-arm64.dmg" }, { name: "PCP-windows-x64.exe" }],
    html_url: "https://evil.example/phish",
    ...overrides,
  }
}

type Call = { url: string; init?: RequestInit }

/** A fetch that answers from a queue and records each call. */
function fakeFetch(...answers: (Response | Error)[]) {
  const calls: Call[] = []
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: input.toString(), init })
    const answer = answers.shift()

    if (!answer) throw new TypeError("fetch failed")
    if (answer instanceof Error) throw answer

    return answer
  }) as typeof fetch

  return { fetchFn, calls }
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  })

describe("reading a release", () => {
  it("keeps only the version, date, notes and file names", () => {
    const read = parseRelease(release())

    expect(read).toEqual({
      version: "9.9.9",
      publishedAt: "2026-10-01T10:00:00.000Z",
      notes: "## What's new\n- things",
      assets: ["PCP-mac-arm64.dmg", "PCP-windows-x64.exe"],
    })
    expect(JSON.stringify(read)).not.toContain("evil.example")
  })

  it("refuses a tag that is not a version, and a document that is not a release", () => {
    for (const bad of [
      release({ tag_name: "nightly" }),
      release({ tag_name: "v1.2.3-rc.1" }),
      release({ tag_name: 7 }),
      [],
      "text",
      null,
    ]) {
      expect(() => parseRelease(bad)).toThrow(/could not read/)
    }
  })

  it("cuts long notes and drops characters that do not show", () => {
    const notes = parseRelease(
      release({ body: `fix‮​\u0007${"x".repeat(MAX_NOTES_CHARS * 2)}` }),
    ).notes

    expect(notes.startsWith("fixx")).toBe(true)
    expect(notes).not.toMatch(/[‮​\u0007]/)
    expect([...notes]).toHaveLength(MAX_NOTES_CHARS + 1)
    expect(notes.endsWith("…")).toBe(true)
  })

  it("copes with a release that has no notes, date or files", () => {
    expect(
      parseRelease({ tag_name: "1.0.0", body: null, published_at: null }),
    ).toEqual({ version: "1.0.0", publishedAt: null, notes: "", assets: [] })
  })

  it("builds the release page from the repository, not from the answer", () => {
    expect(releasePageUrl("1.2.3")).toBe(
      "https://github.com/kaperkunde/pcp/releases/tag/v1.2.3",
    )
  })
})

describe("asking GitHub", () => {
  it("sends the version in the user agent and nothing that identifies the owner", async () => {
    const { fetchFn, calls } = fakeFetch(json(release()))

    expect((await fetchLatestRelease(fetchFn, URL_)).version).toBe("9.9.9")
    expect(calls).toHaveLength(1)
    expect(calls[0].init?.redirect).toBe("manual")
    expect(calls[0].init?.headers).toEqual({
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
    })
    expect(USER_AGENT).toContain(`PCP/${PCP_VERSION}`)
  })

  it("asks the repository's latest release at GitHub unless told otherwise", () => {
    expect(releaseApiUrl()).toBe(
      "https://api.github.com/repos/kaperkunde/pcp/releases/latest",
    )
  })

  it("follows a redirect to the same site, a couple of times at most", async () => {
    const moved = (to: string) =>
      new Response(null, { status: 301, headers: { location: to } })
    const ok = fakeFetch(
      moved("https://api.example.test/repositories/1/releases/latest"),
      json(release()),
    )

    expect((await fetchLatestRelease(ok.fetchFn, URL_)).version).toBe("9.9.9")
    expect(ok.calls[1].url).toBe(
      "https://api.example.test/repositories/1/releases/latest",
    )

    const loop = fakeFetch(
      moved("https://api.example.test/a"),
      moved("https://api.example.test/b"),
      moved("https://api.example.test/c"),
    )

    await expect(fetchLatestRelease(loop.fetchFn, URL_)).rejects.toThrow(
      /somewhere else/,
    )
  })

  it("does not follow a redirect to another site", async () => {
    const { fetchFn, calls } = fakeFetch(
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.test/x" },
      }),
      json(release()),
    )

    await expect(fetchLatestRelease(fetchFn, URL_)).rejects.toThrow(
      /somewhere else/,
    )
    expect(calls).toHaveLength(1)
  })

  it("says when GitHub is limiting requests, has no release, or fails", async () => {
    const limited = fakeFetch(
      new Response("{}", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    )
    await expect(fetchLatestRelease(limited.fetchFn, URL_)).rejects.toThrow(
      /limiting requests/,
    )

    const tooMany = fakeFetch(new Response("{}", { status: 429 }))
    await expect(fetchLatestRelease(tooMany.fetchFn, URL_)).rejects.toThrow(
      /limiting requests/,
    )

    const none = fakeFetch(new Response("{}", { status: 404 }))
    await expect(fetchLatestRelease(none.fetchFn, URL_)).rejects.toThrow(
      /no published release/,
    )

    const broken = fakeFetch(new Response("", { status: 502 }))
    await expect(fetchLatestRelease(broken.fetchFn, URL_)).rejects.toThrow(
      /HTTP 502/,
    )
  })

  it("says when it cannot reach GitHub", async () => {
    const { fetchFn } = fakeFetch(new TypeError("fetch failed"))

    await expect(fetchLatestRelease(fetchFn, URL_)).rejects.toThrow(
      /could not reach GitHub/,
    )
  })

  it("refuses an answer that is not JSON or is far too large", async () => {
    const text = fakeFetch(new Response("<html>", { status: 200 }))
    await expect(fetchLatestRelease(text.fetchFn, URL_)).rejects.toThrow(
      /could not read/,
    )

    const large = fakeFetch(
      new Response("x".repeat(300 * 1024), { status: 200 }),
    )
    await expect(fetchLatestRelease(large.fetchFn, URL_)).rejects.toThrow(
      /could not read/,
    )
  })
})

const NOW = new Date("2026-10-05T12:00:00Z")
const hoursAgo = (hours: number) =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString()

describe("when a round is due", () => {
  it("is due when nothing was ever checked", () => {
    expect(updateDue({}, NOW)).toBe(true)
  })

  it("waits a day after a good check", () => {
    expect(updateDue({ lastCheckedAt: hoursAgo(23) }, NOW)).toBe(false)
    expect(updateDue({ lastCheckedAt: hoursAgo(24) }, NOW)).toBe(true)
  })

  it("waits out a back-off, whatever the last check's age", () => {
    const status: UpdateStatus = {
      lastCheckedAt: hoursAgo(30),
      nextAttemptAt: new Date(NOW.getTime() + 60_000).toISOString(),
    }

    expect(updateDue(status, NOW)).toBe(false)
    expect(updateDue(status, new Date(NOW.getTime() + 60_000))).toBe(true)
  })
})

describe("a round", () => {
  it("does nothing, and says so by returning the status itself, when none is due", async () => {
    const status = { lastCheckedAt: hoursAgo(1) }
    const { fetchFn, calls } = fakeFetch(json(release()))

    expect(await runUpdateRound({ status, now: NOW, fetchFn, url: URL_ })).toBe(
      status,
    )
    expect(calls).toHaveLength(0)
  })

  it("records the latest release and clears an earlier failure", async () => {
    const { fetchFn } = fakeFetch(json(release()))
    const next = await runUpdateRound({
      status: {
        lastCheckedAt: hoursAgo(25),
        lastError: "old",
        failures: 2,
        nextAttemptAt: hoursAgo(1),
        installRequest: { id: "a", at: hoursAgo(1), version: "9.9.9" },
      },
      now: NOW,
      fetchFn,
      url: URL_,
    })

    expect(next).toMatchObject({
      lastCheckedAt: NOW.toISOString(),
      latest: { version: "9.9.9" },
      lastError: undefined,
      failures: undefined,
      nextAttemptAt: undefined,
      installRequest: { id: "a" },
    })
  })

  it("backs off after each failure: an hour, four hours, then a day", async () => {
    let status: UpdateStatus = { latest: parseRelease(release()) }
    const waits: number[] = []

    for (let i = 0; i < 4; i++) {
      const { fetchFn } = fakeFetch(new Error("offline"))
      status = await runUpdateRound({
        status,
        now: NOW,
        force: true,
        fetchFn,
        url: URL_,
      })
      waits.push(Date.parse(status.nextAttemptAt!) - NOW.getTime())
    }

    expect(waits).toEqual([
      UPDATE_BACKOFF_MS[0],
      UPDATE_BACKOFF_MS[1],
      UPDATE_BACKOFF_MS[2],
      UPDATE_BACKOFF_MS[2],
    ])
    expect(status.failures).toBe(4)
    expect(status.lastError).toMatch(/could not reach GitHub/)
    // What was known stays shown while the check is failing.
    expect(status.latest?.version).toBe("9.9.9")
  })

  it("asks again when forced, back-off or not", async () => {
    const { fetchFn, calls } = fakeFetch(json(release({ tag_name: "v9.9.10" })))
    const next = await runUpdateRound({
      status: {
        lastCheckedAt: hoursAgo(1),
        nextAttemptAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
        failures: 1,
      },
      now: NOW,
      force: true,
      fetchFn,
      url: URL_,
    })

    expect(calls).toHaveLength(1)
    expect(next.latest?.version).toBe("9.9.10")
    expect(next.nextAttemptAt).toBeUndefined()
  })

  it("keeps a day between good checks", () => {
    expect(UPDATE_CHECK_EVERY_MS).toBe(24 * 3_600_000)
  })
})

describe("a newer release", () => {
  it("is one later than this PCP, and nothing else", () => {
    const status = (version: string): UpdateStatus => ({
      latest: { version, publishedAt: null, notes: "", assets: [] },
    })

    expect(newerRelease(status("999.0.0"))?.version).toBe("999.0.0")
    expect(newerRelease(status(PCP_VERSION))).toBeNull()
    expect(newerRelease(status("0.0.1"))).toBeNull()
    expect(newerRelease({})).toBeNull()
  })
})
