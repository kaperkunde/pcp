import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { listTokenAllowances, pruneAllowances } from "./allowances"
import { createApiToken, resolveApiToken } from "./api-tokens"
import {
  admitSecretUse,
  bindOrigin,
  canCoverSubdomains,
  checkSecretRequest,
  checkSecretSitesChange,
  coveringOrigins,
  endSecretAllowance,
  grantSecretUse,
  isBoundOrigin,
  listBrowserOrigins,
  listSecretAllowances,
  originOf,
  parseOrigins,
  SECRET_ONCE_MS,
  showSecretSitesChange,
  signInsAt,
  siteCovers,
  sitesOf,
  takeSecretUse,
  unbindOrigin,
} from "./browser-secrets"
import { createBrowserServer } from "./browser/server"
import { isOwnerNeeded, type SecretUseContext } from "./browser/types"
import type { VaultContext } from "./context"
import { db } from "./db"
import {
  decidePermission,
  getPermissionView,
  runCall,
  withPermission,
  type PermissionExecutor,
} from "./permissions"
import {
  createSecret,
  readTypedLogin,
  readTypedValue,
  revealSecret,
  revealTotpCode,
  updateSecret,
} from "./secrets"
import { createServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { totpCode } from "./totp"
import { writeToolAccess } from "./tool-access"
import { DEFAULT_PASSWORD_RECIPE } from "./constants"
import { SECRET_SIGN_IN_WINDOW_MS } from "./browser/limits"
import { setupVault } from "./vault"
import { secretName, secretNameWhere } from "./secret-meta"

// Secrets the browser types, against a scratch database: the sites a secret
// belongs to, a token's allowance per secret and site (once, an hour,
// always), the gate every type call passes, request_secret's checks, and
// the owner's answers to both requests. The browser itself is stubbed: what
// it types is in browser/secrets.test.ts.

const PUBLIC_URL = "http://localhost:3000"
const SHOP = "https://shop.example"
const VALUE = "hunter2-very-secret"
// "12345678901234567890" in base32: RFC 6238's seed.
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

let cleanup: () => Promise<void>
let ctx: VaultContext
let tokenId: string
let serverId: string
let secretId: string

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({ name: "Ada", password: "correct horse battery" })
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  })
  tokenId = (await resolveApiToken(token))!.tokenId
  serverId = (await createBrowserServer(ctx)).id
  ;({ id: secretId } = await createSecret(ctx, {
    name: "Shop password",
    value: VALUE,
  }))
})

afterEach(async () => {
  await cleanup()
})

function pageAt(origin: string): SecretUseContext {
  return {
    tabId: "t1",
    origin,
    url: `${origin}/login`,
    title: "Sign in",
    field: 'the textbox "Password"',
    call: { tab: "t1", ref: "e3" },
  }
}

async function asks(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (isOwnerNeeded(error)) return error.ask
    throw error
  }
  throw new Error("expected the owner to be asked")
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
}

function stub() {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const executor: PermissionExecutor = {
    callTool: async (_ctx, _server, tool, args) => {
      calls.push({ tool, args })
      return { content: [{ type: "text", text: `ran ${tool}` }] }
    },
    syncTools: async () => ({ status: "ok", message: "", toolCount: 0 }),
  }

  return { calls, executor }
}

describe("a secret's sites", () => {
  it("are origins, taken from an address, http(s) only", () => {
    expect(originOf("https://shop.example/login?next=1")).toBe(SHOP)
    expect(originOf("http://shop.example:8080/x")).toBe(
      "http://shop.example:8080",
    )
    expect(originOf("about:blank")).toBeNull()
    expect(originOf("about:srcdoc")).toBeNull()
    expect(originOf("not an address")).toBeNull()

    expect(
      parseOrigins([
        "https://shop.example/login",
        "shop.example",
        " ",
        "https://SHOP.example/",
      ]),
    ).toEqual([SHOP])
    expect(() => parseOrigins(["ftp://shop.example"])).toThrow(/http/)
    expect(() => parseOrigins(["https://me:pw@shop.example"])).toThrow(
      /user name/,
    )
    expect(() =>
      parseOrigins(
        Array.from({ length: 11 }, (_, i) => `https://s${i}.example`),
      ),
    ).toThrow(/at most 10/)
  })

  it("are added and taken away by the owner, taking the allowances there with them", async () => {
    expect(await bindOrigin(ctx, secretId, "https://shop.example/login")).toBe(
      SHOP,
    )
    expect(await listBrowserOrigins(ctx)).toEqual(
      new Map([[secretId, [{ origin: SHOP, subdomains: false }]]]),
    )
    await grantSecretUse(ctx, {
      tokenId,
      secretId,
      origin: SHOP,
      level: "hour",
    })

    await unbindOrigin(ctx, secretId, SHOP)

    expect(await isBoundOrigin(secretId, SHOP)).toBe(false)
    expect(await listSecretAllowances(ctx)).toEqual([])
  })
})

