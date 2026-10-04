import { statSync } from "node:fs"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { scratchDatabase } from "../test-db"
import type { DdnsConfig } from "./ddns"
import { selfSignedCertificate } from "./test-certificate"
import {
  checkDns,
  type Issuer,
  needsRenewal,
  parseTlsInput,
  readCertificate,
  runTlsRound,
  type TlsConfig,
  tlsDir,
  tlsDomain,
  type TlsStatus,
  writeCertificate,
} from "./tls"

// HTTPS: what the form accepts, when a certificate is renewed, and one
// round of getting one with a fake Let's Encrypt.

const now = new Date("2026-10-01T12:00:00Z")
const duck: DdnsConfig = {
  provider: "duckdns",
  subdomain: "pcp-me",
  token: "t",
}
const input = { domain: "", useDdnsName: false, email: "", agreed: true }

describe("reading the form", () => {
  it("needs the agreement accepted", () => {
    expect(() =>
      parseTlsInput(
        { ...input, domain: "pcp.example.com", agreed: false },
        null,
        now,
      ),
    ).toThrow(/agreement/)
  })

  it("takes a typed name, or the dynamic DNS one", () => {
    const typed = parseTlsInput(
      { ...input, domain: "PCP.Example.com" },
      null,
      now,
    )
    expect(typed.domain).toBe("pcp.example.com")
    expect(tlsDomain(typed, duck)).toBe("pcp.example.com")

    const fromDdns = parseTlsInput({ ...input, useDdnsName: true }, duck, now)
    expect(fromDdns.domain).toBeNull()
    expect(tlsDomain(fromDdns, duck)).toBe("pcp-me.duckdns.org")
    expect(tlsDomain(fromDdns, null)).toBeNull()

    expect(() =>
      parseTlsInput({ ...input, useDdnsName: true }, null, now),
    ).toThrow(/dynamic DNS/)
  })

  it("refuses addresses and names Let's Encrypt will not sign", () => {
    for (const domain of [
      "203.0.113.7",
      "localhost",
      "nas.local",
      "*.example.com",
    ]) {
      expect(() => parseTlsInput({ ...input, domain }, null, now)).toThrow()
    }
    expect(() =>
      parseTlsInput(
        { ...input, domain: "pcp.example.com", email: "nope" },
        null,
        now,
      ),
    ).toThrow(/email/)
  })
})

describe("renewal", () => {
  const cert = (from: string, to: string) => ({
    key: "",
    cert: "",
    notBefore: new Date(from),
    notAfter: new Date(to),
  })

  it("renews in the last third of the certificate's life", () => {
    const ninetyDays = cert("2026-09-01T00:00:00Z", "2026-11-30T00:00:00Z")
    expect(needsRenewal(ninetyDays, new Date("2026-10-30T00:00:00Z"))).toBe(
      false,
    )
    expect(needsRenewal(ninetyDays, new Date("2026-11-01T00:00:00Z"))).toBe(
      true,
    )

    const sixDays = cert("2026-10-01T00:00:00Z", "2026-10-07T00:00:00Z")
    expect(needsRenewal(sixDays, new Date("2026-10-04T00:00:00Z"))).toBe(false)
    expect(needsRenewal(sixDays, new Date("2026-10-05T01:00:00Z"))).toBe(true)
  })
})

describe("advice before asking", () => {
  it("says when the name points elsewhere or nowhere", async () => {
    expect(
      await checkDns("pcp.example.com", "203.0.113.7", async () => [
        "203.0.113.7",
      ]),
    ).toBeUndefined()
    expect(
      await checkDns("pcp.example.com", "203.0.113.7", async () => [
        "198.51.100.1",
      ]),
    ).toMatch(/points at 198\.51\.100\.1/)
    expect(
      await checkDns("pcp.example.com", undefined, async () => {
        throw new Error("ENOTFOUND")
      }),
    ).toMatch(/does not have an address/)
  })
})

