import { mkdtempSync, rmSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import tls from "node:tls"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ACME_TLS_PROTOCOL, Edge } from "./edge"
import { selfSignedCertificate } from "./test-certificate"
import { acmeIssuer, type ChallengeStore, challengeStore } from "./tls"

// acmeIssuer's part between acme-client and the edge: which challenge it
// answers, in which order, where the answer goes, that it is taken away
// again, and when it tries the other one. acme-client's Client is a
// stand-in that validates the way Let's Encrypt would, against a real edge.

type Challenge = { type: string; token: string; url: string }
type Authz = { identifier: { type: "dns"; value: string } }
type AutoOptions = {
  challengePriority: string[]
  challengeCreateFn: (
    authz: Authz,
    challenge: Challenge,
    keyAuthorization: string,
  ) => Promise<void>
  challengeRemoveFn: (
    authz: Authz,
    challenge: Challenge,
    keyAuthorization: string,
  ) => Promise<void>
}

const ca: {
  /** What the stand-in does after a challenge is out; throws to refuse. */
  validate: (type: string, keyAuthorization: string) => Promise<void>
  /** Set to fail before any challenge, like a directory out of reach. */
  unreachable: boolean
  offered: string[]
  attempts: string[]
} = vi.hoisted(() => ({
  validate: async () => {},
  unreachable: false,
  offered: [],
  attempts: [],
}))

vi.mock("acme-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("acme-client")>()

  class Client {
    async auto(options: AutoOptions): Promise<string> {
      if (ca.unreachable) {
        throw new Error("connect ECONNREFUSED")
      }

      const authz: Authz = { identifier: { type: "dns", value: DOMAIN } }
      // acme-client's choice: the first offered by priority, else any.
      const challenge = ca.offered
        .map((type) => ({ type, token: `tok-${type}`, url: "" }))
        .sort((a, b) => {
          const ai = options.challengePriority.indexOf(a.type)
          const bi = options.challengePriority.indexOf(b.type)
          if (ai === -1) return 1
          if (bi === -1) return -1
          return ai - bi
        })[0]!
      ca.attempts.push(challenge.type)
      const keyAuthorization = `${challenge.token}.thumbprint`

      try {
        await options.challengeCreateFn(authz, challenge, keyAuthorization)
        await ca.validate(challenge.type, keyAuthorization)
      } finally {
        await options.challengeRemoveFn(authz, challenge, keyAuthorization)
      }

      return selfSignedCertificate(DOMAIN).cert
    }
  }

  // acme-client is CommonJS: the import may come through `default`.
  const fallback = (actual as { default?: object }).default ?? actual
  return { ...actual, Client, default: { ...fallback, Client } }
})

const DOMAIN = "alice.pcp.test"
const saved = { ...process.env }
let dir: string
let app: http.Server
let edge: Edge
let challenges: ChallengeStore

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "pcp-acme-"))
  process.env.PCP_DATA_DIR = dir
  ca.validate = async () => {}
  ca.unreachable = false
  ca.offered = ["http-01", "dns-01", "tls-alpn-01"]
  ca.attempts = []
  challenges = challengeStore()
  app = http.createServer((_req, res) => res.end("app"))
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve))
  edge = new Edge({
    target: { host: "127.0.0.1", port: (app.address() as AddressInfo).port },
    challenges,
    httpPort: 0,
    httpsPort: 0,
    host: "127.0.0.1",
  })
  await edge.start(DOMAIN)
})

afterEach(async () => {
  await edge.stop()
  await new Promise((resolve) => app.close(resolve))
  process.env = { ...saved }
  rmSync(dir, { recursive: true, force: true })
})

/** Let's Encrypt's TLS-ALPN-01 check: acme-tls/1 alone, then the hash. */
async function validateTlsAlpn(keyAuthorization: string): Promise<void> {
  const acme = await import("acme-client")
  const cert = await new Promise<string>((resolve, reject) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      port: edge.boundPorts().https!,
      servername: DOMAIN,
      ALPNProtocols: [ACME_TLS_PROTOCOL],
      rejectUnauthorized: false,
    })
    socket.once("secureConnect", () => {
      if (socket.alpnProtocol !== ACME_TLS_PROTOCOL) {
        reject(new Error("acme-tls/1 was not negotiated"))
      } else {
        resolve(socket.getPeerX509Certificate()!.toString())
      }
      socket.destroy()
    })
    socket.once("error", reject)
  })

  if (
    !acme.crypto.isAlpnCertificateAuthorizationValid(cert, keyAuthorization)
  ) {
    throw new Error("Incorrect validation certificate for tls-alpn-01")
  }
}