describe("a site with its subdomains", () => {
  const WATERNET = "https://waternet.nl"

  it("covers hosts under it within its registrable domain only", () => {
    const site = { origin: WATERNET, subdomains: true }

    expect(siteCovers(site, WATERNET)).toBe(true)
    expect(siteCovers(site, "https://www.waternet.nl")).toBe(true)
    expect(siteCovers(site, "https://a.b.waternet.nl")).toBe(true)
    // Lookalikes, another scheme or port, and the exact site without the flag.
    expect(siteCovers(site, "https://notwaternet.nl")).toBe(false)
    expect(siteCovers(site, "https://waternet.nl.evil.com")).toBe(false)
    expect(siteCovers(site, "https://waternet.nlx")).toBe(false)
    expect(siteCovers(site, "http://www.waternet.nl")).toBe(false)
    expect(siteCovers(site, "https://www.waternet.nl:8443")).toBe(false)
    expect(
      siteCovers(
        { origin: WATERNET, subdomains: false },
        "https://www.waternet.nl",
      ),
    ).toBe(false)
    // A public suffix under it is someone else's registrable domain.
    expect(
      siteCovers(
        { origin: "https://amazonaws.com", subdomains: true },
        "https://bucket.s3.amazonaws.com",
      ),
    ).toBe(false)
    expect(
      siteCovers(
        { origin: "https://ada.github.io", subdomains: true },
        "https://www.ada.github.io",
      ),
    ).toBe(true)
  })

  it("is only for a host with a registrable domain", () => {
    expect(canCoverSubdomains("https://www.example.co.uk")).toBe(true)
    expect(canCoverSubdomains("https://co.uk")).toBe(false)
    expect(canCoverSubdomains("https://github.io")).toBe(false)
    expect(canCoverSubdomains("https://s3.amazonaws.com")).toBe(false)
    expect(canCoverSubdomains("http://localhost:3000")).toBe(false)
    expect(canCoverSubdomains("https://192.168.1.10")).toBe(false)
    expect(canCoverSubdomains("https://[::1]")).toBe(false)
  })

  it("is looked up by the parents of a host, down to its domain", () => {
    expect(coveringOrigins("https://a.b.waternet.nl:8443")).toEqual([
      "https://b.waternet.nl:8443",
      "https://waternet.nl:8443",
    ])
    expect(coveringOrigins("https://www.example.co.uk")).toEqual([
      "https://example.co.uk",
    ])
    expect(coveringOrigins("https://waternet.nl")).toEqual([])
    expect(coveringOrigins("http://127.0.0.1:8080")).toEqual([])
  })

  it("binds the secret there, names it there and lets an always use through there", async () => {
    await expect(
      bindOrigin(ctx, secretId, "https://github.io", { subdomains: true }),
    ).rejects.toThrow(/cannot stand for its subdomains/)
    await bindOrigin(ctx, secretId, WATERNET, { subdomains: true })

    expect(await sitesOf(secretId)).toEqual([
      { origin: WATERNET, subdomains: true },
    ])
    expect(await isBoundOrigin(secretId, "https://mijn.waternet.nl")).toBe(true)
    expect(await isBoundOrigin(secretId, "https://waternet.nl.evil.com")).toBe(
      false,
    )
    expect(
      (await signInsAt(ctx, "https://www.waternet.nl", 5)).map((s) => s.name),
    ).toEqual(["Shop password"])
    expect(await signInsAt(ctx, "https://notwaternet.nl", 5)).toEqual([])

    await grantSecretUse(ctx, {
      tokenId,
      secretId,
      origin: "https://www.waternet.nl",
      level: "always",
    })
    expect(
      await takeSecretUse({
        tokenId,
        secretId,
        origin: "https://www.waternet.nl",
      }),
    ).toBe(true)
  })

  it("takes the allowances under it away with it, or when it stops covering them", async () => {
    await bindOrigin(ctx, secretId, WATERNET, { subdomains: true })
    for (const origin of [
      "https://www.waternet.nl",
      "https://mijn.waternet.nl",
    ]) {
      await grantSecretUse(ctx, { tokenId, secretId, origin, level: "hour" })
    }
    // Added on its own too: that one stays when the flag goes.
    await bindOrigin(ctx, secretId, "https://mijn.waternet.nl")

    // Added again without the flag: only the host itself.
    await bindOrigin(ctx, secretId, WATERNET, { subdomains: false })
    expect(
      (await listSecretAllowances(ctx)).map((allowance) => allowance.origin),
    ).toEqual(["https://mijn.waternet.nl"])

    await bindOrigin(ctx, secretId, WATERNET, { subdomains: true })
    await grantSecretUse(ctx, {
      tokenId,
      secretId,
      origin: "https://www.waternet.nl",
      level: "hour",
    })
    await unbindOrigin(ctx, secretId, WATERNET)
    expect(
      (await listSecretAllowances(ctx)).map((allowance) => allowance.origin),
    ).toEqual(["https://mijn.waternet.nl"])
  })

  it("keeps a bound site's subdomains unless the owner says otherwise", async () => {
    await bindOrigin(ctx, secretId, WATERNET, { subdomains: true })
    // An "always" answer binds the exact origin, leaving the flag as it is.
    await bindOrigin(ctx, secretId, WATERNET)
    expect(await sitesOf(secretId)).toEqual([
      { origin: WATERNET, subdomains: true },
    ])
  })
})

