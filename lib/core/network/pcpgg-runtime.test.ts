import http from "node:http"
import type { AddressInfo } from "node:net"
import type net from "node:net"
import tls from "node:tls"
import { setTimeout as sleep } from "node:timers/promises"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getHostSetting } from "../host-settings"
import { scratchDatabase } from "../test-db"
import { clearPcpggConfig, PCPGG_CONFIG_KEY, savePcpggConfig } from "./pcpgg"
import type { Authorization, Directory } from "./pcpgg/test-relay/directory"
import { createRelay, type Relay } from "./pcpgg/test-relay/relay"
import {
  edgePorts,
  networkIdle,
  networkNotices,
  networkOverview,
  pcpggSettled,
  reconcileNetwork,
  setNetworkIssuer,
} from "./runtime"
import { selfSignedCertificate } from "./test-certificate"
import { clearTlsConfig, getTlsConfig, type Issuer } from "./tls"

// PCP connected to pcp.gg, against a copy of pcp.gg's relay: the key saved,
// the name it is online at, HTTPS turned on for that name once Let's
// Encrypt's challenge reaches PCP through pcp.gg, an assistant's connection
// to the name reaching the app, and everything stopped again.

const NAME = "alice.pcp.test"
const KEY = "pcpgg_alice_0123456789abcdefghijklmnop"

class FakeDirectory implements Directory {
  keys = new Map<string, Authorization>([
    [KEY, { deviceId: "dev_alice", hostnames: [NAME], generation: 1 }],
  ])
  revoked = new Set<string>()

  async authorize(token: string) {
    return this.keys.get(token) ?? null
  }

  async report(online: { deviceId: string }[]) {
    return {
      disconnect: online
        .map((tunnel) => tunnel.deviceId)
        .filter((id) => this.revoked.has(id)),
    }
  }
}

const saved = { ...process.env }
let cleanup: () => Promise<void>
let directory: FakeDirectory
let relay: Relay
let relayHttps: number
let relayHttp: number
let app: http.Server
let appSeen: http.IncomingHttpHeaders[]

const listen = (server: net.Server | http.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    ),
  )

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  process.env.PCP_HTTP_PORT = "0"
  process.env.PCP_HTTPS_PORT = "0"
  process.env.PCP_PUBLIC_IP_URL = "http://127.0.0.1:9/ip"

  // The app the edge forwards to.
  appSeen = []
  app = http.createServer((req, res) => {
    appSeen.push(req.headers)
    res.end(`app saw ${req.url}`)
  })
  process.env.PORT = String(await listen(app))

  directory = new FakeDirectory()
  relay = createRelay({ directory, reportIntervalMs: 100 })
  relayHttps = await listen(relay.httpsServer)
  relayHttp = await listen(relay.httpServer)
  const tunnelPort = await listen(relay.tunnelServer)
  process.env.PCP_PCPGG_RELAY_URL = `ws://127.0.0.1:${tunnelPort}/v1/connect`
})

afterEach(async () => {
  await clearPcpggConfig()
  await clearTlsConfig()
  await reconcileNetwork()
  await networkIdle()
  setNetworkIssuer()
  await relay.close()
  app.closeAllConnections()
  await new Promise((resolve) => app.close(resolve))
  process.env = { ...saved }
  await cleanup()
})

/** GET through pcp.gg's port 80, as Let's Encrypt asks for the challenge. */
function getThroughRelay(
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port: relayHttp, path, headers: { host: NAME } },
        (res) => {
          let body = ""
          res.on("data", (chunk) => (body += chunk))
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
        },
      )
      .on("error", reject)
  })
}

/** A Let's Encrypt that checks the challenge the way it would: from outside. */
const issuer: Issuer = async ({ domain, challenges }) => {
  challenges.set("token-1", "token-1.thumbprint")

  try {
    const answer = await getThroughRelay("/.well-known/acme-challenge/token-1")

    if (answer.body !== "token-1.thumbprint") {
      throw new Error(`Invalid response from the challenge: ${answer.status}`)
    }
  } finally {
    challenges.delete("token-1")
  }

  return selfSignedCertificate(domain)
}

async function waitFor<T>(check: () => Promise<T | undefined | false | null>) {
  const deadline = Date.now() + 10_000

  while (Date.now() < deadline) {
    const value = await check()

    if (value) {
      return value
    }

    await sleep(25)
  }

  throw new Error("Timed out")
}

async function connect() {
  await savePcpggConfig({ key: KEY, agreed: true })
  await reconcileNetwork()
  await pcpggSettled()
}

