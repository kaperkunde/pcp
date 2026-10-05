import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readDuckDnsPaste } from "../constants"
import { scratchDatabase } from "../test-db"
import {
  customRequest,
  DDNS_BLIND_INTERVAL_MS,
  DDNS_REFRESH_MS,
  type DdnsConfig,
  ddnsHostname,
  ddnsView,
  getDdnsConfig,
  getDdnsStatus,
  lookupPublicIp,
  parseDdnsInput,
  parsePublicIpv4,
  PUBLIC_IP_SERVICES,
  readDuckDnsAnswer,
  readDyndns2Answer,
  runDdnsRound,
  saveDdnsConfig,
  saveDdnsStatus,
  sendDdnsUpdate,
} from "./ddns"

// Dynamic DNS: reading the form, what each service is sent and how its
// answer is read, and when an update is due.

type Call = { url: string; init?: RequestInit }

/** A fetch that answers from a table of URL prefixes and records each call. */
function fakeFetch(
  routes: Record<string, (call: Call) => Response | Promise<Response>>,
) {
  const calls: Call[] = []
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input.toString()
    const call = { url, init }
    calls.push(call)
    const prefix = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((key) => url.startsWith(key))

    if (!prefix) {
      throw new TypeError("fetch failed")
    }

    return routes[prefix](call)
  }) as typeof fetch

  return { fetchFn, calls }
}

const text =
  (body: string, status = 200) =>
  () =>
    new Response(body, { status })
const ipService = { [PUBLIC_IP_SERVICES[0]]: text("203.0.113.7\n") }

const TOKEN = "a7c4d0ad-114e-40ef-ba1d-d217904a50f2"

const duck: DdnsConfig = {
  provider: "duckdns",
  subdomain: "my-house",
  token: "duck-token",
}

function header(call: Call, name: string): string | undefined {
  return (call.init?.headers as Record<string, string> | undefined)?.[name]
}

