import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import http from "node:http"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import tls from "node:tls"
import { setTimeout as sleep } from "node:timers/promises"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  startConnector,
  type Connector,
  type ConnectorStatus,
} from "./connector"
import type { Authorization, Directory } from "./test-relay/directory"
import { createRelay, type Relay } from "./test-relay/relay"

/**
 * The whole path: an assistant's TLS connection to alice.pcp.test reaches a
 * stand-in for PCP through the relay and the connector, and the relay's
 * side of it never holds a readable byte.
 */

const NAME = "alice.pcp.test"
const KEY = "pcpgg_test_key_alice"
const SECRET = "the-owner's-private-data-1234567890"

function makeCertificate() {
  const dir = mkdtempSync(path.join(tmpdir(), "pcpgg-cert-"))
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      path.join(dir, "key.pem"),
      "-out",
      path.join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      `/CN=${NAME}`,
      "-addext",
      `subjectAltName=DNS:${NAME}`,
    ],
    { stdio: "ignore" },
  )
  return {
    key: readFileSync(path.join(dir, "key.pem")),
    cert: readFileSync(path.join(dir, "cert.pem")),
  }
}

class FakeDirectory implements Directory {
  keys = new Map<string, Authorization>([
    [KEY, { deviceId: "dev_alice", hostnames: [NAME], generation: 1 }],
  ])
  revoked = new Set<string>()
  reports: string[][] = []

  async authorize(token: string) {
    return this.keys.get(token) ?? null
  }

  async report(online: { deviceId: string }[]) {
    this.reports.push(online.map((tunnel) => tunnel.deviceId))
    return {
      disconnect: online
        .map((tunnel) => tunnel.deviceId)
        .filter((id) => this.revoked.has(id)),
    }
  }
}

const listen = (server: net.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as net.AddressInfo).port),
    ),
  )

async function waitFor<T>(check: () => T | undefined | false, ms = 5000) {
  const deadline = Date.now() + ms

  while (Date.now() < deadline) {
    const value = check()

    if (value) {
      return value
    }

    await sleep(20)
  }

  throw new Error("Timed out")
}

function get(port: number, target: string, host = NAME) {
  return new Promise<{ status: number; body: string; location?: string }>(
    (resolve, reject) => {
      const request = http.request(
        { host: "127.0.0.1", port, path: target, headers: { Host: host } },
        (response) => {
          let body = ""
          response.on("data", (chunk) => (body += chunk))
          response.on("end", () =>
            resolve({
              status: response.statusCode!,
              body,
              location: response.headers.location,
            }),
          )
        },
      )
      request.on("error", reject)
      request.end()
    },
  )
}