describe("the sign-ins at a site", () => {
  it("are the owner's secrets bound to its origin, with what they said of each, never a value", async () => {
    const codes = await createSecret(ctx, {
      name: "Shop code",
      value: SEED,
      kind: "totp",
    })
    const loose = await createSecret(ctx, {
      name: "Old code",
      value: SEED,
      kind: "totp",
    })
    const elsewhere = await createSecret(ctx, {
      name: "Bank password",
      value: "bank-value",
    })
    await updateSecret(ctx, secretId, {
      loginName: "ada@example.com",
      note: "The family account",
      totpCompanionId: codes.id,
    })
    await bindOrigin(ctx, secretId, SHOP)
    await bindOrigin(ctx, codes.id, SHOP)
    await bindOrigin(ctx, loose.id, SHOP)
    await bindOrigin(ctx, elsewhere.id, "https://bank.example")

    const found = await signInsAt(ctx, SHOP, 5)

    // The companion is named with its secret, not again on its own.
    expect(found).toEqual([
      {
        name: "Shop password",
        kind: "text",
        loginName: "ada@example.com",
        note: "The family account",
        totp: "Shop code",
      },
      {
        name: "Old code",
        kind: "totp",
        loginName: null,
        note: null,
        totp: null,
      },
    ])
    expect(JSON.stringify(found)).not.toContain(VALUE)
    expect(await signInsAt(ctx, "https://other.example", 5)).toEqual([])
    expect(await signInsAt(ctx, SHOP, 1)).toHaveLength(1)
  })
})

describe("the gate a type call passes", () => {
  it("asks the owner where the token has no allowance, with the secret's name and never its value", async () => {
    // A server sends the same secret: that is no use in the browser.
    await createServer(ctx, {
      name: "Shop API",
      url: "https://api.shop.example/mcp",
      authType: "header",
      authHeaderName: "Authorization",
      authValueTemplate: "Bearer {{secret}}",
      authSecretId: secretId,
    })

    const ask = await asks(
      admitSecretUse(ctx, {
        tokenId,
        serverId,
        name: "Shop password",
        use: pageAt(SHOP),
      }),
    )

    expect(ask).toEqual({
      kind: "secret_use",
      input: {
        serverId,
        tabId: "t1",
        secretName: "Shop password",
        origin: SHOP,
        url: `${SHOP}/login`,
        title: "Sign in",
        field: 'the textbox "Password"',
        call: { tab: "t1", ref: "e3" },
      },
    })
    expect(JSON.stringify(ask)).not.toContain(VALUE)
  })

  it("passes the login name through the same gate, saying it is the login name", async () => {
    const ask = await asks(
      admitSecretUse(ctx, {
        tokenId,
        serverId,
        name: "Shop password",
        use: pageAt(SHOP),
        part: "username",
      }),
    )
    expect(ask).toMatchObject({
      kind: "secret_use",
      input: { secretName: "Shop password", part: "username" },
    })

    await grantSecretUse(ctx, {
      tokenId,
      secretId,
      origin: SHOP,
      level: "once",
    })
    expect(
      await admitSecretUse(ctx, {
        tokenId,
        serverId,
        name: "Shop password",
        use: pageAt(SHOP),
        part: "username",
      }),
    ).toMatchObject({ id: secretId })
    // One sign-in: the password follows on the same once allowance.
    expect(
      await admitSecretUse(ctx, {
        tokenId,
        serverId,
        name: "Shop password",
        use: pageAt(SHOP),
      }),
    ).toMatchObject({ id: secretId })

    await expect(readTypedLogin(ctx, secretId)).rejects.toThrow(
      /keeps no login name/,
    )
    await updateSecret(ctx, secretId, { loginName: "ada@example.com" })
    expect(await readTypedLogin(ctx, secretId)).toBe("ada@example.com")
  })

  it("lets a once allowance cover one sign-in: each part once, in the tab, within the window", async () => {
    const admit = (part: "username" | "password", now: Date, tabId = "t1") =>
      admitSecretUse(
        ctx,
        {
          tokenId,
          serverId,
          name: "Shop password",
          use: { ...pageAt(SHOP), tabId },
          part,
        },
        now,
      )
    const start = new Date()
    const later = (ms: number) => new Date(start.getTime() + ms)

    // Password first, then the login name: one sign-in.
    await grantSecretUse(
      ctx,
      { tokenId, secretId, origin: SHOP, level: "once" },
      start,
    )
    await admit("password", start)
    // The same part again is a second sign-in, and so is another tab.
    await asks(admit("password", later(1_000)))
    await asks(admit("username", later(1_000), "t2"))
    await admit("username", later(60_000))
    // Both parts used: the next sign-in asks again.
    await asks(admit("username", later(61_000)))
    await asks(admit("password", later(61_000)))

    // The other part comes too late: asked again.
    await grantSecretUse(
      ctx,
      { tokenId, secretId, origin: SHOP, level: "once" },
      start,
    )
    await admit("username", start)
    await asks(admit("password", later(SECRET_SIGN_IN_WINDOW_MS + 1)))

    // The owner ending the allowance ends the sign-in too.
    await grantSecretUse(
      ctx,
      { tokenId, secretId, origin: SHOP, level: "once" },
      start,
    )
    await admit("username", start)
    await endSecretAllowance(ctx, { tokenId, secretId, origin: SHOP })
    await asks(admit("password", later(1_000)))

    // An hour's allowance is untouched by any of it.
    await grantSecretUse(
      ctx,
      { tokenId, secretId, origin: SHOP, level: "hour" },
      start,
    )
    await admit("username", start)
    await admit("username", later(1_000))
    await admit("password", later(2_000), "t2")
  })

  it("refuses a secret it does not hold, or one the browser does not type", async () => {
    await expect(
      admitSecretUse(ctx, {
        tokenId,
        serverId,
        name: "Nothing",
        use: pageAt(SHOP),
      }),
    ).rejects.toThrow(/no secret called "Nothing"/)

    await db().secret.update({
      where: { id: secretId },
      data: { kind: "oauth" },
    })
    await expect(
      admitSecretUse(ctx, {
        tokenId,
        serverId,
        name: "Shop password",
        use: pageAt(SHOP),
      }),
    ).rejects.toThrow(/browser can type/)
  })

  it("lets one use through for a once allowance, and only at its site", async () => {
    await grantSecretUse(ctx, {
      tokenId,
      secretId,
      origin: SHOP,
      level: "once",
    })
    const use = { tokenId, secretId, origin: SHOP }

    expect(
      await takeSecretUse({ ...use, origin: "https://evil.example" }),
    ).toBe(false)
    expect(await takeSecretUse(use)).toBe(true)
    expect(await takeSecretUse(use)).toBe(false)

    // Unused, it runs out.
    await grantSecretUse(ctx, { ...use, level: "once" })
    expect(
      await takeSecretUse(use, new Date(Date.now() + SECRET_ONCE_MS + 1_000)),
    ).toBe(false)
  })

  it("lets every use through for an hour, then asks again", async () => {
    const now = new Date()
    await grantSecretUse(
      ctx,
      { tokenId, secretId, origin: SHOP, level: "hour" },
      now,
    )
    const use = { tokenId, secretId, origin: SHOP }

    expect(await takeSecretUse(use, now)).toBe(true)
    expect(
      await takeSecretUse(use, new Date(now.getTime() + 59 * 60_000)),
    ).toBe(true)
    expect(
      await takeSecretUse(use, new Date(now.getTime() + 61 * 60_000)),
    ).toBe(false)
    // The hour is not the site's: nothing was added to the secret.
    expect(await isBoundOrigin(secretId, SHOP)).toBe(false)

    expect(await pruneAllowances(new Date(now.getTime() + 61 * 60_000))).toBe(1)
    expect(await listSecretAllowances(ctx)).toEqual([])
  })

  it("lets every use through always, while the site is the secret's, until the owner ends it", async () => {
    await grantSecretUse(ctx, {
      tokenId,
      secretId,
      origin: SHOP,
      level: "always",
    })
    const use = { tokenId, secretId, origin: SHOP }

    expect(await isBoundOrigin(secretId, SHOP)).toBe(true)
    expect(
      await takeSecretUse(use, new Date(Date.now() + 365 * 86_400_000)),
    ).toBe(true)
    // Pruning leaves an always alone.
    expect(await pruneAllowances(new Date(Date.now() + 365 * 86_400_000))).toBe(
      0,
    )
    expect(
      await admitSecretUse(ctx, {
        tokenId,
        serverId,
        name: "Shop password",
        use: pageAt(SHOP),
      }),
    ).toMatchObject({ id: secretId, kind: "text" })

    // Another token has none of it.
    const { token } = await createApiToken(ctx, {
      name: "Other",
      allowAllServers: true,
    })
    const other = (await resolveApiToken(token))!.tokenId
    expect(await takeSecretUse({ ...use, tokenId: other })).toBe(false)

    // It is on the token's page and the secret's, and ends there.
    expect(await listTokenAllowances(ctx, tokenId)).toEqual([
      {
        kind: "secret",
        secretId,
        secretName: "Shop password",
        origin: SHOP,
        until: null,
        once: false,
      },
    ])
    await endSecretAllowance(ctx, use)
    expect(await takeSecretUse(use)).toBe(false)
  })

  it("holds an always only while the site is the secret's", async () => {
    await grantSecretUse(ctx, {
      tokenId,
      secretId,
      origin: SHOP,
      level: "always",
    })
    await db().secretBrowserOrigin.deleteMany({})

    expect(await takeSecretUse({ tokenId, secretId, origin: SHOP })).toBe(false)
  })
})

