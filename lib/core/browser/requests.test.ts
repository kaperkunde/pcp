import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { McpServer } from "@/lib/generated/prisma/client"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import { buildInstructions, loadGatewayServers } from "../gateway"
import {
  checkPermission,
  decidePermission,
  getPermissionView,
  runCall,
  withPermission,
  type PermissionExecutor,
} from "../permissions"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { resolveFetchAccess } from "../fetch/rules"
import { listFetchRules, loadFetchRules } from "../web-fetch"
import { createBrowserServer, findBrowserServer } from "./server"
import { OwnerNeeded } from "./types"

// The browser's requests to the owner, with the browser itself replaced:
// a site to open, asked like a web fetch and answered per site, and a tab
// handed over until the owner says Done.

let cleanup: () => Promise<void>
let ctx: VaultContext
let tokenId: string
let server: McpServer
let token = ""

async function resolveApiTokenFor() {
  return (await resolveApiToken(token))!
}

const PUBLIC_URL = "http://localhost:3000"

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  ;({ token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  }))
  tokenId = (await resolveApiToken(token))!.tokenId
  await createBrowserServer(ctx)
  server = (await findBrowserServer(ctx))!
})

afterEach(async () => {
  await cleanup()
})

function textOf(result: unknown): string {
  return ((result as CallToolResult).content ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
}

/** The browser, replaced: a tool that needs the owner throws for them. */
function executor(needs: OwnerNeeded["ask"]): PermissionExecutor & {
  opened: Array<{ url: string; tabId: string | null }>
} {
  const opened: Array<{ url: string; tabId: string | null }> = []

  return {
    opened,
    callTool: async () => {
      throw new OwnerNeeded(needs)
    },
    syncTools: async () => ({ status: "ok", message: "", toolCount: 15 }),
    browse: async (_scope, ask) => {
      opened.push(ask)
      return { content: [{ type: "text", text: `opened ${ask.url}` }] }
    },
  }
}

function idOf(asked: CallToolResult): string {
  return textOf(asked).match(/\/permissions\/([\w-]+)/)![1]!
}

describe("the browser in the registry and the instructions", () => {
  it("is added once, with its tools, and told to a token that reaches it", async () => {
    await expect(createBrowserServer(ctx)).rejects.toMatchObject({
      code: "conflict",
    })
    expect(server).toMatchObject({
      kind: "browser",
      url: "pcp:browser",
      slug: "browser",
    })
    expect(await db().mcpTool.count({ where: { serverId: server.id } })).toBe(
      15,
    )

    const scope = { ...(await resolveApiTokenFor()), publicUrl: PUBLIC_URL }
    const servers = await loadGatewayServers(scope)
    const told = buildInstructions(servers)
    expect(told).toContain("- browser:")
    expect(told).toContain("browser/hand_over")
  })
})

describe("opening a site the owner has not decided", () => {
  it("asks, shows the site, and Always allow this site opens it and allows it for the token", async () => {
    const run = executor({
      kind: "browse",
      input: {
        serverId: server.id,
        tabId: null,
        url: "https://news.example/today",
        toolName: "navigate",
      },
    })

    const asked = await runCall(
      ctx,
      server,
      "navigate",
      { url: "https://news.example/today" },
      {
        publicUrl: PUBLIC_URL,
        tokenId,
        executor: run,
      },
    )
    expect(textOf(asked)).toContain("Not done yet")
    const id = idOf(asked)

    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(view).toMatchObject({
      kind: "browse",
      tool: "navigate",
      serverId: server.id,
      title: "Open news.example in the browser?",
      browserTabId: null,
    })
    expect(view?.lines).toContain("Address: https://news.example/today")
    expect(view?.warning).toMatch(/keeps your sign-ins/)
    expect(view?.decisions.map((decision) => decision.label)).toEqual([
      "Allow once",
      "Allow this site for",
      "Always allow this site",
      "Block this site",
      "Not now",
    ])

    const answer = await decidePermission(
      ctx,
      id,
      "always",
      { publicUrl: PUBLIC_URL },
      run,
    )
    expect(textOf(answer)).toBe("opened https://news.example/today")
    expect(run.opened).toEqual([
      { tabId: null, url: "https://news.example/today" },
    ])
    expect(
      (await listFetchRules(ctx, tokenId)).sites.find(
        (site) => site.host === "news.example",
      )?.level,
    ).toBe("allowed")
    expect(
      textOf(
        await checkPermission({ ctx, tokenId, publicUrl: PUBLIC_URL }, id, {
          waitMs: 0,
        }),
      ),
    ).toContain("opened https://news.example/today")
  })

  it("Allow this site for opens it and lets the token's tabs open it for that long", async () => {
    const run = executor({
      kind: "browse",
      input: {
        serverId: server.id,
        tabId: null,
        url: "https://news.example/today",
        toolName: "navigate",
      },
    })
    const id = idOf(
      await runCall(
        ctx,
        server,
        "navigate",
        { url: "https://news.example/today" },
        { publicUrl: PUBLIC_URL, tokenId, executor: run },
      ),
    )

    const answer = await decidePermission(
      ctx,
      id,
      "allow_for",
      { publicUrl: PUBLIC_URL, minutes: 15 },
      run,
    )
    expect(textOf(answer)).toBe("opened https://news.example/today")
    const rules = await loadFetchRules(ctx.vaultId, tokenId)
    expect(resolveFetchAccess(rules, "news.example", "GET").access).toBe(
      "allowed",
    )
    expect(
      resolveFetchAccess(rules, "news.example", "GET", Date.now() + 16 * 60_000)
        .access,
    ).toBe("ask")
    expect(
      (await listFetchRules(ctx, tokenId)).sites.find(
        (site) => site.host === "news.example",
      )?.level,
    ).not.toBe("allowed")
  })

  it("Block this site opens nothing and blocks it for the token", async () => {
    const run = executor({
      kind: "browse",
      input: {
        serverId: server.id,
        tabId: "t1",
        url: "https://ads.example/",
        toolName: "navigate",
      },
    })
    const id = idOf(
      await runCall(
        ctx,
        server,
        "navigate",
        { url: "https://ads.example/" },
        {
          publicUrl: PUBLIC_URL,
          tokenId,
          executor: run,
        },
      ),
    )
    expect(
      (await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL }))
        ?.browserTabId,
    ).toBe("t1")

    const answer = await decidePermission(
      ctx,
      id,
      "block",
      { publicUrl: PUBLIC_URL },
      run,
    )
    expect(textOf(answer)).toBe(
      "The owner blocked ads.example for this token, so nothing ran.",
    )
    expect(run.opened).toEqual([])
    expect(
      (await listFetchRules(ctx, tokenId)).sites.find(
        (site) => site.host === "ads.example",
      )?.level,
    ).toBe("blocked")
  })

  it("opens nothing once the browser is switched off", async () => {
    const run = executor({
      kind: "browse",
      input: {
        serverId: server.id,
        tabId: null,
        url: "https://a.example/",
        toolName: "tabs",
      },
    })
    const id = idOf(
      await runCall(
        ctx,
        server,
        "tabs",
        { action: "open", url: "https://a.example/" },
        {
          publicUrl: PUBLIC_URL,
          tokenId,
          executor: run,
        },
      ),
    )
    await db().mcpServer.update({
      where: { id: server.id },
      data: { enabled: false },
    })

    const answer = await decidePermission(
      ctx,
      id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      run,
    )
    expect(answer.isError).toBe(true)
    expect(textOf(answer)).toContain("switched off")
    expect(run.opened).toEqual([])
  })
})

