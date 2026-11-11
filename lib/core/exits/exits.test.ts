import http from "node:http"
import type net from "node:net"

import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import { prepareFetch } from "../fetch/request"
import {
  decidePermission,
  getPermissionView,
  withPermission,
  type PermissionExecutor,
  type PermissionScope,
} from "../permissions"
import { withLogNote } from "../request-log"
import { createServer, deleteServer, getServer } from "../servers"
import { closeAllSshConnections } from "../ssh/client"
import { startFakeSsh, type FakeSsh } from "../ssh/fake-server"
import { createSshServer } from "../ssh/hosts"
import { scratchDatabase } from "../test-db"
import { openExit, openExitForCall, syncServerTools } from "../upstream"
import { setupVault } from "../vault"
import {
  decideFetch,
  listFetchRules,
  runFetch,
  setFetchSite,
} from "../web-fetch"
import {
  createSshExit,
  decideExit,
  deleteExit,
  getExit,
  listExitLevels,
  setExitLevel,
  setExitLevelShared,
  updateExit,
  writeExitAccess,
} from "./exits"
import { checkExit, usableExitNames } from "./use"

// Exits in the core: added by the owner on an SSH server, levels per token
// (blocked unless set), the owner's answer to an exit_use request, and a
// web_fetch through an exit against the test SSH server, which sends the
// site's public address to a server on loopback.

const PUBLIC_URL = "http://localhost:3000"
const SITE = "93.184.216.34"

let cleanup: () => Promise<void>
let ctx: VaultContext
let scope: PermissionScope
let fake: FakeSsh
let site: http.Server
let authorized: string | null

beforeEach(async () => {
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
  scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  site = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(`from the exit's side: ${req.headers.host}`)
  })
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve))
  const sitePort = (site.address() as net.AddressInfo).port
  authorized = null
  fake = await startFakeSsh({
    authorizedKey: () => authorized,
    run: () => ({}),
    allowForwarding: true,
    connectTo: (host) =>
      host === SITE ? { host: "127.0.0.1", port: sitePort } : null,
  })
})

afterEach(async () => {
  closeAllSshConnections()
  site.closeAllConnections()
  await new Promise<void>((resolve) => site.close(() => resolve()))
  await fake.close()
  await cleanup()
})

/** An SSH server the owner added, keyed and checked (its host key pinned). */
async function sshServer({ pinned = true }: { pinned?: boolean } = {}) {
  const { id } = await createSshServer(ctx, {
    name: "VPS",
    host: "127.0.0.1",
    port: fake.port,
    username: "deploy",
  })
  authorized = (await getServer(ctx, id)).sshPublicKey

  if (pinned) {
    await syncServerTools(ctx, await getServer(ctx, id), {
      publicUrl: PUBLIC_URL,
      byOwner: true,
    })
  }

  return id
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n")
}

describe("the owner's exits", () => {
  it("leave from an SSH server, with a name assistants use and a label", async () => {
    const serverId = await sshServer({ pinned: false })
    const { id } = await createSshExit(ctx, {
      serverId,
      name: " US-VPS ",
      label: "US — home VPS",
    })

    expect(await getExit(ctx, id)).toMatchObject({
      name: "us-vps",
      label: "US — home VPS",
      kind: "ssh",
      serverId,
      serverName: "VPS",
    })

    await expect(
      createSshExit(ctx, { serverId, name: "us-vps" }),
    ).rejects.toThrow(/already/)
    await expect(
      createSshExit(ctx, { serverId, name: "us vps" }),
    ).rejects.toThrow(/lower-case letters/)
    await expect(
      createSshExit(ctx, { serverId, name: "x", label: "hidden‮" }),
    ).rejects.toThrow(/do not show/)

    await updateExit(ctx, id, { name: "home", label: "" })
    expect(await getExit(ctx, id)).toMatchObject({ name: "home", label: "" })
  })

  it("leave only from an SSH server", async () => {
    const { id: mcpId } = await createServer(ctx, {
      name: "Upstream",
      url: "https://upstream.example/mcp",
      authType: "none",
    })

    await expect(
      createSshExit(ctx, { serverId: mcpId, name: "x" }),
    ).rejects.toThrow(/SSH servers/)
  })

  it("go with their levels, and with their SSH server", async () => {
    const serverId = await sshServer({ pinned: false })
    const { id } = await createSshExit(ctx, { serverId, name: "us-vps" })
    const { id: other } = await createSshExit(ctx, { serverId, name: "eu-vps" })
    await writeExitAccess(ctx.vaultId, scope.tokenId, id, "allowed")
    await writeExitAccess(ctx.vaultId, null, other, "ask")

    await deleteExit(ctx, id)
    expect(
      await db().webFetchRule.count({ where: { kind: "exit", key: id } }),
    ).toBe(0)

    await deleteServer(ctx, serverId)
    expect(await db().exit.count()).toBe(0)
    expect(await db().webFetchRule.count({ where: { kind: "exit" } })).toBe(0)
  })
})

