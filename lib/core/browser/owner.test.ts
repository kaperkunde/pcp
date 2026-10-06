import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { McpServer } from "@/lib/generated/prisma/client"

import { createApiToken, resolveApiToken, revokeApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import { startTestApi, type TestApi } from "../openapi/test-api"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import {
  listFetchRules,
  setFetchPrivate,
  setFetchRuleShared,
  setFetchSite,
} from "../web-fetch"
import { callBrowserTool, performNavigate } from "./call"
import { chromiumExecutable } from "./executable"
import {
  browserOverview,
  browserTokens,
  forgetSites,
  handBackTab,
  openOwnerTab,
  ownerNavigate,
  startChromiumInstall,
  stopBrowser,
  tabFor,
  takeOverTab,
} from "./owner"
import { loadProfile } from "./profile"
import { closeAllBrowsers, runningBrowser } from "./runtime"
import { createBrowserServer } from "./server"
import { isOwnerNeeded } from "./types"

// What the owner does from PCP's pages, against a real Chromium: a tab of
// their own that no assistant sees until they hand it to a token they
// choose, an assistant's tab taken over and handed back, and the sign-ins
// forgotten.

const executable = await chromiumExecutable()
const PUBLIC_URL = "http://pcp.test"

let cleanup: () => Promise<void>
let api: TestApi
let ctx: VaultContext
let tokenId: string
let server: McpServer

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  })
  tokenId = (await resolveApiToken(token))!.tokenId
  server = await db().mcpServer.findUniqueOrThrow({
    where: { id: (await createBrowserServer(ctx)).id },
  })
  api = await startTestApi((request, res) => {
    res.setHeader("content-type", "text/html")
    if (request.url === "/login") {
      res.setHeader("set-cookie", "session=signed-in; Max-Age=3600")
    }
    res.end(`<title>${request.url}</title><h1>${request.url}</h1>`)
  })
  // The owner's own tab follows the line for all tokens.
  await setFetchPrivate(ctx, tokenId, "allowed")
  await setFetchRuleShared(ctx, tokenId, "private", "private", true)
})

afterEach(async () => {
  await closeAllBrowsers()
  await api.close()
  await cleanup()
})

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
}

function call(name: string, args: Record<string, unknown> = {}) {
  return callBrowserTool(ctx, server, name, args, {
    tokenId,
    publicUrl: PUBLIC_URL,
  })
}

/** A second token, which reaches the browser too. */
async function otherToken() {
  const { id } = await createApiToken(ctx, {
    name: "Other",
    allowAllServers: true,
  })

  return {
    tokenId: id,
    call: (name: string, args: Record<string, unknown> = {}) =>
      callBrowserTool(ctx, server, name, args, {
        tokenId: id,
        publicUrl: PUBLIC_URL,
      }),
  }
}