/** Let's Encrypt's HTTP-01 check, against port 80. */
function validateHttp(type: string, keyAuthorization: string): Promise<void> {
  return new Promise((resolve, reject) => {
    http
      .get(
        {
          host: "127.0.0.1",
          port: edge.boundPorts().http!,
          path: `/.well-known/acme-challenge/tok-${type}`,
        },
        (res) => {
          let body = ""
          res.on("data", (chunk) => (body += chunk))
          res.on("end", () =>
            body === keyAuthorization
              ? resolve()
              : reject(new Error(`Invalid response: ${res.statusCode}`)),
          )
        },
      )
      .on("error", reject)
  })
}

const issue = (challengeTypes: ("http-01" | "tls-alpn-01")[]) =>
  acmeIssuer({ domain: DOMAIN, email: null, challenges, challengeTypes })

describe("acmeIssuer", () => {
  it("answers TLS-ALPN-01 on port 443 for a pcp.gg name, and takes it away", async () => {
    ca.validate = async (type, keyAuthorization) => {
      expect(type).toBe("tls-alpn-01")
      expect([...challenges.tlsAlpn.keys()]).toEqual([DOMAIN])
      await validateTlsAlpn(keyAuthorization)
    }

    const { cert } = await issue(["tls-alpn-01", "http-01"])
    expect(cert).toContain("BEGIN CERTIFICATE")
    expect(ca.attempts).toEqual(["tls-alpn-01"])
    expect(challenges.tlsAlpn.size).toBe(0)
    expect(challenges.http.size).toBe(0)
  })

  it("answers HTTP-01 on port 80 for a home server's name", async () => {
    ca.validate = async (type, keyAuthorization) =>
      validateHttp(type, keyAuthorization)

    await issue(["http-01", "tls-alpn-01"])
    expect(ca.attempts).toEqual(["http-01"])
    expect(challenges.http.size).toBe(0)
  })

  it("tries TLS-ALPN-01 once when port 80 does not answer", async () => {
    ca.validate = async (type, keyAuthorization) => {
      if (type === "http-01") {
        // Port 80 not forwarded, or a proxy answering 404.
        throw new Error("Invalid response from the challenge: 404")
      }
      await validateTlsAlpn(keyAuthorization)
    }

    await issue(["http-01", "tls-alpn-01"])
    expect(ca.attempts).toEqual(["http-01", "tls-alpn-01"])
    expect(challenges.http.size + challenges.tlsAlpn.size).toBe(0)
  })

  it("reports the first failure when neither works", async () => {
    ca.validate = async (type) => {
      throw new Error(`${type} failed`)
    }

    await expect(issue(["tls-alpn-01", "http-01"])).rejects.toThrow(
      "tls-alpn-01 failed",
    )
    expect(ca.attempts).toEqual(["tls-alpn-01", "http-01"])
    expect(challenges.http.size + challenges.tlsAlpn.size).toBe(0)
  })

  it("does not ask again when it never got to a challenge", async () => {
    ca.unreachable = true

    await expect(issue(["http-01", "tls-alpn-01"])).rejects.toThrow(
      /ECONNREFUSED/,
    )
    expect(ca.attempts).toEqual([])
  })

  it("answers only the challenge it asked for, then tries the next", async () => {
    ca.offered = ["dns-01", "tls-alpn-01"]
    ca.validate = async (type, keyAuthorization) =>
      validateTlsAlpn(keyAuthorization)

    await issue(["http-01", "tls-alpn-01"])
    // dns-01, taken by acme-client for want of http-01, is refused.
    expect(ca.attempts).toEqual(["dns-01", "tls-alpn-01"])
  })
})