describe("an exit's level", () => {
  it("is blocked until the owner sets one, and an unset exit is not confirmed to exist", async () => {
    const serverId = await sshServer({ pinned: false })
    const { id } = await createSshExit(ctx, { serverId, name: "us-vps" })

    expect(await decideExit(ctx.vaultId, scope.tokenId, id)).toEqual({
      access: "blocked",
      by: "none",
    })
    const unset = await checkExit(ctx, scope.tokenId, "us-vps")
    const missing = await checkExit(ctx, scope.tokenId, "nowhere")
    expect(unset).toEqual(
      missing.kind === "refused"
        ? { ...missing, message: missing.message.replace("nowhere", "us-vps") }
        : missing,
    )
    expect(await usableExitNames(ctx, scope.tokenId)).toEqual([])
  })

  it("follows the token's own line over the one for all tokens", async () => {
    const serverId = await sshServer({ pinned: false })
    const { id } = await createSshExit(ctx, { serverId, name: "us-vps" })

    await writeExitAccess(ctx.vaultId, null, id, "allowed")
    expect((await checkExit(ctx, scope.tokenId, "us-vps")).kind).toBe("ok")

    await setExitLevel(ctx, scope.tokenId, id, "blocked")
    const blocked = await checkExit(ctx, scope.tokenId, "us-vps")
    expect(blocked).toMatchObject({
      kind: "refused",
      message: expect.stringMatching(/has blocked the exit us-vps/),
    })

    await setExitLevel(ctx, scope.tokenId, id, "ask")
    expect((await checkExit(ctx, scope.tokenId, "us-vps")).kind).toBe("ask")
    expect(await usableExitNames(ctx, scope.tokenId)).toEqual(["us-vps"])
  })

  it("can be made the one for all tokens on a token's page, and shows there", async () => {
    const serverId = await sshServer({ pinned: false })
    const { id } = await createSshExit(ctx, {
      serverId,
      name: "us-vps",
      label: "US",
    })

    await setExitLevel(ctx, scope.tokenId, id, "allowed")
    await setExitLevelShared(ctx, scope.tokenId, id, true)
    expect(await listExitLevels(ctx, scope.tokenId)).toMatchObject([
      { name: "us-vps", access: "allowed", own: null, shared: "allowed" },
    ])
    expect((await listFetchRules(ctx, scope.tokenId)).exits).toHaveLength(1)

    await setExitLevelShared(ctx, scope.tokenId, id, false)
    expect(await listExitLevels(ctx, scope.tokenId)).toMatchObject([
      { access: "allowed", own: "allowed", shared: null },
    ])
  })
})

