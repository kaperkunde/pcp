import { readFileSync } from "node:fs"
import http from "node:http"
import type net from "node:net"
import path from "node:path"

import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import { exportVault, readExport, restoreExport } from "../backup"
import type { VaultContext } from "../context"
import { db } from "../db"
import {
  getExit,
  listExits,
  writeExitAccess,
  type ExitView,
} from "../exits/exits"
import { startFakeProxy, type FakeProxy } from "../exits/fake-proxy"
import { prepareFetch } from "../fetch/request"
import { parseItem, serializeItem } from "../repos/documents"
import { createSecret, readSecretValue } from "../secrets"
import { getServer } from "../servers"
import { closeAllSshConnections } from "../ssh/client"
import { startFakeSsh, type FakeSsh } from "../ssh/fake-server"
import { createSshServer } from "../ssh/hosts"
import { scratchDatabase } from "../test-db"
import {
  launchService,
  openExit,
  readServiceStatus,
  removeExit,
  removeService,
  syncServerTools,
} from "../upstream"
import { setupVault } from "../vault"
import { runFetch } from "../web-fetch"
import {
  parseServiceDefinition,
  type ServiceDefinitionInput,
} from "./definition"
import { startFakeDocker, type FakeDocker } from "./fake-docker"
import { prepareServiceProposal } from "./proposals"
import { serviceView, type ServiceLaunchInput } from "./services"

// VPN services as exits, end to end in the core: launched by the owner on
// the test SSH server (whose login runs a fake `docker` in a real sh), the
// container's proxy played by a proxy of the test's own on loopback, which
// the test SSH server's forwarding reaches as the SSH server's 127.0.0.1;
// the proxy sends a site's public address on to a server of the test's.

const PUBLIC = { publicUrl: "http://localhost:3000" }
const FAST = { ...PUBLIC, timing: { waitMs: 1500, intervalMs: 50 } }
const SITE = "93.184.216.34"
const DIGEST = `sha256:${"c".repeat(64)}`

let cleanup: () => Promise<void>
let ctx: VaultContext
let tokenId: string
let ssh: FakeSsh
let docker: FakeDocker
let proxy: FakeProxy
let site: http.Server
let sitePort: number
let authorized: string | null
/** Whether the proxy connects out (the VPN is up). */
let vpnUp: boolean
/** The login the proxy takes: the one PCP made, read from the vault. */
let proxyLogin: { username: string; password: string } | null

async function setup(protocol: "http" | "socks5") {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    webFetch: true,
  })
  tokenId = (await resolveApiToken(token))!.tokenId
  site = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(`through the VPN: ${req.headers.host}`)
  })
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve))
  sitePort = (site.address() as net.AddressInfo).port
  vpnUp = true
  proxyLogin = null
  proxy = await startFakeProxy({
    protocol,
    auth: () => proxyLogin,
    connectTo: (host, port) => {
      if (!vpnUp) return null
      if (host === "1.1.1.1" && port === 443) return "accept"
      if (host === SITE) return { host: "127.0.0.1", port: sitePort }
      return null
    },
  })
  authorized = null
  docker = startFakeDocker()
  ssh = await startFakeSsh({
    authorizedKey: () => authorized,
    run: docker.run,
    allowForwarding: true,
    // The SSH server's own loopback port the proxy is published on.
    connectTo: (host, port) =>
      host === "127.0.0.1" && port === proxy.port ? { host, port } : null,
  })
}

async function teardown() {
  closeAllSshConnections()
  site.closeAllConnections()
  await new Promise<void>((resolve) => site.close(() => resolve()))
  await proxy.close()
  await ssh.close()
  docker.close()
  await cleanup()
}

async function pinnedHost(): Promise<string> {
  const { id } = await createSshServer(ctx, {
    name: "VPS",
    host: "127.0.0.1",
    port: ssh.port,
    username: "deploy",
  })
  authorized = (await getServer(ctx, id)).sshPublicKey
  await syncServerTools(ctx, await getServer(ctx, id), {
    ...PUBLIC,
    byOwner: true,
  })
  return id
}

