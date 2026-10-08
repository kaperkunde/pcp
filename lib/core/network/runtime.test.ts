import http from "node:http"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { scratchDatabase } from "../test-db"
import { clearDdnsConfig, saveDdnsConfig } from "./ddns"
import {
  edgePorts,
  networkIdle,
  networkNotices,
  networkOverview,
  reconcileNetwork,
  setNetworkIssuer,
} from "./runtime"
import { clearTlsConfig, saveTlsConfig } from "./tls"

// The background side as the Server Actions drive it: nothing runs while
// both features are off, turning HTTPS on opens ports 80 and 443 (443 for
// the TLS-ALPN-01 challenge, before there is a certificate), and a first try
// Let's Encrypt refuses turns it off again, saying why.

const saved = { ...process.env }
let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  process.env.PCP_HTTP_PORT = "0"
  process.env.PCP_HTTPS_PORT = "0"
  // A Let's Encrypt that refuses, at once.
  setNetworkIssuer(async () => {
    throw new Error("connect ECONNREFUSED")
  })
  process.env.PCP_PUBLIC_IP_URL = "http://127.0.0.1:9/ip"
})

afterEach(async () => {
  await clearTlsConfig()
  await clearDdnsConfig()
  await reconcileNetwork()
  await networkIdle()
  setNetworkIssuer()
  process.env = { ...saved }
  await cleanup()
})

function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      .on("error", reject)
  })
}

describe("the network runtime", () => {
  it("opens nothing while both features are off", async () => {
    await reconcileNetwork()
    await networkIdle()

    expect(edgePorts()).toBeNull()
    expect(await networkOverview()).toMatchObject({ ddns: null, https: null })
  })

  it("opens ports 80 and 443 for HTTPS, and turns them off again when the first try fails", async () => {
    let refuse = () => {}
    const types: string[][] = []
    const asked = new Promise<void>((resolve) => {
      setNetworkIssuer(async ({ challengeTypes }) => {
        types.push(challengeTypes)
        resolve()
        await new Promise<void>((release) => (refuse = release))
        throw new Error("connect ECONNREFUSED")
      })
    })
    await saveTlsConfig(
      {
        domain: "pcp.example.com",
        useDdnsName: false,
        email: "",
        agreed: true,
      },
      null,
    )
    await reconcileNetwork({ tlsNow: true })
    await asked

    const port = edgePorts()?.http
    expect(port).toBeGreaterThan(0)
    expect(await get(port!, "/.well-known/acme-challenge/none")).toBe(404)
    expect(edgePorts()?.https).toBeGreaterThan(0)
    // A name of the owner's own: port 80 first, then port 443.
    expect(types).toEqual([["http-01", "tls-alpn-01"]])
    expect((await networkOverview()).https?.status.state).toBe("issuing")

    refuse()
    await networkIdle()

    expect(edgePorts()).toBeNull()
    const overview = await networkOverview()
    expect(overview.https).toBeNull()
    expect(overview.httpsTurnedOff?.domain).toBe("pcp.example.com")
    expect(overview.httpsTurnedOff?.error).toMatch(
      /Let's Encrypt did not issue/,
    )
    // Turned off, it is not news for the bell: the HTTPS card says why.
    expect(await networkNotices()).toEqual([])

    // Turning it on again starts afresh.
    await saveTlsConfig(
      {
        domain: "pcp.example.com",
        useDdnsName: false,
        email: "",
        agreed: true,
      },
      null,
    )
    expect((await networkOverview()).httpsTurnedOff).toBeNull()
  })

  it("sends the first dynamic DNS update when the owner saves", async () => {
    const hits: string[] = []
    const service = http.createServer((req, res) => {
      hits.push(req.url ?? "")
      res.end("ok")
    })
    await new Promise<void>((resolve) =>
      service.listen(0, "127.0.0.1", resolve),
    )
    const { port } = service.address() as { port: number }

    try {
      await saveDdnsConfig({
        provider: "custom",
        url: `http://127.0.0.1:${port}/update?host={hostname}`,
        hostname: "pcp.example.com",
      })
      await reconcileNetwork({ ddnsNow: true })

      expect(hits).toEqual(["/update?host=pcp.example.com"])
      const { ddns } = await networkOverview()
      expect(ddns?.status.lastUpdatedAt).toBeDefined()
      expect(ddns?.name).toBe("pcp.example.com")
    } finally {
      await new Promise((resolve) => service.close(resolve))
    }
  })
})