describe("relay and connector", () => {
  const certificate = makeCertificate()
  const directory = new FakeDirectory()
  const challengeRequests: string[] = []
  let relay: Relay
  let connector: Connector
  let status: ConnectorStatus
  let httpsPort: number
  let httpPort: number
  let tunnelPort: number
  let pcpHttps: tls.Server
  let pcpHttp: http.Server
  /** Every byte that went into the relay's HTTPS port, as the relay saw it. */
  const wire: Buffer[] = []
  let tapPort: number
  let tap: net.Server

  beforeAll(async () => {
    // The stand-in for PCP's HTTPS listener: echoes, prefixed.
    pcpHttps = tls.createServer(certificate, (socket) => {
      socket.on("data", (chunk) => socket.write(Buffer.concat([chunk])))
      socket.on("end", () => socket.end())
    })
    const pcpHttpsPort = await listen(pcpHttps)

    // The stand-in for PCP's port 80, which answers ACME challenges.
    pcpHttp = http.createServer((request, response) => {
      challengeRequests.push(`${request.method} ${request.url}`)
      response.end("token.thumbprint")
    })
    const pcpHttpPort = await listen(pcpHttp)

    relay = createRelay({
      directory,
      reportIntervalMs: 100,
      pingIntervalMs: 1000,
    })
    httpsPort = await listen(relay.httpsServer)
    httpPort = await listen(relay.httpServer)
    tunnelPort = await listen(relay.tunnelServer)

    // A tap in front of the relay's HTTPS port, keeping what passes.
    tap = net.createServer((client) => {
      const upstream = net.connect(httpsPort, "127.0.0.1")
      client.on("data", (chunk) => wire.push(chunk))
      upstream.on("data", (chunk) => wire.push(chunk))
      client.pipe(upstream).pipe(client)
      client.on("error", () => upstream.destroy())
      upstream.on("error", () => client.destroy())
    })
    tapPort = await listen(tap)

    connector = startConnector({
      key: KEY,
      relayUrl: `ws://127.0.0.1:${tunnelPort}/v1/connect`,
      https: { host: "127.0.0.1", port: pcpHttpsPort },
      http: { host: "127.0.0.1", port: pcpHttpPort },
      onStatus: (next) => (status = next),
      backoff: { firstMs: 50, maxMs: 200 },
    })

    await waitFor(() => status?.state === "online")
  })

  afterAll(async () => {
    await connector?.stop()
    await relay?.close()
    pcpHttps?.close()
    pcpHttp?.close()
    tap?.close()
  })

  const connectTls = (port = tapPort, servername = NAME) =>
    tls.connect({ host: "127.0.0.1", port, servername, ca: certificate.cert })

  it("comes online with its name", () => {
    expect(status.hostnames).toEqual([NAME])
    expect(relay.hostnames()).toEqual([NAME])
  })

  it("carries TLS end to end, and the relay sees only ciphertext", async () => {
    const socket = connectTls()
    await new Promise((resolve) => socket.once("secureConnect", resolve))
    expect(socket.authorized).toBe(true)

    socket.write(SECRET)
    const [echo] = await Promise.all([
      new Promise<string>((resolve) =>
        socket.once("data", (chunk) => resolve(chunk.toString())),
      ),
    ])
    expect(echo).toBe(SECRET)
    socket.end()

    const seen = Buffer.concat(wire)
    expect(seen.length).toBeGreaterThan(SECRET.length)
    expect(seen.includes(Buffer.from(SECRET))).toBe(false)
    // The name, sent in the clear in the ClientHello, is all it can read.
    expect(seen.includes(Buffer.from(NAME))).toBe(true)
  })

  it("moves a few megabytes both ways intact", async () => {
    const socket = connectTls(httpsPort)
    await new Promise((resolve) => socket.once("secureConnect", resolve))
    const payload = Buffer.alloc(4 * 1024 * 1024, 7)
    const received: Buffer[] = []
    let total = 0
    const done = new Promise<void>((resolve) =>
      socket.on("data", (chunk) => {
        received.push(chunk)
        total += chunk.length

        if (total >= payload.length) {
          resolve()
        }
      }),
    )
    socket.write(payload)
    await done
    expect(Buffer.concat(received).equals(payload)).toBe(true)
    socket.destroy()
  })

  it("refuses a name that is not online", async () => {
    const socket = connectTls(httpsPort, "bob.pcp.test")
    const error = await new Promise<Error>((resolve) =>
      socket.once("error", resolve),
    )
    expect(error.message).toMatch(
      /unrecognized name|socket hang up|ECONNRESET/i,
    )
  })

  it("redirects plain HTTP to HTTPS without reaching PCP", async () => {
    const response = await get(httpPort, "/login?x=1")
    expect(response.status).toBe(308)
    expect(response.location).toBe(`https://${NAME}/login?x=1`)
    expect(challengeRequests).toEqual([])
  })

  it("passes Let's Encrypt's challenge to PCP", async () => {
    const response = await get(
      httpPort,
      "/.well-known/acme-challenge/abc_DEF-123",
    )
    expect(response).toMatchObject({
      status: 200,
      body: "token.thumbprint",
    })
    expect(challengeRequests).toEqual([
      "GET /.well-known/acme-challenge/abc_DEF-123",
    ])
  })

  it("drops the tunnel when pcp.gg revokes the key", async () => {
    directory.revoked.add("dev_alice")
    await waitFor(() => status.state === "unauthorized")
    expect(status.lastError).toMatch(/replaced or removed/)
    expect(relay.hostnames()).toEqual([])
  })
})

describe("a connector with a key pcp.gg does not know", () => {
  it("stops instead of retrying", async () => {
    const relay = createRelay({ directory: new FakeDirectory() })
    const port = await listen(relay.tunnelServer)
    let status: ConnectorStatus | undefined
    const connector = startConnector({
      key: "pcpgg_wrong",
      relayUrl: `ws://127.0.0.1:${port}/v1/connect`,
      https: { host: "127.0.0.1", port: 1 },
      http: { host: "127.0.0.1", port: 1 },
      onStatus: (next) => (status = next),
    })
    await waitFor(() => status?.state === "unauthorized")
    expect(status?.lastError).toMatch(/did not accept/)
    await connector.stop()
    await relay.close()
  })
})