/** Gluetun's shape: an HTTP proxy, NET_ADMIN and the tunnel device. */
function gluetun(
  change: Partial<ServiceDefinitionInput> = {},
): ServiceDefinitionInput {
  return {
    image: `docker.io/qmcgaw/gluetun@${DIGEST}`,
    source: "docker.io/qmcgaw/gluetun:v3.41",
    ports: [{ container: 8888 }],
    env: [
      { name: "VPN_SERVICE_PROVIDER", plain: true, required: true },
      { name: "VPN_TYPE", plain: true, value: "openvpn" },
      { name: "SERVER_COUNTRIES", plain: true },
      { name: "OPENVPN_USER" },
      { name: "OPENVPN_PASSWORD" },
      { name: "HTTPPROXY", value: "on" },
    ],
    cap_add: ["NET_ADMIN"],
    devices: ["/dev/net/tun"],
    registers: {
      kind: "exit",
      port: 8888,
      protocol: "http",
      auth: { user_env: "HTTPPROXY_USER", password_env: "HTTPPROXY_PASSWORD" },
    },
    ...change,
  }
}

/** A userspace WireGuard client's shape: SOCKS5, no privileges. */
function socksShaped(): ServiceDefinitionInput {
  return {
    image: `ghcr.io/example/wg-socks@${DIGEST}`,
    ports: [{ container: 1080 }],
    env: [{ name: "WG_PRIVATE_KEY", required: true }],
    registers: {
      kind: "exit",
      port: 1080,
      protocol: "socks5",
      auth: { user_env: "PROXY_USER", password_env: "PROXY_PASSWORD" },
    },
  }
}

async function launchInput(
  hostId: string,
  change: Partial<ServiceLaunchInput> = {},
): Promise<ServiceLaunchInput> {
  const secret = async (name: string, value: string) =>
    (await db().secret.findFirst({ where: { name } })) ??
    (await createSecret(ctx, { name, value }))
  const user = await secret("vpn-user", "p1234567")
  const password = await secret("vpn-password", "vpn-password-value-9876")

  return {
    name: "VPN",
    hostId,
    definition: gluetun(),
    publish: {
      address: "127.0.0.1",
      ports: [{ container: 8888, host: proxy.port }],
    },
    env: { OPENVPN_USER: user.id, OPENVPN_PASSWORD: password.id },
    values: { VPN_SERVICE_PROVIDER: "mullvad", SERVER_COUNTRIES: "Sweden" },
    exit: { name: "se-vpn", label: "Sweden, Mullvad" },
    ...change,
  }
}

/**
 * The password PCP made for the proxy, read from the vault: the fake proxy
 * takes any login until a test sets the one it wants from this.
 */
function takePcpLogin() {
  return async () => {
    const secret = await db().secret.findFirst({
      where: { kind: "proxy_password" },
    })
    return secret ? readSecretValue(ctx, secret.id) : null
  }
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n")
}

/** Everything the SSH server was asked to run, and the engine's words. */
function everythingSent(): string {
  return JSON.stringify([docker.commands, docker.state().calls])
}

