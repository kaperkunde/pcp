import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { McpServer } from "@/lib/generated/prisma/client"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import { startTestApi, type TestApi } from "../openapi/test-api"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { setFetchPrivate, setFetchRuleShared, setFetchSite } from "../web-fetch"
import { callBrowserTool, performNavigate } from "./call"
import { chromiumExecutable } from "./executable"
import {
  browserOverview,
  forgetSites,
  handBackTab,
  openOwnerTab,
  ownerNavigate,
  startChromiumInstall,
  stopBrowser,
  takeOverTab,
} from "./owner"
import { loadProfile } from "./profile"
import { closeAllBrowsers, runningBrowser } from "./runtime"
import { createBrowserServer } from "./server"

// What the owner does from PCP's pages, against a real Chromium: a tab of
// their own that no assistant sees, an assistant's tab taken over and handed
// back to that assistant alone, and the sign-ins forgotten.

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

describe.skipIf(!executable)("the owner's tabs", { timeout: 90_000 }, () => {
  it("opens a tab of their own, which no assistant sees or is handed", async () => {
    const tab = await openOwnerTab(ctx, {
      url: `${api.origin}/login`,
      publicUrl: PUBLIC_URL,
    })
    expect(tab).toMatchObject({
      openedBy: "owner",
      ownersOwn: true,
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

    // There is no assistant to hand it back to.
    await expect(handBackTab(ctx, tab.id)).rejects.toThrow(/stays yours/)
    expect((await browserOverview(ctx)).tabs[0]).toMatchObject({
      control: "owner",
    })
    expect(textOf(await call("snapshot", { tab: tab.id }))).toContain(
      `There is no tab ${tab.id}`,
    )

    // A navigate naming it opens a tab of the assistant's own.
    await setFetchSite(ctx, tokenId, new URL(api.origin).host, "allowed")
    const elsewhere = await call("navigate", {
      tab: tab.id,
      url: `${api.origin}/next`,
    })
    expect(textOf(elsewhere)).toContain('heading "/next"')
    expect(textOf(elsewhere)).not.toContain(`Tab ${tab.id}:`)
    expect((await browserOverview(ctx)).tabs[0]).toMatchObject({
      id: tab.id,
      url: `${api.origin}/account`,
    })
  })

  it("takes over an assistant's tab and hands it back to that assistant alone", async () => {
    const port = new URL(api.origin).port
    const opened = await performNavigate(
      { ctx, tokenId, publicUrl: PUBLIC_URL, serverId: server.id },
      { tabId: null, url: `${api.origin}/start` },
      { allowedByOwner: true },
    )
    const tabId = textOf(opened).match(/^Tab (\S+):/m)![1]!

    await takeOverTab(ctx, tabId)
    expect(textOf(await call("snapshot", {}))).toContain("taken over")
    await ownerNavigate(ctx, tabId, {
      url: `http://localhost:${port}/account`,
      publicUrl: PUBLIC_URL,
    })
    await handBackTab(ctx, tabId)

    const seen = textOf(await call("snapshot", {}))
    expect(seen).toContain(`Tab ${tabId}:`)
    expect(seen).toContain(`Address: http://localhost:${port}/account`)

    // Where the owner left it, the assistant may go on from, unasked.
    const next = await call("navigate", {
      url: `http://localhost:${port}/next`,
    })
    expect(textOf(next)).toContain('heading "/next"')

    // Another assistant neither sees it nor is handed it.
    const { token } = await createApiToken(ctx, {
      name: "Other",
      allowAllServers: true,
    })
    const other = (await resolveApiToken(token))!.tokenId
    const theirs = await callBrowserTool(
      ctx,
      server,
      "snapshot",
      { tab: tabId },
      { tokenId: other, publicUrl: PUBLIC_URL },
    )
    expect(textOf(theirs)).toContain(`There is no tab ${tabId}`)
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