describe("one-time codes", () => {
  it("are typed as the code of the moment; the owner sees it too", async () => {
    const { id } = await createSecret(ctx, {
      name: "Shop codes",
      value: `otpauth://totp/Shop:ada?secret=${SEED}&issuer=Shop`,
      kind: "totp",
    })
    const now = 1_111_111_109_000
    const seed = {
      key: Buffer.from("12345678901234567890"),
      algorithm: "SHA1" as const,
      digits: 6,
      period: 30,
    }

    expect(await readTypedValue(ctx, id, now)).toBe(totpCode(seed, now).code)
    expect(await revealTotpCode(ctx, id, now)).toEqual({
      code: "081804",
      secondsLeft: 1,
      issuer: "Shop",
    })
    // The owner's reveal is the seed they entered.
    expect(await revealSecret(ctx, id)).toContain(SEED)
  })

  it("take only a seed that makes codes, on entry and on change", async () => {
    await expect(
      createSecret(ctx, { name: "Bad", value: "not a seed!", kind: "totp" }),
    ).rejects.toThrow(/base32/)
    const { id } = await createSecret(ctx, {
      name: "Codes",
      value: SEED,
      kind: "totp",
    })
    await expect(updateSecret(ctx, id, { value: "GEZD" })).rejects.toThrow(
      /too short/,
    )
    await updateSecret(ctx, id, { name: "Codes 2" })
    expect(
      secretName(ctx, await db().secret.findUniqueOrThrow({ where: { id } })),
    ).toBe("Codes 2")
  })

  it("never go out as a server's secret", async () => {
    await createSecret(ctx, { name: "Codes", value: SEED, kind: "totp" })
    const { findTextSecretByName } = await import("./secrets")
    expect(await findTextSecretByName(ctx, "Codes")).toBeNull()
  })
})

