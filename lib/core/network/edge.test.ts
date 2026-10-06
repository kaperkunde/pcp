import crypto from "node:crypto"
import http from "node:http"
import https from "node:https"
import type { AddressInfo } from "node:net"
import tls from "node:tls"

import acme from "acme-client"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ACME_TLS_PROTOCOL, Edge, listenError } from "./edge"
import { selfSignedCertificate } from "./test-certificate"
import {
  alpnCertificate,
  type Certificate,
  type ChallengeStore,
  challengeStore,
} from "./tls"

// The listeners PCP opens for HTTPS, against a stand-in for the app: what
// they forward, the challenge answers (HTTP-01 on port 80, TLS-ALPN-01 on
// 443), the redirect, and a port in use.

const domain = "pcp.example.com"

type Seen = { headers: http.IncomingHttpHeaders; url?: string }

let app: http.Server
let appPort: number
let seen: Seen[]
let edge: Edge | null
let challenges: ChallengeStore

beforeEach(async () => {
  seen = []
  challenges = challengeStore()
  edge = null
  app = http.createServer((req, res) => {
    seen.push({ headers: req.headers, url: req.url })

    if (req.url === "/stream") {
      // A server-sent event stream that stays open, like MCP's.
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write("data: first\n\n")
      return
    }

    res.setHeader("set-cookie", ["a=1", "b=2"])
    res.end(`app saw ${req.method} ${req.url}`)
  })
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve))
  appPort = (app.address() as AddressInfo).port
})

afterEach(async () => {
  await edge?.stop()
  app.closeAllConnections()
  await new Promise((resolve) => app.close(resolve))
})

function makeEdge() {
  edge = new Edge({
    target: { host: "127.0.0.1", port: appPort },
    challenges,
    httpPort: 0,
    httpsPort: 0,
  })
  return edge
}

function get(
  port: number,
  path: string,
  options: { headers?: http.OutgoingHttpHeaders; tls?: boolean } = {},
): Promise<{
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}> {
  const client = options.tls ? https : http

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: { host: domain, ...options.headers },
        servername: domain,
        rejectUnauthorized: false,
      },
      (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => (body += chunk))
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        )
      },
    )
    req.on("error", reject)
    req.end()
  })
}

function certificate(): Certificate {
  const { key, cert } = selfSignedCertificate(domain)
  const now = Date.now()
  return {
    key,
    cert,
    notBefore: new Date(now),
    notAfter: new Date(now + 90 * 86_400_000),
  }
}

describe("port 80", () => {
  it("answers Let's Encrypt's challenge and forwards the rest", async () => {
    const edge = makeEdge()
    await edge.start(domain)
    const port = edge.boundPorts().http!
    challenges.http.set("tok", "tok.key-authorization")

    const answer = await get(port, "/.well-known/acme-challenge/tok")
    expect(answer).toMatchObject({ status: 200, body: "tok.key-authorization" })
    expect((await get(port, "/.well-known/acme-challenge/other")).status).toBe(
      404,
    )

    const forwarded = await get(port, "/servers?x=1")
    expect(forwarded.body).toBe("app saw GET /servers?x=1")
    expect(forwarded.headers["set-cookie"]).toEqual(["a=1", "b=2"])
  })

  it("replaces what a client claims about where it came from", async () => {
    const edge = makeEdge()
    await edge.start(domain)

    await get(edge.boundPorts().http!, "/", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-for": "6.6.6.6",
        "x-forwarded-host": "evil.example.com",
        "x-real-ip": "6.6.6.6",
      },
    })

    expect(seen[0].headers).toMatchObject({
      host: domain,
      "x-forwarded-proto": "http",
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": domain,
    })
    expect(seen[0].headers["x-real-ip"]).toBeUndefined()
  })

  it("redirects to HTTPS once there is a certificate", async () => {
    const edge = makeEdge()
    await edge.start(domain)
    await edge.useCertificate(certificate())

    const answer = await get(edge.boundPorts().http!, "/mcp?a=b")
    expect(answer.status).toBe(308)
    expect(answer.headers.location).toBe(`https://${domain}/mcp?a=b`)

    // The challenge is still answered over plain HTTP, for renewals.
    challenges.http.set("renew", "renew.answer")
    expect(
      (await get(edge.boundPorts().http!, "/.well-known/acme-challenge/renew"))
        .body,
    ).toBe("renew.answer")
  })
})

describe("port 443", () => {
  it("serves the certificate, says the request was https, and streams", async () => {
    const edge = makeEdge()
    await edge.start(domain)
    await edge.useCertificate(certificate())
    const port = edge.boundPorts().https!

    const answer = await get(port, "/servers", { tls: true })
    expect(answer.body).toBe("app saw GET /servers")
    expect(seen[0].headers["x-forwarded-proto"]).toBe("https")

    // The first event arrives while the stream is still open.
    const firstEvent = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        {
          host: "127.0.0.1",
          port,
          path: "/stream",
          headers: { host: domain },
          servername: domain,
          rejectUnauthorized: false,
        },
        (res) => {
          res.setEncoding("utf8")
          res.once("data", (chunk: string) => {
            resolve(chunk)
            req.destroy()
          })
        },
      )
      req.on("error", reject)
      req.end()
    })
    expect(firstEvent).toBe("data: first\n\n")
  })

  it("takes a renewed certificate without closing", async () => {
    const edge = makeEdge()
    await edge.start(domain)
    await edge.useCertificate(certificate())
    const port = edge.boundPorts().https!

    await edge.useCertificate(certificate())
    expect(edge.boundPorts().https).toBe(port)
    expect((await get(port, "/", { tls: true })).status).toBe(200)
  })
})