describe("PCP connected to pcp.gg", () => {
  it("runs nothing while it is off", async () => {
    await reconcileNetwork()
    await networkIdle()

    expect((await networkOverview()).pcpgg).toBeNull()
    expect(relay.hostnames()).toEqual([])
    expect(edgePorts()).toBeNull()
  })

  it("comes online at its name, gets a certificate through pcp.gg, and is reached there", async () => {
    setNetworkIssuer(issuer)
    await connect()

    expect(relay.hostnames()).toEqual([NAME])
    expect((await networkOverview()).pcpgg).toMatchObject({
      state: "online",
      name: NAME,
      keyHint: "pcpgg_alic…",
    })

    // HTTPS turned on for the name, and the certificate got through
    // pcp.gg's port 80 on the first try.
    expect(await getTlsConfig()).toMatchObject({ domain: NAME, via: "pcpgg" })
    const overview = await waitFor(async () => {
      const next = await networkOverview()
      return next.pcpgg?.https?.status.state === "active" && edgePorts()?.https
        ? next
        : null
    })
    expect(overview.pcpgg?.https?.domain).toBe(NAME)
    // No warning that the name points elsewhere: it should.
    expect(overview.pcpgg?.https?.status.warning).toBeUndefined()

    // An assistant's connection to the name, through pcp.gg, reaches the
    // app, with the TLS session ending in PCP.
    const body = await new Promise<string>((resolve, reject) => {
      const socket = tls.connect({
        host: "127.0.0.1",
        port: relayHttps,
        servername: NAME,
        rejectUnauthorized: false,
      })
      socket.once("secureConnect", () => {
        socket.write(
          `GET /hello HTTP/1.1\r\nHost: ${NAME}\r\nConnection: close\r\n\r\n`,
        )
      })
      let answer = ""
      socket.on("data", (chunk) => (answer += chunk))
      socket.on("end", () => resolve(answer))
      socket.on("error", reject)
    })
    expect(body).toContain("app saw /hello")
    expect(appSeen.at(-1)?.["x-forwarded-proto"]).toBe("https")
    expect(appSeen.at(-1)?.["x-forwarded-host"]).toBe(NAME)
  })

  it("keeps the listeners to this computer", async () => {
    setNetworkIssuer(issuer)
    await connect()
    await waitFor(async () => edgePorts()?.http)

    const port = edgePorts()!.http!
    const local = await new Promise<number>((resolve, reject) =>
      http
        .get({ host: "127.0.0.1", port, path: "/x" }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        .on("error", reject),
    )
    expect(local).toBeGreaterThan(0)

    // Another address of this computer is not answered.
    const { networkInterfaces } = await import("node:os")
    const other = Object.values(networkInterfaces())
      .flat()
      .find(
        (address) => address && !address.internal && address.family === "IPv4",
      )

    if (other) {
      await expect(
        new Promise((resolve, reject) =>
          http
            .get({ host: other.address, port, path: "/x" }, resolve)
            .on("error", reject),
        ),
      ).rejects.toThrow(/ECONNREFUSED/)
    }
  })

  it("stops everything when turned off", async () => {
    setNetworkIssuer(issuer)
    await connect()
    await waitFor(async () => edgePorts()?.https)

    await clearPcpggConfig()
    await reconcileNetwork()
    await networkIdle()

    // The connection closed; pcp.gg lets go of the name as it sees the close.
    await waitFor(async () => relay.hostnames().length === 0)
    expect(await getTlsConfig()).toBeNull()
    expect(edgePorts()).toBeNull()
    expect((await networkOverview()).pcpgg).toBeNull()
  })

  it("stops and asks for a new key when pcp.gg does not accept it", async () => {
    directory.keys.clear()
    await connect()

    const { pcpgg } = await networkOverview()
    expect(pcpgg).toMatchObject({ state: "rejected" })
    expect(pcpgg?.error).toMatch(/did not accept this connection key/)
    expect(await networkNotices()).toEqual([
      {
        id: "pcpgg",
        title: "pcp.gg did not accept PCP's connection key.",
        href: "/settings#pcpgg",
      },
    ])
    // Nothing is tried again, not even after a restart.
    await reconcileNetwork()
    await sleep(200)
    expect((await networkOverview()).pcpgg?.state).toBe("rejected")
    expect(await getTlsConfig()).toBeNull()

    // A new key is a fresh start.
    directory.keys.set(KEY, {
      deviceId: "dev_alice",
      hostnames: [NAME],
      generation: 2,
    })
    await connect()
    expect((await networkOverview()).pcpgg?.state).toBe("online")
    expect(await getHostSetting(PCPGG_CONFIG_KEY)).toContain(KEY)
  })

  it("stops when pcp.gg revokes the key while connected", async () => {
    await connect()
    directory.revoked.add("dev_alice")

    const pcpgg = await waitFor(async () => {
      const view = (await networkOverview()).pcpgg
      return view?.state === "rejected" ? view : null
    })
    expect(pcpgg.error).toMatch(/replaced or removed/)
  })

  it("does not ask Let's Encrypt again for the name after a failed first try, until the owner does", async () => {
    let asked = 0
    setNetworkIssuer(async () => {
      asked += 1
      throw new Error("connect ECONNREFUSED")
    })
    await connect()

    const turnedOff = await waitFor(async () => {
      await networkIdle()
      return (await networkOverview()).pcpgg?.httpsTurnedOff
    })
    expect(turnedOff.domain).toBe(NAME)
    expect(turnedOff.error).toMatch(/Check that PCP shows as online at pcp.gg/)
    expect(turnedOff.error).not.toMatch(/router/)
    expect(asked).toBe(1)

    // Back online after a drop: still off.
    await reconcileNetwork()
    await networkIdle()
    expect(await getTlsConfig()).toBeNull()
    expect(asked).toBe(1)

    // Disconnected, the name's failure is no news for the HTTPS card.
    await clearPcpggConfig()
    await reconcileNetwork()
    expect((await networkOverview()).httpsTurnedOff).toBeNull()
  })
})
