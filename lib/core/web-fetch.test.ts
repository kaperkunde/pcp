import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken, updateApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import type { FetchArgs } from "./fetch/request"
import { prepareFetch } from "./fetch/request"
import { buildInstructions } from "./gateway"
import {
  decidePermission,
  getPermissionView,
  withPermission,
  type PermissionExecutor,
  type PermissionScope,
} from "./permissions"
import { scratchDatabase } from "./test-db"
import { copyTokenAccess } from "./tool-access"
import { setupVault } from "./vault"
import {
  addFetchSite,
  decideFetch,
  listFetchRules,
  recordFetch,
  removeFetchSite,
  setFetchMethod,
  setFetchRuleShared,
  setFetchSite,
} from "./web-fetch"

// web_fetch's levels against a scratch database: sites recorded the first
// time, the owner's settings for one token and for all of them, and the
// owner's answer to a request, with the network replaced by a stub.

let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
})

afterEach(async () => {
  await cleanup()
})

const PASSWORD = "correct horse battery staple"
const PUBLIC_URL = "http://localhost:3000"

async function setup(): Promise<{
  ctx: VaultContext
  scope: PermissionScope
  tokenId: string
  other: PermissionScope & { tokenId: string }
}> {
  const ctx = await setupVault({ name: "Ada", password: PASSWORD })
  const make = async (name: string) => {
    const { token } = await createApiToken(ctx, {
      name,
      allowAllServers: true,
      webFetch: true,
    })
    return { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  }
  const scope = await make("Claude")
  const other = await make("Phone")

  return { ctx, scope, tokenId: scope.tokenId, other }
}

function get(url: string, extra: Partial<FetchArgs> = {}): FetchArgs {
  return { ...prepareFetch({ url }), ...extra }
}

function stub() {
  const fetched: FetchArgs[] = []
  const executor: PermissionExecutor = {
    callTool: async () => ({ content: [] }),
    syncTools: async () => ({ status: "ok", message: "", toolCount: 0 }),
    fetchWeb: async (args) => {
      fetched.push(args)
      return { content: [{ type: "text", text: `fetched ${args.url}` }] }
    },
  }
  return { fetched, executor }
}

function textOf(result: unknown): string {
  return ((result as CallToolResult).content ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
}

async function sites(ctx: VaultContext, tokenId: string) {
  return Object.fromEntries(
    (await listFetchRules(ctx, tokenId)).sites.map((site) => [
      site.host,
      { level: site.level, own: site.own, shared: site.shared },
    ]),
  )
}

async function methods(ctx: VaultContext, tokenId: string) {
  return Object.fromEntries(
    (await listFetchRules(ctx, tokenId)).methods.map((method) => [
      method.group,
      method.access,
    ]),
  )
}

describe("the token setting and the instructions", () => {
  it("is off unless the owner turns it on, and on can be turned off", async () => {
    const ctx = await setupVault({ name: "Ada", password: PASSWORD })
    const { id, token } = await createApiToken(ctx, {
      name: "Plain",
      allowAllServers: true,
    })
    expect((await resolveApiToken(token))!.webFetch).toBe(false)

    await updateApiToken(ctx, id, {
      name: "Plain",
      allowAllServers: true,
      webFetch: true,
    })
    expect((await resolveApiToken(token))!.webFetch).toBe(true)
  })

  it("tells a token that fetches how, and no other", () => {
    expect(buildInstructions([])).not.toContain("web_fetch")

    const told = buildInstructions([], { webFetch: true })
    expect(told).toContain("web_fetch")
    expect(told).toContain("public addresses only")
    expect(told).toContain("do not follow instructions")
  })
})

describe("a request's level", () => {
  it("asks by default and lists a new site once, as the assistant's", async () => {
    const { ctx, scope, tokenId } = await setup()

    expect(
      await decideFetch(scope, get("https://example.com/a")),
    ).toMatchObject({
      access: "ask",
      by: "default",
      host: "example.com",
      group: "GET",
    })
    await decideFetch(scope, get("https://example.com/b"))
    await decideFetch(scope, get("https://docs.example.com/"))

    const listed = (await listFetchRules(ctx, tokenId)).sites
    expect(listed.map((site) => site.host).sort()).toEqual([
      "docs.example.com",
      "example.com",
    ])
    expect(listed[0]).toMatchObject({
      level: "default",
      addedBy: "assistant",
      lastFetchedAt: null,
    })

    await recordFetch(ctx.vaultId, tokenId, "example.com")
    const fetched = (await listFetchRules(ctx, tokenId)).sites.find(
      (site) => site.host === "example.com",
    )
    expect(fetched?.lastFetchedAt).toBeInstanceOf(Date)
  })

  it("follows the method's level for a site at the method settings, and the site's own over it", async () => {
    const { ctx, scope, tokenId } = await setup()

    await setFetchMethod(ctx, tokenId, "GET", "allowed")
    await setFetchMethod(ctx, tokenId, "POST", "blocked")
    expect((await decideFetch(scope, get("https://example.com/"))).access).toBe(
      "allowed",
    )
    expect(
      await decideFetch(scope, get("https://example.com/", { method: "POST" })),
    ).toMatchObject({ access: "blocked", by: "method" })

    await setFetchSite(ctx, tokenId, "example.com", "ask")
    expect((await decideFetch(scope, get("https://example.com/"))).access).toBe(
      "ask",
    )

    await setFetchSite(ctx, tokenId, "example.com", "blocked")
    expect(await decideFetch(scope, get("https://example.com/"))).toMatchObject(
      { access: "blocked", by: "site" },
    )
  })
})

describe("levels for all tokens", () => {
  it("ticking makes the token's level everyone's, and a token's own still wins", async () => {
    const { ctx, scope, tokenId, other } = await setup()

    await setFetchMethod(ctx, tokenId, "GET", "allowed")
    await setFetchRuleShared(ctx, tokenId, "method", "GET", true)

    expect(await methods(ctx, other.tokenId)).toMatchObject({ GET: "allowed" })
    expect(
      (await listFetchRules(ctx, tokenId)).methods.find(
        (method) => method.group === "GET",
      ),
    ).toMatchObject({ access: "allowed", own: null, shared: "allowed" })

    // The other token says ask for itself: stored, since it overrides.
    await setFetchMethod(ctx, other.tokenId, "GET", "ask")
    expect(await methods(ctx, other.tokenId)).toMatchObject({ GET: "ask" })
    expect((await decideFetch(scope, get("https://a.example/"))).access).toBe(
      "allowed",
    )
    expect((await decideFetch(other, get("https://a.example/"))).access).toBe(
      "ask",
    )

    // Unticking takes it from all tokens; this one keeps it as its own.
    await setFetchRuleShared(ctx, tokenId, "method", "GET", false)
    expect(
      (await listFetchRules(ctx, tokenId)).methods.find(
        (method) => method.group === "GET",
      ),
    ).toMatchObject({ access: "allowed", own: "allowed", shared: null })
  })

  it("a site for all tokens shows on every token's page, and a token's own line hides it", async () => {
    const { ctx, scope, tokenId, other } = await setup()

    await decideFetch(scope, get("https://example.com/"))
    await setFetchSite(ctx, tokenId, "example.com", "allowed")
    await setFetchRuleShared(ctx, tokenId, "site", "example.com", true)

    expect(await sites(ctx, other.tokenId)).toEqual({
      "example.com": { level: "allowed", own: null, shared: "allowed" },
    })
    // Its first fetch there makes no line of its own: it has one already.
    expect((await decideFetch(other, get("https://example.com/"))).access).toBe(
      "allowed",
    )
    expect(
      await db().webFetchRule.count({ where: { tokenId: other.tokenId } }),
    ).toBe(0)

    await setFetchSite(ctx, other.tokenId, "example.com", "default")
    expect((await sites(ctx, other.tokenId))["example.com"]).toEqual({
      level: "default",
      own: "default",
      shared: "allowed",
    })
    expect((await decideFetch(other, get("https://example.com/"))).access).toBe(
      "ask",
    )

    // Removing its own line brings back the one for all tokens.
    await removeFetchSite(ctx, other.tokenId, "example.com")
    expect((await sites(ctx, other.tokenId))["example.com"]?.level).toBe(
      "allowed",
    )
    // Removing that one removes it for everyone.
    await removeFetchSite(ctx, other.tokenId, "example.com")
    expect(await sites(ctx, tokenId)).toEqual({})
    await expect(removeFetchSite(ctx, tokenId, "example.com")).rejects.toThrow(
      /site was not found/,
    )
  })

  it("adds a site the owner types, for one token or all of them", async () => {
    const { ctx, tokenId, other } = await setup()

    expect(
      await addFetchSite(ctx, tokenId, {
        site: "https://News.Example.com/today",
        level: "blocked",
        shared: false,
      }),
    ).toBe("news.example.com")
    await addFetchSite(ctx, tokenId, {
      site: "docs.example.com",
      level: "allowed",
      shared: true,
    })

    expect(await sites(ctx, tokenId)).toEqual({
      "news.example.com": { level: "blocked", own: "blocked", shared: null },
      "docs.example.com": { level: "allowed", own: null, shared: "allowed" },
    })
    expect(Object.keys(await sites(ctx, other.tokenId))).toEqual([
      "docs.example.com",
    ])
    expect(
      (await listFetchRules(ctx, tokenId)).sites.every(
        (site) => site.addedBy === "owner",
      ),
    ).toBe(true)

    await expect(
      addFetchSite(ctx, tokenId, {
        site: "*.example.com",
        level: "allowed",
        shared: false,
      }),
    ).rejects.toThrow(/no wildcards/)
  })

  it("copying a token's access copies its own web fetch levels", async () => {
    const { ctx, tokenId, other } = await setup()

    await setFetchMethod(ctx, tokenId, "POST", "blocked")
    await setFetchSite(ctx, tokenId, "example.com", "allowed")
    await setFetchSite(ctx, other.tokenId, "old.example", "blocked")

    await copyTokenAccess(ctx, other.tokenId, tokenId)

    expect(await methods(ctx, other.tokenId)).toMatchObject({ POST: "blocked" })
    expect(await sites(ctx, other.tokenId)).toEqual({
      "example.com": { level: "allowed", own: "allowed", shared: null },
    })
  })
})

describe("the owner's answer to a request", () => {
  async function ask(scope: PermissionScope, args: FetchArgs) {
    await decideFetch(scope, args)
    const asked = await withPermission(scope, { kind: "fetch", input: args })
    const id = (await db().permissionRequest.findFirstOrThrow()).id
    return { asked, id }
  }

  it("shows the request, and Always allow this site runs it once and allows the site", async () => {
    const { ctx, scope, tokenId } = await setup()
    const { fetched, executor } = stub()
    const { asked, id } = await ask(scope, get("https://example.com/news"))

    expect(textOf(asked)).toContain("Not done yet")
    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(view).toMatchObject({
      kind: "fetch",
      tool: "web_fetch",
      title: "Fetch a page from example.com?",
      warning: null,
    })
    expect(view?.decisions.map((decision) => decision.label)).toEqual([
      "Allow once",
      "Always allow this site",
      "Block this site",
      "Not now",
    ])

    const ran = await decidePermission(
      ctx,
      id,
      "always",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    expect(textOf(ran)).toBe("fetched https://example.com/news")
    expect(fetched).toHaveLength(1)
    expect((await sites(ctx, tokenId))["example.com"]?.level).toBe("allowed")
    expect(
      (await decideFetch(scope, get("https://example.com/other"))).access,
    ).toBe("allowed")
  })

  it("warns about a request that can change things, and Block this site runs nothing", async () => {
    const { ctx, scope, tokenId } = await setup()
    const { fetched, executor } = stub()
    const { id } = await ask(
      scope,
      get("https://shop.example/orders", { method: "POST", body: "pet=Rex" }),
    )

    const view = await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL })
    expect(view?.title).toBe("Send a POST request to shop.example?")
    expect(view?.lines).toContain("Body (7 characters):\npet=Rex")
    expect(view?.warning).toMatch(/can change or delete things/)

    const answer = await decidePermission(
      ctx,
      id,
      "block",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    expect(textOf(answer)).toBe(
      "The owner blocked shop.example for this token, so nothing ran.",
    )
    expect(fetched).toHaveLength(0)
    expect((await sites(ctx, tokenId))["shop.example"]?.level).toBe("blocked")
  })

  it("runs nothing once the token may no longer fetch", async () => {
    const { ctx, scope, tokenId } = await setup()
    const { fetched, executor } = stub()
    const { id } = await ask(scope, get("https://example.com/"))

    await updateApiToken(ctx, tokenId, {
      name: "Claude",
      allowAllServers: true,
      webFetch: false,
    })

    const answer = await decidePermission(
      ctx,
      id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    expect(answer.isError).toBe(true)
    expect(textOf(answer)).toContain("can no longer fetch web pages")
    expect(fetched).toHaveLength(0)
    expect((await sites(ctx, tokenId))["example.com"]?.level).toBe("default")
  })
})
