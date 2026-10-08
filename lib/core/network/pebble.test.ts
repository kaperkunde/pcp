import { X509Certificate } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { Edge } from "./edge"
import { acmeIssuer, challengeStore, type ChallengeType } from "./tls"

// acmeIssuer and the edge against Pebble, Let's Encrypt's test server,
// which validates both challenges for real: a certificate with port 80 out
// of reach (TLS-ALPN-01), HTTP-01 failing and TLS-ALPN-01 taking over, and
// HTTP-01 where port 80 answers. Skipped unless PCP_TEST_PEBBLE_DIRECTORY is
// set. To run it:
//
//   PEBBLE_VA_NOSLEEP=1 PEBBLE_WFE_NONCEREJECT=0 PEBBLE_AUTHZREUSE=0 \
//     pebble -config config.json   # httpPort 5002, tlsPort 5001
//   echo "127.0.0.1 alice.pcp.test home.pcp.test" | sudo tee -a /etc/hosts
//   PCP_TEST_PEBBLE_DIRECTORY=https://127.0.0.1:14000/dir \
//   NODE_EXTRA_CA_CERTS=<Pebble's own certificate> NO_PROXY=127.0.0.1 \
//     pnpm test lib/core/network/pebble.test.ts
//
// PCP_TEST_PEBBLE_HTTP_PORT and PCP_TEST_PEBBLE_TLS_PORT follow Pebble's
// httpPort and tlsPort when they are not 5002 and 5001.

const directory = process.env.PCP_TEST_PEBBLE_DIRECTORY?.trim()
const httpPort = Number(process.env.PCP_TEST_PEBBLE_HTTP_PORT ?? 5002)
const tlsPort = Number(process.env.PCP_TEST_PEBBLE_TLS_PORT ?? 5001)
const saved = { ...process.env }
const stops: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  process.env = { ...saved }
})

async function issue(
  domain: string,
  challengeTypes: ChallengeType[],
  port80: boolean,
): Promise<string> {
  // A fresh account each time: Pebble refuses acme-client's update of an
  // account it already has.
  const dir = mkdtempSync(path.join(tmpdir(), "pcp-pebble-"))
  process.env.PCP_DATA_DIR = dir
  process.env.PCP_ACME_DIRECTORY = directory
  const app = http.createServer((_req, res) => res.end("app"))
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve))
  const challenges = challengeStore()
  const edge = new Edge({
    target: { host: "127.0.0.1", port: (app.address() as AddressInfo).port },
    challenges,
    // Port 80 out of reach: listening where Pebble does not ask.
    httpPort: port80 ? httpPort : 0,
    httpsPort: tlsPort,
    host: "127.0.0.1",
  })
  stops.push(async () => {
    await edge.stop()
    await new Promise((resolve) => app.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })
  await edge.start(domain)

  const { cert } = await acmeIssuer({
    domain,
    email: null,
    challenges,
    challengeTypes,
  })
  expect(challenges.http.size + challenges.tlsAlpn.size).toBe(0)
  return cert
}

describe.skipIf(!directory)(
  "certificates from Pebble",
  { timeout: 60_000 },
  () => {
    it("gets one for a pcp.gg name with port 80 out of reach", async () => {
      const cert = await issue(
        "alice.pcp.test",
        ["tls-alpn-01", "http-01"],
        false,
      )
      expect(new X509Certificate(cert).checkHost("alice.pcp.test")).toBe(
        "alice.pcp.test",
      )
    })

    it("gets one on port 443 when port 80 is not forwarded", async () => {
      const cert = await issue(
        "home.pcp.test",
        ["http-01", "tls-alpn-01"],
        false,
      )
      expect(new X509Certificate(cert).checkHost("home.pcp.test")).toBe(
        "home.pcp.test",
      )
    })

    it("gets one with HTTP-01 where port 80 is forwarded", async () => {
      const cert = await issue(
        "home.pcp.test",
        ["http-01", "tls-alpn-01"],
        true,
      )
      expect(new X509Certificate(cert).checkHost("home.pcp.test")).toBe(
        "home.pcp.test",
      )
    })
  },
)
