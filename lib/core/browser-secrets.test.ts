import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { listTokenAllowances, pruneAllowances } from "./allowances"
import { createApiToken, resolveApiToken } from "./api-tokens"
import {
  admitSecretUse,
  bindOrigin,
  checkSecretRequest,
  endSecretAllowance,
  grantSecretUse,
  isBoundOrigin,
  listBrowserOrigins,
  listSecretAllowances,
  originOf,
  parseOrigins,
  SECRET_ONCE_MS,
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
  readTypedValue,
  revealSecret,
  revealTotpCode,
  updateSecret,
} from "./secrets"
import { createServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { totpCode } from "./totp"
import { writeToolAccess } from "./tool-access"
import { setupVault } from "./vault"

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
    expect(await listBrowserOrigins(ctx)).toEqual(new Map([[secretId, [SHOP]]]))
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
    expect((await db().secret.findUniqueOrThrow({ where: { id } })).name).toBe(
      "Codes 2",
    )
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
      where: { name: "Mail password" },
    })
    expect(secret.kind).toBe("totp")
    expect(await revealSecret(ctx, secret.id)).toBe(SEED)
    expect(await listBrowserOrigins(ctx)).toEqual(
      new Map([
        [secret.id, ["https://mail.example", "https://webmail.example"]],
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