describe("request_secret", () => {
  const ASK = {
    name: "Mail password",
    purpose: "To sign in to the webmail.",
    origins: ["https://mail.example/login"],
  }

  it("checks each argument before the owner is asked", async () => {
    expect(await checkSecretRequest(ctx, serverId, ASK)).toEqual({
      serverId,
      name: "Mail password",
      purpose: "To sign in to the webmail.",
      origins: ["https://mail.example"],
      kind: "text",
    })
    expect(
      await checkSecretRequest(ctx, serverId, { ...ASK, kind: "totp" }),
    ).toMatchObject({ kind: "totp" })

    await expect(
      checkSecretRequest(ctx, serverId, { ...ASK, name: "-bad" }),
    ).rejects.toThrow(/name/)
    await expect(
      checkSecretRequest(ctx, serverId, { ...ASK, purpose: "  " }),
    ).rejects.toThrow(/what the secret is for/)
    await expect(
      checkSecretRequest(ctx, serverId, { ...ASK, purpose: "hi‮there" }),
    ).rejects.toThrow(/does not show/)
    await expect(
      checkSecretRequest(ctx, serverId, { ...ASK, purpose: "x".repeat(501) }),
    ).rejects.toThrow(/under 500/)
    await expect(
      checkSecretRequest(ctx, serverId, { ...ASK, origins: [] }),
    ).rejects.toThrow(/Name the sites/)
    await expect(
      checkSecretRequest(ctx, serverId, {
        ...ASK,
        origins: ["file:///etc/passwd"],
      }),
    ).rejects.toThrow(/http/)
  })

  it("is a request the owner answers on PCP's page, and a tool error for a name PCP holds", async () => {
    const server = await db().mcpServer.findUniqueOrThrow({
      where: { id: serverId },
    })
    const options = { publicUrl: PUBLIC_URL, tokenId }

    const asked = await runCall(ctx, server, "request_secret", ASK, options)
    expect(textOf(asked)).toContain("Not done yet")
    expect(textOf(asked)).toContain("do not ask them for it here")
    expect(textOf(asked)).toContain(`${PUBLIC_URL}/permissions/`)
    expect(
      await db().permissionRequest.findFirstOrThrow({
        where: { kind: "secret_request" },
      }),
    ).toMatchObject({ toolName: "request_secret", serverId })

    const held = await runCall(
      ctx,
      server,
      "request_secret",
      { ...ASK, name: "Shop password" },
      options,
    )
    expect(held.isError).toBe(true)
    expect(textOf(held)).toContain('{"$secret": "Shop password"}')
  })

  it("never writes over a secret PCP holds", async () => {
    await expect(
      checkSecretRequest(ctx, serverId, { ...ASK, name: "Shop password" }),
    ).rejects.toThrow(/never writes over one: type it/)
  })

  it("saves what the owner typed, with the sites they left, and tells the assistant the name only", async () => {
    const input = await checkSecretRequest(ctx, serverId, {
      ...ASK,
      kind: "totp",
    })
    const pending = await withPermission(
      { ctx, tokenId, publicUrl: PUBLIC_URL },
      { kind: "secret_request", input },
    )
    expect(textOf(pending)).toContain("do not ask them for it here")
    const row = await db().permissionRequest.findFirstOrThrow({
      where: { kind: "secret_request" },
    })
    const view = await getPermissionView(ctx, row.id, { publicUrl: PUBLIC_URL })
    expect(view!.secretToEnter).toMatchObject({
      name: "Mail password",
      kind: "totp",
      origins: ["https://mail.example"],
      exists: false,
    })
    expect(view!.decisions.map((decision) => decision.value)).toEqual([
      "allow_once",
      "allow_for",
      "always",
      "decline",
    ])

    // A seed that makes no codes is said, and the request stays open.
    const wrong = await decidePermission(ctx, row.id, "always", {
      publicUrl: PUBLIC_URL,
      secretValue: "not a seed!",
    })
    expect(wrong.isError).toBe(true)
    expect(
      (
        await db().permissionRequest.findUniqueOrThrow({
          where: { id: row.id },
        })
      ).status,
    ).toBe("pending")

    const done = await decidePermission(ctx, row.id, "always", {
      publicUrl: PUBLIC_URL,
      secretValue: SEED,
      origins: ["https://mail.example", "https://webmail.example/x"],
    })

    expect(done.isError).not.toBe(true)
    expect(textOf(done)).toContain('{"$secret": "Mail password"}')
    expect(textOf(done)).not.toContain(SEED)
    const secret = await db().secret.findFirstOrThrow({
      where: secretNameWhere(ctx, "Mail password"),
    })
    expect(secret.kind).toBe("totp")
    expect(await revealSecret(ctx, secret.id)).toBe(SEED)
    expect(await listBrowserOrigins(ctx)).toEqual(
      new Map([
        [
          secret.id,
          [
            { origin: "https://mail.example", subdomains: false },
            { origin: "https://webmail.example", subdomains: false },
          ],
        ],
      ]),
    )
    expect(
      (await listSecretAllowances(ctx, { tokenId })).map((row) => [
        row.origin,
        row.until,
      ]),
    ).toEqual([
      ["https://mail.example", null],
      ["https://webmail.example", null],
    ])
  })

  it("uses a secret the owner added by that name since, and never writes over it", async () => {
    const input = await checkSecretRequest(ctx, serverId, ASK)
    await withPermission(
      { ctx, tokenId, publicUrl: PUBLIC_URL },
      { kind: "secret_request", input },
    )
    const row = await db().permissionRequest.findFirstOrThrow({
      where: { kind: "secret_request" },
    })
    const { id } = await createSecret(ctx, {
      name: "Mail password",
      value: "theirs",
    })

    const refused = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
      secretValue: "another",
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("nothing is written over it")

    const done = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
    })
    expect(done.isError).not.toBe(true)
    expect(await revealSecret(ctx, id)).toBe("theirs")
    expect(
      await takeSecretUse({
        tokenId,
        secretId: id,
        origin: "https://mail.example",
      }),
    ).toBe(true)
    expect(
      await takeSecretUse({
        tokenId,
        secretId: id,
        origin: "https://mail.example",
      }),
    ).toBe(false)
  })
})