describe("reading the form", () => {
  it("takes a DuckDNS name with or without the suffix", () => {
    expect(
      parseDdnsInput(
        {
          provider: "duckdns",
          subdomain: "My-House.duckdns.org",
          token: TOKEN,
        },
        null,
      ),
    ).toEqual({ provider: "duckdns", subdomain: "my-house", token: TOKEN })
  })

  it("finds the DuckDNS token, and the name, in whatever was pasted", () => {
    // The update line from duckdns.org's install page.
    const line = `echo url="https://www.duckdns.org/update?domains=my-house&token=${TOKEN.toUpperCase()}&ip=" | curl -k -o ~/duckdns/duck.log -K -`

    expect(
      parseDdnsInput({ provider: "duckdns", subdomain: "", token: line }, null),
    ).toEqual({ provider: "duckdns", subdomain: "my-house", token: TOKEN })
    // A name typed in wins over the one in the line.
    expect(
      parseDdnsInput(
        { provider: "duckdns", subdomain: "lantern", token: line },
        null,
      ),
    ).toEqual({ provider: "duckdns", subdomain: "lantern", token: TOKEN })
    expect(
      parseDdnsInput(
        {
          provider: "duckdns",
          subdomain: "lantern",
          token: ` token: ${TOKEN}\n`,
        },
        null,
      ),
    ).toEqual({ provider: "duckdns", subdomain: "lantern", token: TOKEN })
    expect(readDuckDnsPaste("https://lantern.duckdns.org")).toEqual({
      token: null,
      subdomain: "lantern",
    })
  })

  it("says so when what was pasted holds no DuckDNS token", () => {
    expect(() =>
      parseDdnsInput(
        { provider: "duckdns", subdomain: "lantern", token: "my password" },
        null,
      ),
    ).toThrow(/not a DuckDNS token/)
  })

  it("refuses a provider it does not know and a bad name", () => {
    expect(() => parseDdnsInput({ provider: "dyn.com" }, null)).toThrow(
      /Choose a dynamic DNS service/,
    )
    expect(() =>
      parseDdnsInput(
        { provider: "duckdns", subdomain: "a b", token: TOKEN },
        null,
      ),
    ).toThrow(/DuckDNS name/)
    expect(() =>
      parseDdnsInput(
        {
          provider: "dyndns2",
          server: "dynupdate.no-ip.com",
          hostname: "10.0.0.1",
          username: "u",
          password: "p",
        },
        null,
      ),
    ).toThrow(/not an IP address/)
  })

  it("keeps a saved credential left blank, for the same service only", () => {
    expect(
      parseDdnsInput(
        { provider: "duckdns", subdomain: "other", token: "" },
        duck,
      ),
    ).toEqual({ provider: "duckdns", subdomain: "other", token: "duck-token" })

    expect(() =>
      parseDdnsInput(
        {
          provider: "cloudflare",
          zone: "example.com",
          record: "pcp",
          apiToken: "",
        },
        duck,
      ),
    ).toThrow(/API token/)
  })

  it("makes a Cloudflare name full", () => {
    const input = {
      provider: "cloudflare",
      zone: "Example.com",
      apiToken: "cf",
    }

    expect(parseDdnsInput({ ...input, record: "pcp" }, null)).toMatchObject({
      zone: "example.com",
      record: "pcp.example.com",
    })
    expect(parseDdnsInput({ ...input, record: "@" }, null)).toMatchObject({
      record: "example.com",
    })
    expect(
      parseDdnsInput({ ...input, record: "pcp.example.com" }, null),
    ).toMatchObject({ record: "pcp.example.com" })
  })

  it("strips a scheme and path from a dyndns2 server", () => {
    expect(
      parseDdnsInput(
        {
          provider: "dyndns2",
          server: "https://members.example.com/nic/update",
          hostname: "pcp.example.com",
          username: "u",
          password: "p",
        },
        null,
      ),
    ).toMatchObject({ server: "members.example.com" })
  })

  it("wants an http(s) update address", () => {
    expect(() =>
      parseDdnsInput(
        { provider: "custom", url: "ftp://example.com/{ip}" },
        null,
      ),
    ).toThrow(/https:\/\//)
  })

  it("names the host HTTPS can use", () => {
    expect(ddnsHostname(duck)).toBe("my-house.duckdns.org")
    expect(
      ddnsHostname({ provider: "custom", url: "https://x", hostname: "" }),
    ).toBe(null)
  })

  it("never shows a credential back", () => {
    const view = ddnsView({
      provider: "custom",
      url: "https://user:secret@example.com/update?token=abc&ip={ip}",
      hostname: "pcp.example.com",
    })

    expect(JSON.stringify(view)).not.toMatch(/secret|abc/)
    expect(view?.urlHost).toBe("example.com")
    expect(JSON.stringify(ddnsView(duck))).not.toContain("duck-token")
  })
})

describe("the public address", () => {
  it("accepts public IPv4 only", () => {
    expect(parsePublicIpv4(" 203.0.113.7\n")).toBe("203.0.113.7")

    for (const ip of [
      "192.168.1.2",
      "10.0.0.1",
      "172.20.0.1",
      "100.64.1.1",
      "127.0.0.1",
      "::1",
      "<html>",
    ]) {
      expect(parsePublicIpv4(ip)).toBeNull()
    }
  })

  it("asks the next service when one fails", async () => {
    const { fetchFn } = fakeFetch({
      "https://a.example": text("", 500),
      "https://b.example": text("<html>oops</html>"),
      "https://c.example": text("198.51.100.4"),
    })

    expect(
      await lookupPublicIp(fetchFn, [
        "https://a.example",
        "https://b.example",
        "https://c.example",
      ]),
    ).toBe("198.51.100.4")
    expect(await lookupPublicIp(fetchFn, ["https://none.example"])).toBeNull()
  })
})

describe("what each service is sent", () => {
  it("DuckDNS: the name, token and address, read verbosely", async () => {
    const { fetchFn, calls } = fakeFetch({
      "https://www.duckdns.org/update": text("OK\n203.0.113.7\n\nUPDATED"),
    })

    expect(await sendDdnsUpdate(duck, "203.0.113.7", fetchFn)).toEqual({
      ok: true,
      ip: "203.0.113.7",
    })

    const url = new URL(calls[0].url)
    expect(url.searchParams.get("domains")).toBe("my-house")
    expect(url.searchParams.get("token")).toBe("duck-token")
    expect(url.searchParams.get("ip")).toBe("203.0.113.7")
    expect(header(calls[0], "user-agent")).toMatch(/^PCP\//)
  })

  it("DuckDNS: KO stops", () => {
    expect(readDuckDnsAnswer("KO")).toMatchObject({ ok: false, hard: true })
  })

  it("dyndns2: basic auth, myip, and the answers", async () => {
    const { fetchFn, calls } = fakeFetch({
      "https://dynupdate.no-ip.com/nic/update": text("nochg 203.0.113.7"),
    })
    const config: DdnsConfig = {
      provider: "dyndns2",
      server: "dynupdate.no-ip.com",
      hostname: "pcp.ddns.net",
      username: "me",
      password: "pw",
    }

    expect(await sendDdnsUpdate(config, "203.0.113.7", fetchFn)).toEqual({
      ok: true,
      ip: "203.0.113.7",
    })
    const url = new URL(calls[0].url)
    expect(url.searchParams.get("hostname")).toBe("pcp.ddns.net")
    expect(url.searchParams.get("myip")).toBe("203.0.113.7")
    expect(header(calls[0], "authorization")).toBe(
      `Basic ${Buffer.from("me:pw").toString("base64")}`,
    )

    // Without an address the service sees it itself.
    await sendDdnsUpdate(config, null, fetchFn)
    expect(new URL(calls[1].url).searchParams.has("myip")).toBe(false)

    expect(readDyndns2Answer("badauth")).toMatchObject({
      ok: false,
      hard: true,
    })
    expect(readDyndns2Answer("abuse")).toMatchObject({ ok: false, hard: true })
    expect(readDyndns2Answer("911")).toMatchObject({ ok: false, hard: false })
  })

  it("dyndns2: HTTP 401 is a refused login", async () => {
    const { fetchFn } = fakeFetch({ "https://api.dynu.com": text("", 401) })

    expect(
      await sendDdnsUpdate(
        {
          provider: "dyndns2",
          server: "api.dynu.com",
          hostname: "pcp.example.com",
          username: "me",
          password: "wrong",
        },
        "203.0.113.7",
        fetchFn,
      ),
    ).toMatchObject({ ok: false, hard: true })
  })

  it("custom: the template filled, a login moved to a header", () => {
    const { url, headers } = customRequest(
      {
        provider: "custom",
        url: "https://us%40er:p%3Ass@example.com/u?h={hostname}&ip={ip}",
        hostname: "pcp.example.com",
      },
      "203.0.113.7",
    )

    expect(url).toBe("https://example.com/u?h=pcp.example.com&ip=203.0.113.7")
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("us@er:p:ss").toString("base64")}`,
    )
  })

  it("custom: 2xx works, 403 stops, 500 waits", async () => {
    const config: DdnsConfig = {
      provider: "custom",
      url: "https://example.com/u?ip={ip}",
      hostname: "",
    }

    for (const [status, expected] of [
      [200, { ok: true }],
      [403, { ok: false, hard: true }],
      [500, { ok: false, hard: false }],
    ] as const) {
      const { fetchFn } = fakeFetch({ "https://example.com": text("", status) })
      expect(
        await sendDdnsUpdate(config, "203.0.113.7", fetchFn),
      ).toMatchObject(expected)
    }
  })

  it("Cloudflare: finds the zone and record, and changes only the address", async () => {
    const api = "https://api.cloudflare.com/client/v4"
    const json = (result: unknown) => () =>
      Response.json({ success: true, result })
    const { fetchFn, calls } = fakeFetch({
      [`${api}/zones?name=`]: json([{ id: "z1" }]),
      [`${api}/zones/z1/dns_records?`]: json([
        { id: "r1", content: "198.51.100.1" },
      ]),
      [`${api}/zones/z1/dns_records/r1`]: json({}),
    })
    const config: DdnsConfig = {
      provider: "cloudflare",
      apiToken: "cf-token",
      zone: "example.com",
      record: "pcp.example.com",
    }

    expect(await sendDdnsUpdate(config, "203.0.113.7", fetchFn)).toEqual({
      ok: true,
      ip: "203.0.113.7",
    })
    const patch = calls[2]
    expect(patch.init?.method).toBe("PATCH")
    expect(JSON.parse(String(patch.init?.body))).toEqual({
      content: "203.0.113.7",
    })
    expect(header(patch, "authorization")).toBe("Bearer cf-token")
  })

  it("Cloudflare: makes the record when there is none, refuses a bad token", async () => {
    const api = "https://api.cloudflare.com/client/v4"
    const { fetchFn, calls } = fakeFetch({
      [`${api}/zones?name=`]: () =>
        Response.json({ success: true, result: [{ id: "z1" }] }),
      [`${api}/zones/z1/dns_records?`]: () =>
        Response.json({ success: true, result: [] }),
      [`${api}/zones/z1/dns_records`]: () =>
        Response.json({ success: true, result: {} }),
    })
    const config: DdnsConfig = {
      provider: "cloudflare",
      apiToken: "cf-token",
      zone: "example.com",
      record: "pcp.example.com",
    }

    expect(await sendDdnsUpdate(config, "203.0.113.7", fetchFn)).toMatchObject({
      ok: true,
    })
    expect(calls[2].init?.method).toBe("POST")
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({
      type: "A",
      name: "pcp.example.com",
      proxied: false,
    })

    const refused = fakeFetch({ [api]: text("", 403) })
    expect(
      await sendDdnsUpdate(config, "203.0.113.7", refused.fetchFn),
    ).toMatchObject({ ok: false, hard: true })
  })

  it("a network failure is worth another try", async () => {
    const { fetchFn } = fakeFetch({})
    expect(await sendDdnsUpdate(duck, "203.0.113.7", fetchFn)).toMatchObject({
      ok: false,
      hard: false,
    })
  })
})

describe("when an update is due", () => {
  const now = new Date("2026-10-01T12:00:00Z")
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()
  const duckOk = {
    ...ipService,
    "https://www.duckdns.org/update": text("OK\n203.0.113.7\n\nUPDATED"),
  }

  it("sends when the address changed, not when it did not", async () => {
    const { fetchFn, calls } = fakeFetch(duckOk)
    const changed = await runDdnsRound({
      config: duck,
      status: { lastIp: "198.51.100.1", lastUpdatedAt: ago(60_000) },
      now,
      fetchFn,
    })

    expect(changed).toMatchObject({
      lastIp: "203.0.113.7",
      lastUpdatedAt: now.toISOString(),
    })
    expect(calls.filter((c) => c.url.includes("duckdns"))).toHaveLength(1)

    const same = await runDdnsRound({
      config: duck,
      status: changed,
      now,
      fetchFn,
    })
    expect(same.lastUpdatedAt).toBe(now.toISOString())
    expect(calls.filter((c) => c.url.includes("duckdns"))).toHaveLength(1)
  })

  it("refreshes an unchanged address once a day, and always on a save", async () => {
    const { fetchFn, calls } = fakeFetch(duckOk)
    const status = {
      lastIp: "203.0.113.7",
      lastUpdatedAt: ago(DDNS_REFRESH_MS),
    }

    await runDdnsRound({ config: duck, status, now, fetchFn })
    await runDdnsRound({
      config: duck,
      status: { ...status, lastUpdatedAt: ago(1000) },
      now,
      force: true,
      fetchFn,
    })
    expect(calls.filter((c) => c.url.includes("duckdns"))).toHaveLength(2)
  })

  it("backs off after a failure and stops after a refused login", async () => {
    const failing = fakeFetch({
      ...ipService,
      "https://www.duckdns.org/update": text("", 502),
    })
    const first = await runDdnsRound({
      config: duck,
      status: {},
      now,
      fetchFn: failing.fetchFn,
    })

    expect(first.failures).toBe(1)
    expect(Date.parse(first.nextAttemptAt!) - now.getTime()).toBe(5 * 60_000)

    // Not before the wait is over.
    const waiting = await runDdnsRound({
      config: duck,
      status: first,
      now: new Date(now.getTime() + 60_000),
      fetchFn: failing.fetchFn,
    })
    expect(waiting.failures).toBe(1)

    const refused = fakeFetch({
      ...ipService,
      "https://www.duckdns.org/update": text("KO"),
    })
    const stopped = await runDdnsRound({
      config: duck,
      status: {},
      now,
      fetchFn: refused.fetchFn,
    })
    expect(stopped.stopped).toMatch(/DuckDNS refused/)

    await runDdnsRound({
      config: duck,
      status: stopped,
      now: new Date(now.getTime() + DDNS_REFRESH_MS),
      fetchFn: refused.fetchFn,
    })
    expect(refused.calls.filter((c) => c.url.includes("duckdns"))).toHaveLength(
      1,
    )
  })

  it("without the address, updates services that see it themselves, hourly", async () => {
    const { fetchFn, calls } = fakeFetch({
      "https://www.duckdns.org/update": text("OK\n203.0.113.7\n\nUPDATED"),
    })

    const blind = await runDdnsRound({ config: duck, status: {}, now, fetchFn })
    expect(blind.lastIp).toBe("203.0.113.7")
    expect(new URL(calls.at(-1)!.url).searchParams.get("ip")).toBe("")

    await runDdnsRound({
      config: duck,
      status: { ...blind, lastUpdatedAt: ago(DDNS_BLIND_INTERVAL_MS - 1000) },
      now,
      fetchFn,
    })
    expect(calls.filter((c) => c.url.includes("duckdns"))).toHaveLength(1)

    const cloudflare = await runDdnsRound({
      config: {
        provider: "cloudflare",
        apiToken: "t",
        zone: "example.com",
        record: "example.com",
      },
      status: {},
      now,
      fetchFn,
    })
    expect(cloudflare.lastError).toMatch(/public address/)
  })
})

describe("stored settings", () => {
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ cleanup } = await scratchDatabase())
  })

  afterEach(async () => {
    await cleanup()
  })

  it("a save starts the status over and lifts a stop", async () => {
    await saveDdnsConfig({
      provider: "duckdns",
      subdomain: "my-house",
      token: TOKEN,
    })
    await saveDdnsStatus({ stopped: "refused", lastIp: "203.0.113.7" })

    await saveDdnsConfig({
      provider: "duckdns",
      subdomain: "my-house",
      token: "",
    })

    expect(await getDdnsConfig()).toEqual({
      provider: "duckdns",
      subdomain: "my-house",
      token: TOKEN,
    })
    expect(await getDdnsStatus()).toEqual({})
  })
})