describe("a browser call the owner allowed", () => {
  /** The owner asked about the call itself, as a tool at "ask" is. */
  async function askedCall(tool: string, args: Record<string, unknown>) {
    const asked = await withPermission(
      { ctx, tokenId, publicUrl: PUBLIC_URL },
      { kind: "call", server, tool: { name: tool }, args },
    )
    return idOf(asked)
  }

  it("opens the site it names without asking about the site again", async () => {
    const run = executor({
      kind: "browse",
      input: {
        serverId: server.id,
        tabId: "t1",
        url: "https://news.example/today",
        toolName: "navigate",
      },
    })
    const id = await askedCall("navigate", {
      url: "https://news.example/today",
      tab: "t1",
    })
    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(view).toMatchObject({ kind: "call", serverKind: "browser" })

    const answer = await decidePermission(
      ctx,
      id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      run,
    )

    expect(textOf(answer)).toBe("opened https://news.example/today")
    expect(run.opened).toEqual([
      { tabId: "t1", url: "https://news.example/today" },
    ])
    expect(await db().permissionRequest.count()).toBe(1)
    // Allowed for the tab, not for the token: the token's sites are as they were.
    expect(
      (await listFetchRules(ctx, tokenId)).sites.find(
        (site) => site.host === "news.example",
      )?.level,
    ).not.toBe("allowed")
  })

  it("still asks for a hand-over, which is another question", async () => {
    const run = executor({
      kind: "browser_handover",
      input: {
        serverId: server.id,
        tabId: "t1",
        message: "Please sign in.",
        url: "https://shop.example/login",
        title: "Sign in",
      },
    })
    const id = await askedCall("hand_over", { message: "Please sign in." })

    const answer = await decidePermission(
      ctx,
      id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      run,
    )

    expect(textOf(answer)).toContain("Not done yet")
    expect(run.opened).toEqual([])
    expect(
      await db().permissionRequest.count({
        where: { kind: "browser_handover" },
      }),
    ).toBe(1)
  })
})

describe("handing a tab over", () => {
  it("shows the assistant's words and the tab, and Done or Not now answers it", async () => {
    const needs: OwnerNeeded["ask"] = {
      kind: "browser_handover",
      input: {
        serverId: server.id,
        tabId: "tab1",
        message: "Please solve the CAPTCHA.",
        url: "https://shop.example/login",
        title: "Sign in",
      },
    }
    const run = executor(needs)
    const asked = await runCall(
      ctx,
      server,
      "hand_over",
      { message: "Please solve the CAPTCHA." },
      {
        publicUrl: PUBLIC_URL,
        tokenId,
        executor: run,
      },
    )
    const id = idOf(asked)
    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })

    expect(view).toMatchObject({
      kind: "browser_handover",
      tool: "hand_over",
      title: "An assistant needs you in the browser",
      browserTabId: "tab1",
    })
    expect(view?.lines).toContain("It says: Please solve the CAPTCHA.")
    expect(view?.decisions.map((decision) => decision.label)).toEqual([
      "Done",
      "Not now",
    ])

    // The browser is not running here, so the tab is gone.
    const done = await decidePermission(
      ctx,
      id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      run,
    )
    expect(textOf(done)).toContain("Tab tab1 is gone")

    const again = idOf(
      await runCall(
        ctx,
        server,
        "hand_over",
        { message: "Once more" },
        {
          publicUrl: PUBLIC_URL,
          tokenId,
          executor: executor({
            ...needs,
            input: { ...needs.input, message: "Once more" },
          }),
        },
      ),
    )
    const notNow = await decidePermission(
      ctx,
      again,
      "decline",
      { publicUrl: PUBLIC_URL },
      run,
    )
    expect(textOf(notNow)).toContain("said not now")
  })
})