describe("request_secret with a login name and a made password", () => {
  const ASK = {
    name: "Energy",
    purpose: "To sign up at the energy company.",
    origins: ["https://www.frankenergie.nl"],
    username: "ada@example.com",
    generate: { length: 20, symbols: false },
  }

  async function requested(args: Record<string, unknown> = ASK) {
    const server = await db().mcpServer.findUniqueOrThrow({
      where: { id: serverId },
    })
    const asked = await runCall(ctx, server, "request_secret", args, {
      publicUrl: PUBLIC_URL,
      tokenId,
    })
    expect(textOf(asked)).toContain("Not done yet")
    return db().permissionRequest.findFirstOrThrow({
      where: { kind: "secret_request" },
    })
  }

  it("checks both before the owner is asked, and never for one-time codes", async () => {
    expect(await checkSecretRequest(ctx, serverId, ASK)).toMatchObject({
      username: "ada@example.com",
      generate: { ...DEFAULT_PASSWORD_RECIPE, length: 20, symbols: false },
    })
    await expect(
      checkSecretRequest(ctx, serverId, { ...ASK, kind: "totp" }),
    ).rejects.toThrow(/neither username nor generate/)
    await expect(
      checkSecretRequest(ctx, serverId, { ...ASK, username: "a\nb" }),
    ).rejects.toThrow(/one line/)
    await expect(
      checkSecretRequest(ctx, serverId, { ...ASK, generate: { length: 4 } }),
    ).rejects.toThrow(/8 to 128/)

    // The tool's own schema says the same before anything runs.
    const server = await db().mcpServer.findUniqueOrThrow({
      where: { id: serverId },
    })
    const refused = await runCall(
      ctx,
      server,
      "request_secret",
      { ...ASK, kind: "totp" },
      { publicUrl: PUBLIC_URL, tokenId },
    )
    expect(refused.isError).toBe(true)
  })

  it("shows the owner the login name and the recipe, to change on the page", async () => {
    const row = await requested()
    const view = await getPermissionView(ctx, row.id, { publicUrl: PUBLIC_URL })

    expect(view!.secretToEnter).toMatchObject({
      name: "Energy",
      username: "ada@example.com",
      generate: { length: 20, symbols: false },
    })
    expect(view!.lines.join("\n")).toContain("Login name: ada@example.com")
    expect(view!.lines.join("\n")).toContain(
      "make a new password: 20 characters",
    )
  })

  it("stores a password PCP makes with the login name the owner left, and never hands it back", async () => {
    const row = await requested()

    const done = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
      generate: { length: 32, symbols: false, exclude: "0O" },
      loginName: "ada+energy@example.com",
    })

    expect(done.isError, textOf(done)).not.toBe(true)
    const secret = await db().secret.findFirstOrThrow({
      where: secretNameWhere(ctx, "Energy"),
    })
    const value = await revealSecret(ctx, secret.id)
    expect(value).toMatch(/^[A-NP-Za-z1-9]{32}$/)
    expect(textOf(done)).not.toContain(value)
    expect(textOf(done)).toContain("PCP made its value itself")
    expect(textOf(done)).toContain('"part": "username"')
    expect(await readTypedLogin(ctx, secret.id)).toBe("ada+energy@example.com")
    const stored = await db().permissionRequest.findUniqueOrThrow({
      where: { id: row.id },
    })
    expect(Buffer.from(stored.resultCiphertext!).toString()).not.toContain(
      value,
    )
  })

  it("refuses a recipe the owner changed into one that cannot be met, and keeps the request open", async () => {
    const row = await requested()
    const refused = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
      generate: { length: 12, exclude: "0123456789" },
    })

    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain("every one of the digits")
    expect(
      (
        await db().permissionRequest.findUniqueOrThrow({
          where: { id: row.id },
        })
      ).status,
    ).toBe("pending")
  })

  it("stores what the owner typed when they turn Generate off", async () => {
    const row = await requested()
    await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
      secretValue: "typed-by-ada",
      loginName: "",
    })
    const secret = await db().secret.findFirstOrThrow({
      where: secretNameWhere(ctx, "Energy"),
    })
    expect(await revealSecret(ctx, secret.id)).toBe("typed-by-ada")
    await expect(readTypedLogin(ctx, secret.id)).rejects.toThrow(
      /keeps no login name/,
    )
  })
})