describe(
  "a VPN service with an HTTP proxy (gluetun's shape)",
  {
    timeout: 30_000,
  },
  () => {
    beforeEach(() => setup("http"))
    afterEach(teardown)

    it("launches with NET_ADMIN and the tunnel device, its proxy on loopback only, and adds the exit", async () => {
      const hostId = await pinnedHost()
      const launched = await launchService(ctx, await launchInput(hostId), FAST)

      expect(launched.exitId).toBeTruthy()
      expect(launched.registeredId).toBe(null)
      const exit = await getExit(ctx, launched.exitId!)
      expect(exit).toMatchObject({
        name: "se-vpn",
        label: "Sweden, Mullvad",
        kind: "service",
        serverId: hostId,
        serviceId: launched.id,
      })

      const container = docker.state().containers["pcp-vpn"]!
      expect(container.capAdd).toEqual(["NET_ADMIN"])
      expect(container.devices).toEqual(["/dev/net/tun"])
      expect(container.publish).toEqual([`127.0.0.1:${proxy.port}:8888`])

      // The proxy's login: a random password PCP made, kept as a managed
      // secret, handed to the container over standard input only.
      const secret = await db().secret.findFirstOrThrow({
        where: { kind: "proxy_password" },
      })
      const password = await readSecretValue(ctx, secret.id)
      expect(password.length).toBeGreaterThanOrEqual(32)
      expect((await getServer(ctx, launched.id)).authSecretId).toBe(secret.id)
      const env = container.env.split("\n")
      expect(env).toContain("HTTPPROXY_USER=pcp")
      expect(env).toContain(`HTTPPROXY_PASSWORD=${password}`)
      expect(env).toContain("VPN_SERVICE_PROVIDER=mullvad")
      expect(env).toContain("SERVER_COUNTRIES=Sweden")
      expect(env).toContain("VPN_TYPE=openvpn")
      expect(env).toContain("OPENVPN_PASSWORD=vpn-password-value-9876")
      expect(everythingSent()).not.toContain(password)
      expect(everythingSent()).not.toContain("vpn-password-value-9876")

      // Healthy once its proxy connected out, through the SSH connection.
      expect(proxy.asked).toEqual(["1.1.1.1:443"])
      expect(proxy.logins).toEqual([`pcp:${password}`])
      expect(ssh.forwards).toEqual([`127.0.0.1:${proxy.port}`])
      expect(ssh.requests).toEqual([])

      const view = await serviceView(ctx, launched.id)
      expect(view.exit).toMatchObject({ name: "se-vpn" })
      expect(
        view.env.find((entry) => entry.name === "SERVER_COUNTRIES"),
      ).toEqual({
        name: "SERVER_COUNTRIES",
        plain: true,
        value: "Sweden",
        secretId: null,
        secretName: null,
      })
    })

    it("sends web_fetch through the VPN, signed in to its proxy, to the address PCP checked", async () => {
      const hostId = await pinnedHost()
      const read = takePcpLogin()
      const launched = await launchService(ctx, await launchInput(hostId), FAST)
      proxyLogin = { username: "pcp", password: (await read())! }
      const exit = await getExit(ctx, launched.exitId!)
      const opened = await openExit(ctx, exit, PUBLIC)

      const result = await runFetch(
        ctx,
        tokenId,
        prepareFetch({ url: `http://${SITE}/page`, exit: "se-vpn" }),
        { publicUrl: PUBLIC.publicUrl, exit: opened.dialer },
      )

      expect(textOf(result)).toContain(`through the VPN: ${SITE}`)
      expect(proxy.asked.at(-1)).toBe(`${SITE}:80`)
      expect(proxy.logins.at(-1)).toBe(`pcp:${proxyLogin.password}`)
      // Only ever the proxy's loopback port, never the site, from the SSH server.
      expect(new Set(ssh.forwards)).toEqual(
        new Set([`127.0.0.1:${proxy.port}`]),
      )
    })

    it("never reaches the exit's link-local or metadata addresses, even for a token with private addresses", async () => {
      const hostId = await pinnedHost()
      const launched = await launchService(ctx, await launchInput(hostId), FAST)
      const opened = await openExit(
        ctx,
        await getExit(ctx, launched.exitId!),
        PUBLIC,
      )
      const asked = proxy.asked.length
      const dial = opened.dialer.dial("169.254.169.254", 80, {
        allowPrivate: true,
      })

      await expect(dial).rejects.toThrow(/link-local or cloud metadata/)
      await expect(
        runFetch(
          ctx,
          tokenId,
          prepareFetch({ url: "http://169.254.169.254/latest/meta-data/" }),
          { publicUrl: PUBLIC.publicUrl, exit: opened.dialer },
        ),
      ).rejects.toThrow(/link-local or cloud metadata/)
      expect(proxy.asked.length).toBe(asked)
    })

    it("is published on the SSH server's loopback only, refused before anything connects", async () => {
      const hostId = await pinnedHost()
      const commands = docker.commands.length

      await expect(
        launchService(
          ctx,
          await launchInput(hostId, {
            publish: {
              address: "0.0.0.0",
              ports: [{ container: 8888, host: proxy.port }],
            },
          }),
          FAST,
        ),
      ).rejects.toThrow(/published on 127\.0\.0\.1 only/)
      expect(docker.commands.length).toBe(commands)
    })

    it("needs the exit's name, free in the vault, before anything connects", async () => {
      const hostId = await pinnedHost()

      await expect(
        launchService(ctx, await launchInput(hostId, { exit: null }), FAST),
      ).rejects.toThrow(/Name the exit/)
      await launchService(
        ctx,
        {
          ...(await launchInput(hostId)),
          name: "First",
        },
        FAST,
      )
      const commands = docker.commands.length
      await expect(
        launchService(
          ctx,
          {
            ...(await launchInput(hostId)),
            name: "Second",
          },
          FAST,
        ),
      ).rejects.toThrow(/an exit called se-vpn already/)
      expect(docker.commands.length).toBe(commands)
    })

    it("takes everything back when its proxy does not connect out", async () => {
      const hostId = await pinnedHost()
      vpnUp = false

      await expect(
        launchService(ctx, await launchInput(hostId), FAST),
      ).rejects.toThrow(
        /did not become healthy: its proxy did not connect out.*took|removed the container pcp-vpn/s,
      )
      expect(docker.state().containers).toEqual({})
      expect(await db().exit.count()).toBe(0)
      expect(await db().mcpServer.count({ where: { kind: "service" } })).toBe(0)
      expect(
        await db().secret.count({ where: { kind: "proxy_password" } }),
      ).toBe(0)
    })

    it("reads as unhealthy on its page when the VPN goes down", async () => {
      const hostId = await pinnedHost()
      const launched = await launchService(ctx, await launchInput(hostId), FAST)
      vpnUp = false

      const status = await readServiceStatus(ctx, launched.id, PUBLIC)
      expect(status).toMatchObject({ state: "running", health: "unhealthy" })
      expect(status.url).toBe(null)
      const [exit] = await listExits(ctx, { serverId: hostId })
      expect(exit!.service).toMatchObject({
        name: "VPN service",
        status: "error",
      })
    })

    it("removing the exit can take its service, its levels and its password with it", async () => {
      const hostId = await pinnedHost()
      const launched = await launchService(ctx, await launchInput(hostId), FAST)
      await writeExitAccess(ctx.vaultId, tokenId, launched.exitId!, "allowed")

      await removeExit(ctx, launched.exitId!, { service: true }, PUBLIC)

      expect(docker.state().containers).toEqual({})
      expect(await db().exit.count()).toBe(0)
      expect(await db().mcpServer.count({ where: { kind: "service" } })).toBe(0)
      expect(await db().webFetchRule.count({ where: { kind: "exit" } })).toBe(0)
      expect(
        await db().secret.count({ where: { kind: "proxy_password" } }),
      ).toBe(0)
    })

    it("removing only the exit leaves the service running; removing the service takes its exit", async () => {
      const hostId = await pinnedHost()
      const launched = await launchService(ctx, await launchInput(hostId), FAST)

      await removeExit(ctx, launched.exitId!, {}, PUBLIC)
      expect(await db().exit.count()).toBe(0)
      expect(docker.state().containers["pcp-vpn"]?.state).toBe("running")

      const again = await launchService(
        ctx,
        { ...(await launchInput(hostId)), name: "VPN two" },
        FAST,
      )
      await writeExitAccess(ctx.vaultId, null, again.exitId!, "ask")
      await removeService(ctx, again.id, {}, PUBLIC)
      expect(await db().exit.count()).toBe(0)
      expect(await db().webFetchRule.count({ where: { kind: "exit" } })).toBe(0)
    })

    it("travels in an export with its typed values, and comes back with a restore", async () => {
      const hostId = await pinnedHost()
      const launched = await launchService(ctx, await launchInput(hostId), FAST)
      const before = await db().serviceSpec.findUniqueOrThrow({
        where: { serverId: launched.id },
      })
      expect(JSON.parse(before.plainValues)).toEqual({
        VPN_SERVICE_PROVIDER: "mullvad",
        SERVER_COUNTRIES: "Sweden",
      })
      const file = await exportVault(ctx, "export password 123")
      const { payload } = await readExport(file, "export password 123")

      await restoreExport(
        payload,
        { into: "vault", ctx },
        { restoreHostSettings: false },
      )
      expect(
        await db().serviceSpec.findUniqueOrThrow({
          where: { serverId: launched.id },
        }),
      ).toEqual(before)
      const exits: ExitView[] = await listExits(ctx)
      expect(exits.map((exit) => exit.name)).toEqual(["se-vpn"])
    })

    it("is the owner's alone: an assistant cannot propose one", async () => {
      const hostId = await pinnedHost()

      await expect(
        prepareServiceProposal(ctx, {
          name: "VPN",
          service: gluetun(),
          sshServerId: hostId,
        }),
      ).rejects.toThrow(/only the owner adds/)
    })
  },
)