describe.skipIf(!executable)("the owner's tabs", { timeout: 90_000 }, () => {
  it("opens a tab of their own, which no assistant sees until they hand it to one", async () => {
    const tab = await openOwnerTab(ctx, {
      url: `${api.origin}/login`,
      publicUrl: PUBLIC_URL,
    })
    expect(tab).toMatchObject({
      openedBy: "owner",
      tokenId: null,
      control: "owner",
      url: `${api.origin}/login`,
    })
    expect(
      (await loadProfile(ctx))?.cookies.map((cookie) => cookie.name),
    ).toEqual(["session"])

    // To an assistant it is a tab that does not exist.
    const refused = await call("snapshot", { tab: tab.id })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain(`There is no tab ${tab.id}`)
    expect(textOf(await call("tabs", { action: "list" }))).not.toContain(tab.id)

    await ownerNavigate(ctx, tab.id, {
      url: `${api.origin}/account`,
      publicUrl: PUBLIC_URL,
    })
    await expect(
      ownerNavigate(ctx, tab.id, {
        url: `${PUBLIC_URL}/settings`,
        publicUrl: PUBLIC_URL,
      }),
    ).rejects.toThrow(/its own pages/)

    // Handed to another token, it is that token's: it lists and reads it,
    // at a site the owner allowed it for this tab by handing it over.
    const other = await otherToken()
    await handBackTab(ctx, tab.id, other.tokenId)
    expect(await tabFor(ctx, tab.id)).toMatchObject({
      control: "assistant",
      tokenId: other.tokenId,
    })
    expect(textOf(await other.call("tabs", { action: "list" }))).toContain(
      `* ${tab.id}:`,
    )
    const read = textOf(await other.call("read_page", {}))
    expect(read).toContain(`Tab ${tab.id}:`)
    expect(read).toContain(`Address: ${api.origin}/account`)

    // The first token still has no such tab, and a navigate naming it opens
    // a tab of its own.
    expect(textOf(await call("snapshot", { tab: tab.id }))).toContain(
      `There is no tab ${tab.id}`,
    )
    await setFetchSite(ctx, tokenId, new URL(api.origin).host, "allowed")
    const elsewhere = await call("navigate", {
      tab: tab.id,
      url: `${api.origin}/next`,
    })
    expect(textOf(elsewhere)).toContain('heading "/next"')
    expect(textOf(elsewhere)).not.toContain(`Tab ${tab.id}:`)
    expect(await tabFor(ctx, tab.id)).toMatchObject({
      url: `${api.origin}/account`,
    })
  })

  it("takes over an assistant's tab and hands it back to that assistant by default", async () => {
    const port = new URL(api.origin).port
    const opened = await performNavigate(
      { ctx, tokenId, publicUrl: PUBLIC_URL, serverId: server.id },
      { tabId: null, url: `${api.origin}/start` },
      { allowedByOwner: true },
    )
    const tabId = textOf(opened).match(/^Tab (\S+):/m)![1]!

    await takeOverTab(ctx, tabId)
    expect(textOf(await call("snapshot", {}))).toContain("taken over")
    // The token whose tab it was is the one Hand back offers first.
    expect(await tabFor(ctx, tabId)).toMatchObject({
      control: "owner",
      tokenId,
    })
    await ownerNavigate(ctx, tabId, {
      url: `http://localhost:${port}/account`,
      publicUrl: PUBLIC_URL,
    })
    await handBackTab(ctx, tabId, tokenId)

    const seen = textOf(await call("snapshot", {}))
    expect(seen).toContain(`Tab ${tabId}:`)
    expect(seen).toContain(`Address: http://localhost:${port}/account`)

    // Where the owner left it, the assistant may go on from, unasked.
    const next = await call("navigate", {
      url: `http://localhost:${port}/next`,
    })
    expect(textOf(next)).toContain('heading "/next"')

    // Another assistant neither sees it nor is handed it.
    const other = await otherToken()
    expect(textOf(await other.call("snapshot", { tab: tabId }))).toContain(
      `There is no tab ${tabId}`,
    )
  })

  it("hands a tab to another token without the sites allowed for the one before", async () => {
    const port = new URL(api.origin).port
    const host = new URL(api.origin).host
    const opened = await performNavigate(
      { ctx, tokenId, publicUrl: PUBLIC_URL, serverId: server.id },
      { tabId: null, url: `${api.origin}/start` },
      { allowedByOwner: true },
    )
    const tabId = textOf(opened).match(/^Tab (\S+):/m)![1]!

    await takeOverTab(ctx, tabId)
    await ownerNavigate(ctx, tabId, {
      url: `http://localhost:${port}/account`,
      publicUrl: PUBLIC_URL,
    })
    const other = await otherToken()
    await handBackTab(ctx, tabId, other.tokenId)

    // Allow once was the first token's: only the site the owner handed the
    // tab over at is allowed for it now.
    expect([
      ...runningBrowser(ctx.vaultId)!.tabs.get(tabId)!.allowedHosts,
    ]).toEqual([`localhost:${port}`])
    expect(textOf(await other.call("snapshot", {}))).toContain(
      `Address: http://localhost:${port}/account`,
    )
    await expect(
      other.call("navigate", { url: `${api.origin}/again` }),
    ).rejects.toSatisfy(isOwnerNeeded)
    expect(
      (await listFetchRules(ctx, other.tokenId)).sites.map((site) => site.host),
    ).toEqual([host])

    // The first token has lost it, as its current tab too.
    expect(textOf(await call("snapshot", {}))).toContain(
      "This token has no tab open",
    )
    expect(textOf(await call("tabs", { action: "list" }))).not.toContain(tabId)
  })

  it("hands a tab only to a live token of the vault that reaches the browser", async () => {
    const tab = await openOwnerTab(ctx, {
      url: `${api.origin}/login`,
      publicUrl: PUBLIC_URL,
    })

    const revoked = await createApiToken(ctx, {
      name: "Revoked",
      allowAllServers: true,
    })
    await revokeApiToken(ctx, revoked.id)
    const expired = await createApiToken(ctx, {
      name: "Expired",
      allowAllServers: true,
    })
    await db().apiToken.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    // Scoped to chosen servers, the browser not among them.
    const elsewhere = await createApiToken(ctx, {
      name: "No browser",
      allowAllServers: false,
      serverIds: [server.id],
    })
    await db().apiTokenServer.deleteMany({ where: { tokenId: elsewhere.id } })
    const chosen = await createApiToken(ctx, {
      name: "Browser only",
      allowAllServers: false,
      serverIds: [server.id],
    })
    // A token of another vault, with the same reach.
    await db().vault.create({ data: { id: "another", name: "Bob" } })
    await db().keyGrant.create({
      data: {
        id: "another-grant",
        vaultId: "another",
        kind: "token",
        kdf: "none",
        kdfParams: "{}",
        wrappedDek: Buffer.alloc(0),
      },
    })
    await db().apiToken.create({
      data: {
        id: "another-token",
        vaultId: "another",
        grantId: "another-grant",
        name: "Bob's",
        prefix: "pcp_",
        allowAllServers: true,
      },
    })

    expect((await browserTokens(ctx)).map((token) => token.name)).toEqual([
      "Browser only",
      "Claude",
    ])

    for (const id of [
      revoked.id,
      expired.id,
      elsewhere.id,
      "another-token",
      "nosuchtoken",
    ]) {
      await expect(handBackTab(ctx, tab.id, id), id).rejects.toThrow(
        /Choose a token that can use the browser/,
      )
    }
    expect(await tabFor(ctx, tab.id)).toMatchObject({
      control: "owner",
      tokenId: null,
    })

    await handBackTab(ctx, tab.id, chosen.id)
    expect(await tabFor(ctx, tab.id)).toMatchObject({ tokenId: chosen.id })
  })

  it("shows the tabs and the sign-ins, and forgets them all", async () => {
    await openOwnerTab(ctx, {
      url: `${api.origin}/login`,
      publicUrl: PUBLIC_URL,
    })

    const overview = await browserOverview(ctx)
    expect(overview.server).toMatchObject({ id: server.id, enabled: true })
    expect(overview.status).toMatchObject({ running: true, tabs: 1 })
    expect(overview.tabs).toHaveLength(1)
    expect(overview.profile).toMatchObject({ cookies: 1 })
    expect(overview.chromium).toMatchObject({
      path: executable,
      install: { stage: "idle" },
    })

    await forgetSites(ctx)
    const after = await browserOverview(ctx)
    expect(after.status.running).toBe(false)
    expect(after.profile).toBeNull()
  })

  it("gives Chromium a folder of its own outside the user's home, gone once it closes", async () => {
    // A system user with no home, as PCP's image runs as: Chromium's crash
    // reporter cannot make its database under ~/.config.
    const home = process.env.HOME
    process.env.HOME = "/nonexistent/pcp-home"
    try {
      await openOwnerTab(ctx, { url: `${api.origin}/`, publicUrl: PUBLIC_URL })
    } finally {
      process.env.HOME = home
    }

    const { scratchDir } = runningBrowser(ctx.vaultId)!
    expect(path.dirname(scratchDir)).toBe(os.tmpdir())
    const [product] = await fs.readdir(path.join(scratchDir, "config"))
    expect(
      existsSync(path.join(scratchDir, "config", product!, "Crash Reports")),
    ).toBe(true)

    await stopBrowser(ctx)
    await vi.waitFor(() => expect(existsSync(scratchDir)).toBe(false))
  })

  it("installs no Chromium where one is found", async () => {
    await expect(startChromiumInstall()).rejects.toThrow(/already on this/)
    expect((await browserOverview(ctx)).chromium.install.stage).toBe("idle")
  })

  it("asks to add the browser before it opens anything", async () => {
    await db().mcpServer.delete({ where: { id: server.id } })
    await expect(
      openOwnerTab(ctx, { url: `${api.origin}/`, publicUrl: PUBLIC_URL }),
    ).rejects.toThrow(/Add the browser first/)
  })
})