describe("update_secret_sites", () => {
  const FRANK = "https://www.frankenergie.nl"

  beforeEach(async () => {
    await bindOrigin(ctx, secretId, "https://www.frankenergy.nl")
    await bindOrigin(ctx, secretId, SHOP)
  })

  async function proposed(args: Record<string, unknown>) {
    const server = await db().mcpServer.findUniqueOrThrow({
      where: { id: serverId },
    })
    return runCall(ctx, server, "update_secret_sites", args, {
      publicUrl: PUBLIC_URL,
      tokenId,
    })
  }

  it("checks the change before the owner is asked", async () => {
    expect(
      await checkSecretSitesChange(ctx, serverId, {
        name: "Shop password",
        reason: "The site moved.",
        add: [
          { origin: `${FRANK}/login` },
          { origin: "https://frankenergie.nl", subdomains: true },
        ],
        remove: ["https://www.frankenergy.nl/"],
      }),
    ).toEqual({
      serverId,
      secretName: "Shop password",
      reason: "The site moved.",
      add: [
        { origin: FRANK, subdomains: false },
        { origin: "https://frankenergie.nl", subdomains: true },
      ],
      remove: ["https://www.frankenergy.nl"],
    })

    const check = (args: Record<string, unknown>) =>
      checkSecretSitesChange(ctx, serverId, {
        name: "Shop password",
        reason: "Because.",
        ...args,
      })
    await expect(
      check({ name: "Nope", add: [{ origin: FRANK }] }),
    ).rejects.toThrow(/no secret called "Nope"/)
    await expect(
      check({ reason: " ", add: [{ origin: FRANK }] }),
    ).rejects.toThrow(/Say why/)
    await expect(check({ remove: ["https://other.example"] })).rejects.toThrow(
      /not one of the sites/,
    )
    await expect(check({ add: [{ origin: SHOP }] })).rejects.toThrow(
      /Nothing would change/,
    )
    await expect(
      check({ add: [{ origin: "https://github.io", subdomains: true }] }),
    ).rejects.toThrow(/cannot stand for its subdomains/)
    await expect(
      check({ add: [{ origin: SHOP, subdomains: true }], remove: [SHOP] }),
    ).rejects.toThrow(/both added and taken away/)
    await expect(check({})).rejects.toThrow(/Nothing would change/)
  })

  it("always asks the owner, even where the tool is allowed", async () => {
    await writeToolAccess(tokenId, serverId, "update_secret_sites", "allowed")

    const asked = await proposed({
      name: "Shop password",
      reason: "Typo in the domain.",
      add: [{ origin: FRANK }],
    })

    expect(textOf(asked)).toContain("Not done yet")
    expect(
      await db().permissionRequest.findFirstOrThrow({
        where: { kind: "secret_sites_change" },
      }),
    ).toMatchObject({ toolName: "update_secret_sites", serverId })
    expect(await sitesOf(secretId)).toHaveLength(2)

    const refused = await proposed({ name: "Shop password", reason: "x" })
    expect(refused.isError).toBe(true)
  })

  it("shows the sites now and each change, flagging a lookalike and leaving it unticked", async () => {
    await proposed({
      name: "Shop password",
      reason: "Typo in the domain.",
      add: [
        { origin: FRANK },
        { origin: "https://www.shop.example", subdomains: false },
      ],
      remove: ["https://www.frankenergy.nl"],
    })
    const row = await db().permissionRequest.findFirstOrThrow({
      where: { kind: "secret_sites_change" },
    })
    const view = await getPermissionView(ctx, row.id, { publicUrl: PUBLIC_URL })

    expect(view!.title).toBe('Change where "Shop password" is typed?')
    expect(view!.decisions.map((decision) => decision.value)).toEqual([
      "allow_once",
      "decline",
    ])
    expect(view!.secretSites).toMatchObject({
      secretName: "Shop password",
      current: [
        { origin: SHOP, subdomains: false },
        { origin: "https://www.frankenergy.nl", subdomains: false },
      ],
      changes: [
        { key: `add:${FRANK}`, action: "add" },
        { key: "add:https://www.shop.example", lookalike: null },
        { key: "remove:https://www.frankenergy.nl", action: "remove" },
      ],
    })
    // frankenergie.nl beside frankenergy.nl: a letter or two apart.
    expect(view!.secretSites!.changes[0]!.lookalike).toMatch(
      /letter or two away from frankenergy\.nl/,
    )
    expect(view!.warning).toMatch(/Check these/)
    expect(view!.lines.join("\n")).toContain(
      "Take away: https://www.frankenergy.nl",
    )
  })

  it("makes only the ticked changes, to the sites as shown, and refuses once they moved", async () => {
    await grantSecretUse(ctx, {
      tokenId,
      secretId,
      origin: "https://www.frankenergy.nl",
      level: "hour",
    })
    await proposed({
      name: "Shop password",
      reason: "Typo in the domain.",
      add: [
        { origin: "https://frankenergie.nl", subdomains: true },
        { origin: "https://else.example" },
      ],
      remove: ["https://www.frankenergy.nl"],
    })
    const row = await db().permissionRequest.findFirstOrThrow({
      where: { kind: "secret_sites_change" },
    })
    const shown = await showSecretSitesChange(
      ctx,
      await checkSecretSitesChange(ctx, serverId, {
        name: "Shop password",
        reason: "x",
        add: [{ origin: "https://frankenergie.nl", subdomains: true }],
      }),
    )

    // Nothing ticked is no answer.
    const none = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
      sites: { basis: shown.basis, keep: [] },
    })
    expect(none.isError).toBe(true)

    // The sites changed since the page was read.
    await bindOrigin(ctx, secretId, "https://late.example")
    const stale = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
      sites: {
        basis: shown.basis,
        keep: [
          "add:https://frankenergie.nl",
          "remove:https://www.frankenergy.nl",
        ],
      },
    })
    expect(stale.isError).toBe(true)
    expect(textOf(stale)).toContain("changed since")
    await unbindOrigin(ctx, secretId, "https://late.example")

    const done = await decidePermission(ctx, row.id, "allow_once", {
      publicUrl: PUBLIC_URL,
      sites: {
        basis: shown.basis,
        keep: [
          "add:https://frankenergie.nl",
          "remove:https://www.frankenergy.nl",
        ],
      },
    })

    expect(done.isError, textOf(done)).not.toBe(true)
    expect(textOf(done)).toContain(
      "Added: https://frankenergie.nl and its subdomains.",
    )
    expect(textOf(done)).toContain("Not done: adding https://else.example.")
    expect(await sitesOf(secretId)).toEqual([
      { origin: "https://frankenergie.nl", subdomains: true },
      { origin: SHOP, subdomains: false },
    ])
    expect(await isBoundOrigin(secretId, "https://mijn.frankenergie.nl")).toBe(
      true,
    )
    // The site taken away took this token's allowance there with it.
    expect(await listSecretAllowances(ctx)).toEqual([])
  })

  it("changes nothing on Not now", async () => {
    await proposed({
      name: "Shop password",
      reason: "Typo.",
      remove: [SHOP],
    })
    const row = await db().permissionRequest.findFirstOrThrow({
      where: { kind: "secret_sites_change" },
    })
    await decidePermission(ctx, row.id, "decline", { publicUrl: PUBLIC_URL })
    expect(await sitesOf(secretId)).toHaveLength(2)
  })
})