describe("web_fetch through an exit", () => {
  it("leaves from the SSH server, to the address PCP checked", async () => {
    const serverId = await sshServer()
    const { id } = await createSshExit(ctx, { serverId, name: "us-vps" })
    const exit = await getExit(ctx, id)
    const opened = await openExit(ctx, exit, { publicUrl: PUBLIC_URL })
    const args = prepareFetch({ url: `http://${SITE}/page`, exit: "us-vps" })

    const result = await runFetch(ctx, scope.tokenId, args, {
      publicUrl: PUBLIC_URL,
      exit: opened.dialer,
    })

    expect(textOf(result)).toContain(`from the exit's side: ${SITE}`)
    expect(fake.forwards).toEqual([`${SITE}:80`])
    expect(fake.requests).toEqual([])
  })

  it("refuses the exit's own network and loopback", async () => {
    const serverId = await sshServer()
    const { id } = await createSshExit(ctx, { serverId, name: "us-vps" })
    const opened = await openExit(ctx, await getExit(ctx, id), {
      publicUrl: PUBLIC_URL,
    })

    await expect(
      runFetch(ctx, scope.tokenId, prepareFetch({ url: "http://10.0.0.5/" }), {
        publicUrl: PUBLIC_URL,
        exit: opened.dialer,
      }),
    ).rejects.toThrow(/private or local address on the exit us-vps's side/)
    await expect(
      runFetch(
        ctx,
        scope.tokenId,
        prepareFetch({ url: "http://127.0.0.1:22/" }),
        {
          publicUrl: PUBLIC_URL,
          exit: opened.dialer,
        },
      ),
    ).rejects.toThrow(/the exit us-vps itself/)
    expect(fake.forwards).toEqual([])
  })

  it("never connects to an SSH server whose host key the owner has not pinned", async () => {
    const serverId = await sshServer({ pinned: false })
    const { id } = await createSshExit(ctx, { serverId, name: "us-vps" })

    await expect(
      openExit(ctx, await getExit(ctx, id), { publicUrl: PUBLIC_URL }),
    ).rejects.toThrow(/not pinned/)
    expect(fake.connections()).toBe(0)
  })

  it("says so when the server does not allow forwarding", async () => {
    await fake.close()
    fake = await startFakeSsh({
      authorizedKey: () => authorized,
      run: () => ({}),
      allowForwarding: false,
    })
    const serverId = await sshServer()
    const { id } = await createSshExit(ctx, { serverId, name: "us-vps" })
    const opened = await openExit(ctx, await getExit(ctx, id), {
      publicUrl: PUBLIC_URL,
    })

    await expect(
      runFetch(ctx, scope.tokenId, prepareFetch({ url: `http://${SITE}/` }), {
        publicUrl: PUBLIC_URL,
        exit: opened.dialer,
      }),
    ).rejects.toThrow(/through the exit us-vps.*TCP forwarding is off/s)
  })

  it("names the exit on the call's line in the request log, never the site", async () => {
    const serverId = await sshServer()
    const { id } = await createSshExit(ctx, { serverId, name: "us-vps" })

    const note = await withLogNote(async (note) => {
      await openExitForCall(ctx, scope.tokenId, await getExit(ctx, id), {
        publicUrl: PUBLIC_URL,
        tool: "web_fetch",
      })
      return note
    })

    expect(note).toEqual({ exit: "us-vps" })
  })
})

describe("an exit_use request", () => {
  async function ask() {
    const serverId = await sshServer()
    const { id } = await createSshExit(ctx, {
      serverId,
      name: "us-vps",
      label: "US",
    })
    await writeExitAccess(ctx.vaultId, null, id, "ask")
    const input = prepareFetch({ url: `http://${SITE}/news`, exit: "us-vps" })
    await decideFetch(scope, input)
    const asked = await withPermission(scope, {
      kind: "exit_use",
      input: {
        exitId: id,
        exitName: "us-vps",
        exitLabel: "US",
        via: "web_fetch",
        fetch: input,
      },
    })
    const requestId = (await db().permissionRequest.findFirstOrThrow()).id
    return { id, asked, requestId }
  }

  const fetched: Array<{ url: string; exit: string | undefined }> = []
  const executor = (): PermissionExecutor => ({
    callTool: async () => ({ content: [] }),
    syncTools: async () => ({ status: "ok", message: "", toolCount: 0 }),
    fetchWeb: async (args, options) => {
      fetched.push({ url: args.url, exit: options?.exit?.name })
      return {
        result: { content: [{ type: "text", text: "ok" }] },
        challenged: false,
      }
    },
  })

  beforeEach(() => {
    fetched.length = 0
  })

  it("shows the exit, where it comes out and the site", async () => {
    const { asked, requestId } = await ask()

    expect(textOf(asked)).toContain("Not done yet")
    const view = await getPermissionView(ctx, requestId, {
      publicUrl: PUBLIC_URL,
    })
    expect(view).toMatchObject({
      kind: "exit_use",
      tool: "web_fetch",
      title: "Send this request through the exit us-vps (US)?",
    })
    expect(view?.lines.join("\n")).toContain(`Address: http://${SITE}/news`)
    expect(view?.decisions.map((decision) => decision.label)).toEqual([
      "Allow once",
      "Always allow this exit",
      "Block this exit",
      "Not now",
    ])
  })

  it("Allow once sends the one request through the exit and sets no level", async () => {
    const { id, requestId } = await ask()

    await decidePermission(
      ctx,
      requestId,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      executor(),
    )

    expect(fetched).toEqual([{ url: `http://${SITE}/news`, exit: "us-vps" }])
    expect(await decideExit(ctx.vaultId, scope.tokenId, id)).toEqual({
      access: "ask",
      by: "all",
    })
  })

  it("Always allow sets the token's own level for the exit, not the site's", async () => {
    const { id, requestId } = await ask()

    await decidePermission(
      ctx,
      requestId,
      "always",
      { publicUrl: PUBLIC_URL },
      executor(),
    )

    expect(await decideExit(ctx.vaultId, scope.tokenId, id)).toEqual({
      access: "allowed",
      by: "own",
    })
    expect(fetched).toHaveLength(1)
    const rules = await listFetchRules(ctx, scope.tokenId)
    expect(rules.sites.find((line) => line.host === SITE)?.own).toBe("default")
  })

  it("Block blocks the exit for the token and sends nothing", async () => {
    const { id, requestId } = await ask()

    await decidePermission(
      ctx,
      requestId,
      "block",
      { publicUrl: PUBLIC_URL },
      executor(),
    )

    expect(fetched).toEqual([])
    expect(await decideExit(ctx.vaultId, scope.tokenId, id)).toEqual({
      access: "blocked",
      by: "own",
    })
  })

  it("does not reach a site the owner blocked since", async () => {
    const { requestId } = await ask()
    await setFetchSite(ctx, scope.tokenId, SITE, "blocked")

    const result = await decidePermission(
      ctx,
      requestId,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      executor(),
    )

    expect(fetched).toEqual([])
    expect(textOf(result)).toContain("blocked")
  })
})
