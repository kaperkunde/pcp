import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { McpServer } from "@/lib/generated/prisma/client"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import { startTestApi, type TestApi } from "../openapi/test-api"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { setFetchPrivate, setFetchRuleShared } from "../web-fetch"
import { callBrowserTool } from "./call"
import { chromiumFromEnvironment } from "./executable"
import {
  browserOverview,
  forgetSites,
  handBackTab,
  openOwnerTab,
  ownerNavigate,
  takeOverTab,
} from "./owner"
import { loadProfile } from "./profile"
import { closeAllBrowsers } from "./runtime"
import { createBrowserServer } from "./server"

// What the owner does from PCP's pages, against a real Chromium: a tab of
// their own that assistants leave alone until handed back, and the sign-ins
// forgotten.

const executable = await chromiumFromEnvironment()
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

describe.skipIf(!executable)("the owner's tabs", { timeout: 90_000 }, () => {
  it("opens a tab of their own, which assistants leave alone until it is handed back", async () => {
    const tab = await openOwnerTab(ctx, {
      url: `${api.origin}/login`,
      publicUrl: PUBLIC_URL,
    })
    expect(tab).toMatchObject({
      openedBy: "owner",
      control: "owner",
      url: `${api.origin}/login`,
    })
    expect(
      (await loadProfile(ctx))?.cookies.map((cookie) => cookie.name),
    ).toEqual(["session"])

    const call = (name: string, args: Record<string, unknown>) =>
      callBrowserTool(ctx, server, name, args, {
        tokenId,
        publicUrl: PUBLIC_URL,
      })

    const refused = await call("snapshot", { tab: tab.id })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("taken over")

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

    await handBackTab(ctx, tab.id)
    const seen = await call("snapshot", { tab: tab.id })
    expect(textOf(seen)).toContain(`Address: ${api.origin}/account`)

    // Where the owner left it, the assistant may go on from, unasked.
    const next = await call("navigate", {
      tab: tab.id,
      url: `${api.origin}/next`,
    })
    expect(textOf(next)).toContain('heading "/next"')

    await takeOverTab(ctx, tab.id)
    await expect(
      ownerNavigate(ctx, tab.id, {
        url: `${api.origin}/again`,
        publicUrl: PUBLIC_URL,
      }),
    ).resolves.toBeUndefined()
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

    await forgetSites(ctx)
    const after = await browserOverview(ctx)
    expect(after.status.running).toBe(false)
    expect(after.profile).toBeNull()
  })

  it("asks to add the browser before it opens anything", async () => {
    await db().mcpServer.delete({ where: { id: server.id } })
    await expect(
      openOwnerTab(ctx, { url: `${api.origin}/`, publicUrl: PUBLIC_URL }),
    ).rejects.toThrow(/Add the browser first/)
  })
})