describe("the owner's answer to a secret's use", () => {
  async function asked() {
    const ask = await asks(
      admitSecretUse(ctx, {
        tokenId,
        serverId,
        name: "Shop password",
        use: pageAt(SHOP),
      }),
    )
    if (ask.kind !== "secret_use") throw new Error("not a secret's use")
    await withPermission(
      { ctx, tokenId, publicUrl: PUBLIC_URL },
      { kind: "secret_use", input: ask.input },
    )
    const row = await db().permissionRequest.findFirstOrThrow({
      where: { kind: "secret_use" },
    })
    return row.id
  }

  it("shows the owner the secret's name, the site and the tab, never the value", async () => {
    const id = await asked()
    const view = (await getPermissionView(ctx, id, { publicUrl: PUBLIC_URL }))!

    expect(view.title).toBe('Type the secret "Shop password" at shop.example?')
    expect(view.lines).toContain(`Site: ${SHOP}`)
    expect(view.lines.join("\n")).toContain("has not typed")
    expect(view.warning).toContain("Check the site")
    expect(view.browserTabId).toBe("t1")
    expect(view.tool).toBe("type")
    expect(JSON.stringify(view)).not.toContain(VALUE)
  })

  it("types it once on Allow once, the call made again with the secret's name", async () => {
    const id = await asked()
    const { calls, executor } = stub()

    const result = await decidePermission(
      ctx,
      id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      executor,
    )

    expect(result.isError).not.toBe(true)
    expect(calls).toEqual([
      {
        tool: "type",
        args: { tab: "t1", ref: "e3", text: { $secret: "Shop password" } },
      },
    ])
    // The stub typed nothing, so the once answer went with the call.
    expect(await listSecretAllowances(ctx)).toEqual([])
    // Nor did it change the browser tool's level.
    expect(await db().apiTokenToolAccess.count()).toBe(0)
  })

  it("lets it be typed for an hour on Allow for, whatever minutes the page sent", async () => {
    const id = await asked()
    const { executor } = stub()

    await decidePermission(
      ctx,
      id,
      "allow_for",
      { publicUrl: PUBLIC_URL, minutes: 480 },
      executor,
    )

    const [allowance] = await listSecretAllowances(ctx)
    expect(allowance!.until!.getTime() - Date.now()).toBeGreaterThan(
      59 * 60_000,
    )
    expect(allowance!.until!.getTime() - Date.now()).toBeLessThan(61 * 60_000)
    expect(await db().apiTokenToolAllowance.count()).toBe(0)
  })

  it("adds the site to the secret on Always allow", async () => {
    const id = await asked()
    const { executor } = stub()

    await decidePermission(
      ctx,
      id,
      "always",
      { publicUrl: PUBLIC_URL },
      executor,
    )

    expect(await isBoundOrigin(secretId, SHOP)).toBe(true)
    expect(await listSecretAllowances(ctx)).toMatchObject([
      { origin: SHOP, until: null },
    ])
    expect(await db().apiTokenToolAccess.count()).toBe(0)
  })

  it("lifts no block: a type tool blocked since it asked types nothing", async () => {
    const id = await asked()
    const { calls, executor } = stub()
    await writeToolAccess(tokenId, serverId, "type", "blocked")

    const result = await decidePermission(
      ctx,
      id,
      "always",
      { publicUrl: PUBLIC_URL },
      executor,
    )

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("blocked")
    expect(calls).toEqual([])
  })

  it("types nothing on Not now, and offers no Block", async () => {
    const id = await asked()
    const { calls, executor } = stub()

    expect(
      (
        await decidePermission(
          ctx,
          id,
          "block",
          { publicUrl: PUBLIC_URL },
          executor,
        )
      ).isError,
    ).toBe(true)
    await decidePermission(
      ctx,
      id,
      "decline",
      { publicUrl: PUBLIC_URL },
      executor,
    )

    expect(calls).toEqual([])
    expect(await listSecretAllowances(ctx)).toEqual([])
  })
})