/** A TLS handshake with port 443: what it negotiated and the certificate. */
function handshake(
  port: number,
  options: { servername?: string; ALPNProtocols?: string[] },
): Promise<
  | { ok: true; protocol: string | false | null; cert: string }
  | { ok: false; error: string }
> {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      port,
      servername: options.servername ?? domain,
      ALPNProtocols: options.ALPNProtocols,
      rejectUnauthorized: false,
    })
    socket.once("secureConnect", () => {
      resolve({
        ok: true,
        protocol: socket.alpnProtocol,
        cert: socket.getPeerX509Certificate()?.toString() ?? "",
      })
      socket.destroy()
    })
    socket.once("error", (error) =>
      resolve({ ok: false, error: error.message }),
    )
  })
}

describe("the TLS-ALPN-01 challenge on port 443", () => {
  const keyAuthorization = "tok.thumbprint"

  async function pending() {
    challenges.tlsAlpn.set(
      domain,
      await alpnCertificate(domain, keyAuthorization),
    )
  }

  it("is answered on acme-tls/1 before there is a certificate", async () => {
    const edge = makeEdge()
    await edge.start(domain)
    const port = edge.boundPorts().https!
    expect(port).toBeGreaterThan(0)
    await pending()

    const answer = await handshake(port, { ALPNProtocols: [ACME_TLS_PROTOCOL] })
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    expect(answer.protocol).toBe(ACME_TLS_PROTOCOL)
    // The acmeIdentifier extension carries the key authorization's hash.
    expect(
      acme.crypto.isAlpnCertificateAuthorizationValid(
        answer.cert,
        keyAuthorization,
      ),
    ).toBe(true)
    expect(new crypto.X509Certificate(answer.cert).checkHost(domain)).toBe(
      domain,
    )

    // Nothing else is served without a certificate.
    expect((await handshake(port, { ALPNProtocols: ["http/1.1"] })).ok).toBe(
      false,
    )
  })

  it("leaves every other connection the normal certificate", async () => {
    const edge = makeEdge()
    await edge.start(domain)
    const normal = certificate()
    await edge.useCertificate(normal)
    const port = edge.boundPorts().https!
    await pending()

    const isNormal = (answer: Awaited<ReturnType<typeof handshake>>) =>
      answer.ok &&
      new crypto.X509Certificate(answer.cert).fingerprint256 ===
        new crypto.X509Certificate(normal.cert).fingerprint256

    // A browser or an assistant while the challenge is out.
    expect(
      isNormal(await handshake(port, { ALPNProtocols: ["http/1.1"] })),
    ).toBe(true)
    expect(isNormal(await handshake(port, {}))).toBe(true)
    // acme-tls/1 offered beside another protocol is not Let's Encrypt.
    const mixed = await handshake(port, {
      ALPNProtocols: [ACME_TLS_PROTOCOL, "http/1.1"],
    })
    expect(mixed.ok && mixed.protocol).not.toBe(ACME_TLS_PROTOCOL)
    // Another name gets no challenge certificate.
    const other = await handshake(port, {
      servername: "other.example.com",
      ALPNProtocols: [ACME_TLS_PROTOCOL],
    })
    expect(other.ok && other.protocol).not.toBe(ACME_TLS_PROTOCOL)

    // HTTP still works through it.
    expect((await get(port, "/servers", { tls: true })).body).toBe(
      "app saw GET /servers",
    )

    // Once validated and taken away, acme-tls/1 gets nothing special.
    challenges.tlsAlpn.delete(domain)
    const after = await handshake(port, { ALPNProtocols: [ACME_TLS_PROTOCOL] })
    expect(after.ok && after.protocol).not.toBe(ACME_TLS_PROTOCOL)
    expect(
      isNormal(await handshake(port, { ALPNProtocols: ["http/1.1"] })),
    ).toBe(true)
  })

  it("closes a connection still being read when it stops", async () => {
    const edge = makeEdge()
    await edge.start(domain)
    await pending()
    const net = await import("node:net")
    const socket = net.connect(edge.boundPorts().https!, "127.0.0.1")
    socket.on("error", () => {})
    await new Promise((resolve) => socket.once("connect", resolve))
    // Half a ClientHello: the edge waits for the rest.
    socket.write(Buffer.from([22, 3, 1, 0, 200, 1]))
    const closed = new Promise((resolve) => socket.once("close", resolve))

    await edge.stop()
    await closed
    expect(socket.destroyed).toBe(true)
  })
})

describe("problems", () => {
  it("says when the app is not answering", async () => {
    const edge = makeEdge()
    await edge.start(domain)
    app.closeAllConnections()
    await new Promise((resolve) => app.close(resolve))
    app = http.createServer()
    app.listen(0)

    const answer = await get(edge.boundPorts().http!, "/")
    expect(answer.status).toBe(502)
  })

  it("reports a port that is taken, and tries it again later", async () => {
    const blocker = http.createServer()
    await new Promise<void>((resolve) => blocker.listen(0, resolve))
    const taken = (blocker.address() as AddressInfo).port

    edge = new Edge({
      target: { host: "127.0.0.1", port: appPort },
      challenges,
      httpPort: taken,
      httpsPort: 0,
    })
    await edge.start(domain)
    expect(edge.status.http).toMatchObject({ listening: false, port: taken })
    expect(edge.status.http.error).toMatch(/already in use/)

    await new Promise((resolve) => blocker.close(resolve))
    await edge.start(domain)
    expect(edge.status.http.listening).toBe(true)
  })

  it("explains a port it may not use", () => {
    expect(
      listenError(443, Object.assign(new Error("x"), { code: "EACCES" })),
    ).toMatch(/PCP_HTTP_PORT/)
  })
})