describe("a round", () => {
  let cleanup: () => Promise<void>
  const domain = "pcp.example.com"
  const config: TlsConfig = { domain, email: null, agreedAt: now.toISOString() }
  const resolve4 = async () => ["203.0.113.7"]

  beforeEach(async () => {
    ;({ cleanup } = await scratchDatabase())
  })

  afterEach(async () => {
    await cleanup()
  })

  function issuer(result: "ok" | Error) {
    const calls: string[] = []
    const issue: Issuer = async ({ domain, challenges }) => {
      calls.push(domain)
      challenges.set("token", "answer")
      if (result instanceof Error) throw result
      return selfSignedCertificate(domain)
    }
    return { issue, calls }
  }

  const round = (
    issue: Issuer,
    status: TlsStatus = {},
    extra: Partial<Parameters<typeof runTlsRound>[0]> = {},
  ) =>
    runTlsRound({
      domain,
      config,
      status,
      now,
      issue,
      challenges: new Map(),
      resolve4,
      ...extra,
    })

  it("gets a certificate and keeps it readable by PCP alone", async () => {
    const { issue, calls } = issuer("ok")
    const told: TlsStatus[] = []
    const { status, certificate } = await round(
      issue,
      {},
      {
        // The real clock: the certificate openssl makes starts now.
        now: new Date(),
        onIssuing: async (issuing) => void told.push(issuing),
      },
    )

    expect(calls).toEqual([domain])
    expect(told[0]).toMatchObject({ state: "issuing", domain })
    expect(status).toMatchObject({ state: "active", domain })
    expect(certificate?.cert).toContain("BEGIN CERTIFICATE")
    expect(statSync(path.join(tlsDir(), domain, "key.pem")).mode & 0o777).toBe(
      0o600,
    )

    // The next round serves the saved one without asking.
    await round(issue, status, { now: new Date() })
    expect(calls).toHaveLength(1)
  })

  it("waits longer after each failure, unless told to try now", async () => {
    const { issue, calls } = issuer(new Error("Timeout during connect"))
    const first = await round(issue)

    expect(first.status.state).toBe("failed")
    expect(first.status.lastError).toMatch(/port 80/)
    expect(Date.parse(first.status.nextAttemptAt!) - now.getTime()).toBe(
      3_600_000,
    )

    await round(issue, first.status)
    expect(calls).toHaveLength(1)

    const second = await round(issue, first.status, { force: true })
    expect(calls).toHaveLength(2)
    expect(Date.parse(second.status.nextAttemptAt!) - now.getTime()).toBe(
      2 * 3_600_000,
    )
  })

  it("keeps serving a working certificate while renewal fails", async () => {
    const { key, cert } = selfSignedCertificate(domain, 3)
    writeCertificate(domain, key, cert)
    const saved = readCertificate(domain)!
    const late = new Date(saved.notAfter.getTime() - 12 * 3_600_000)

    const { status, certificate } = await round(
      issuer(new Error("rate limited")).issue,
      {},
      { now: late },
    )

    expect(status.state).toBe("active")
    expect(status.lastError).toMatch(/rate limited/)
    expect(certificate?.cert).toBe(cert)
  })

  it("starts over for a different name, and fails without one", async () => {
    const { issue, calls } = issuer("ok")
    await round(
      issue,
      {
        domain: "old.example.com",
        nextAttemptAt: new Date(now.getTime() + 1e7).toISOString(),
      },
      { now: new Date() },
    )
    expect(calls).toEqual([domain])

    const nameless = await round(issue, {}, { domain: null })
    expect(nameless.status).toMatchObject({ state: "failed" })
    expect(nameless.status.lastError).toMatch(/no name/)
  })

  it("does not take a certificate for another name", () => {
    const { key, cert } = selfSignedCertificate("other.example.com")
    writeCertificate(domain, key, cert)
    expect(readCertificate(domain)).toBeNull()
  })
})