describe("a VPN service with a SOCKS5 proxy", { timeout: 30_000 }, () => {
  beforeEach(() => setup("socks5"))
  afterEach(teardown)

  it("launches without privileges and sends web_fetch through its proxy, signed in", async () => {
    const hostId = await pinnedHost()
    const key = await createSecret(ctx, {
      name: "wg-key",
      value: "wg-private-key-value",
    })
    const read = takePcpLogin()
    const launched = await launchService(
      ctx,
      {
        name: "WG",
        hostId,
        definition: socksShaped(),
        publish: {
          address: "127.0.0.1",
          ports: [{ container: 1080, host: proxy.port }],
        },
        env: { WG_PRIVATE_KEY: key.id },
        exit: { name: "home-wg" },
      },
      FAST,
    )
    const password = (await read())!
    proxyLogin = { username: "pcp", password }
    const container = docker.state().containers["pcp-wg"]!
    expect(container.capAdd).toEqual([])
    expect(container.devices).toEqual([])
    expect(container.env.split("\n")).toContain(`PROXY_PASSWORD=${password}`)

    const opened = await openExit(
      ctx,
      await getExit(ctx, launched.exitId!),
      PUBLIC,
    )
    const result = await runFetch(
      ctx,
      tokenId,
      prepareFetch({ url: `http://${SITE}/`, exit: "home-wg" }),
      { publicUrl: PUBLIC.publicUrl, exit: opened.dialer },
    )

    expect(textOf(result)).toContain(`through the VPN: ${SITE}`)
    expect(proxy.asked).toEqual(["1.1.1.1:443", `${SITE}:80`])
    expect(proxy.logins.at(-1)).toBe(`pcp:${password}`)
  })
})

describe("PCP's common items for exits", () => {
  // Copies of kaperkunde/pcp-gg-common's services/*.yaml: they read as a
  // service and are written back byte for byte.
  for (const file of ["gluetun.yaml", "docling.yaml"]) {
    it(`reads services/${file} and writes it back unchanged`, async () => {
      const text = readFileSync(
        path.join(import.meta.dirname, "testdata", file),
        "utf8",
      )
      const document = await parseItem({
        ref: { kind: "service", name: file.replace(/\.yaml$/, "") },
        files: { [file]: text },
      })

      expect(document.kind).toBe("service")
      expect(
        serializeItem(document)[`services/${file.replace(/\.yaml$/, "")}.yaml`],
      ).toBe(text)
    })
  }

  it("gluetun's is an exit on loopback with NET_ADMIN, the tunnel and a login PCP makes", async () => {
    const text = readFileSync(
      path.join(import.meta.dirname, "testdata", "gluetun.yaml"),
      "utf8",
    )
    const document = await parseItem({
      ref: { kind: "service", name: "gluetun" },
      files: { "gluetun.yaml": text },
    })
    const definition = parseServiceDefinition(
      document.kind === "service" ? document.definition : null,
    )

    expect(definition.registers).toEqual({
      kind: "exit",
      port: 8888,
      protocol: "http",
      auth: { user_env: "HTTPPROXY_USER", password_env: "HTTPPROXY_PASSWORD" },
    })
    expect(definition.cap_add).toEqual(["NET_ADMIN"])
    expect(definition.devices).toEqual(["/dev/net/tun"])
    expect(
      definition.env.find((entry) => entry.name === "HTTPPROXY")?.value,
    ).toBe("on")
  })
})
