import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import { bindOrigin, sitesOf } from "./browser-secrets"
import type { VaultContext } from "./context"
import { db } from "./db"
import { buildGatewayServer } from "./gateway"
import { newId } from "./ids"
import {
  decidePermission,
  defaultExecutor,
  getPermissionView,
  type PermissionExecutor,
} from "./permissions"
import { secretNameWhere } from "./secret-meta"
import { grantSecretScope, readSecretScopes } from "./secret-scope"
import { alsoAllowsFor } from "./secret-scope-asks"
import {
  createSecret,
  readSecretValue,
  updateSecret,
  writeManagedSecret,
} from "./secrets"
import { serverCreateData, writeServer } from "./server-meta"
import { createServer } from "./servers"
import { readRequestLog } from "./request-log"
import { entryCall } from "./test-handles"
import { scratchDatabase } from "./test-db"
import { keepBytes, keepResult } from "./tool-results"
import { setupVault } from "./vault"

// An assistant's proposals about one of the owner's secrets (#162):
// edit_secret, rotate_secret, change_secret_scope and delete_secret, as it
// meets them through execute_<tier>. Each always asks, shows the secret
// before and after and what uses it, writes only what the owner was shown
// while the secret is as it was, never hands back a value, and leaves
// PCP's own secrets alone.

const PUBLIC_URL = "http://localhost:3000"
const VALUE = "lin_live_0123456789abcdef"

let cleanup: () => Promise<void>
let ctx: VaultContext
let client: Client
let tokenId: string
let keyId: string
let remade: string[]
const executor: PermissionExecutor = {
  ...defaultExecutor,
  syncTools: async () => ({
    status: "ok" as const,
    message: "",
    toolCount: 0,
  }),
  async remakeServices(_ctx, secretId) {
    remade.push(secretId)
    return [{ id: "svc", ok: true, message: "Docs is running." }]
  },
}

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({ name: "Ada", password: "correct horse battery" })
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    serverIds: [],
  })
  const scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  tokenId = scope.tokenId
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, []).connect(serverSide)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  ;({ id: keyId } = await createSecret(ctx, {
    name: "Linear key",
    value: VALUE,
    description: "For Linear.",
  }))
  remade = []
})

afterEach(async () => {
  await client.close()
  await cleanup()
})

async function call(
  tool: string,
  args: Record<string, unknown>,
  entry?: string,
) {
  const result = await client.callTool(
    entry
      ? { name: entry, arguments: { tool, arguments: args } }
      : entryCall(tool, args),
  )
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("")

  return { isError: result.isError === true, text }
}

async function newest() {
  const row = await db().permissionRequest.findFirstOrThrow({
    orderBy: { createdAt: "desc" },
  })

  return {
    row,
    view: (await getPermissionView(ctx, row.id, { publicUrl: PUBLIC_URL }))!,
  }
}

function decide(id: string, options: Parameters<typeof decidePermission>[3]) {
  return decidePermission(ctx, id, "allow_once", options, executor)
}

function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ text?: string }>)
    .map((part) => part.text ?? "")
    .join("")
}

async function upstream(secretId: string | null = null) {
  return createServer(ctx, {
    name: "Linear",
    url: "https://linear.example/mcp",
    authType: secretId ? "header" : "none",
    ...(secretId
      ? {
          authHeaderName: "Authorization",
          authValueTemplate: "Bearer {{secret}}",
          authSecretId: secretId,
        }
      : {}),
  })
}

/** A browser flow whose program types the secret by its name. */
async function flowNaming(name: string) {
  const id = newId()
  const definition = {
    version: 1,
    tools: [
      {
        name: "sign_in",
        title: null,
        annotations: null,
        replaces: [],
        description: "Signs in.",
        inputSchema: { type: "object" },
        program: `await pcp.call("browser", "type", { tab: args.tab, ref: "e1", text: { $secret: "${name}" } })`,
        calls: [],
      },
    ],
    secrets: [],
  }

  await db().mcpServer.create({
    data: serverCreateData(ctx, {
      id,
      vaultId: ctx.vaultId,
      kind: "wrapper",
      name: "Shop flow",
      slug: "shop-flow",
      url: "pcp:wrapper",
      wrapperSpec: {
        create: { plainDefinition: JSON.stringify(definition), hash: "x" },
      },
    }),
  })
}

describe("edit_secret", () => {
  it("asks to rename and describe it, warns of a flow that names it, and writes only that", async () => {
    await flowNaming("Linear key")
    const asked = await call("edit_secret", {
      name: "Linear key",
      reason: "A clearer name.",
      new_name: "Linear API key",
      login_name: "ada@example.com",
    })

    expect(asked.text).toContain("Not done yet")
    const { row, view } = await newest()
    expect(row.kind).toBe("secret_change")
    expect(view.title).toBe('Change the secret "Linear key"')
    expect(view.decisions[0]).toEqual({
      value: "allow_once",
      label: "Apply the changes",
    })
    expect(view.secretChange).toMatchObject({
      action: "edit",
      stale: false,
      rows: [
        { label: "Name", before: "Linear key", after: "Linear API key" },
        { label: "Login name", before: "none", after: "ada@example.com" },
      ],
      namedBy: [{ name: "Shop flow", tools: ["sign_in"] }],
    })
    expect(view.warning).toMatch(/old name stops finding it/)

    const done = await decide(row.id, { publicUrl: PUBLIC_URL })
    expect(done.isError, textOf(done)).not.toBe(true)
    expect(textOf(done)).toContain('Shop flow still name it "Linear key"')
    const secret = await db().secret.findFirstOrThrow({
      where: secretNameWhere(ctx, "Linear API key"),
    })
    expect(secret.id).toBe(keyId)
    expect(await readSecretValue(ctx, keyId)).toBe(VALUE)
  })

  it("refuses an edit of a secret that changed since it was asked", async () => {
    await call("edit_secret", {
      name: "Linear key",
      reason: "Clearer.",
      description: "The Linear token.",
    })
    const { row } = await newest()
    // The owner changed it in the meantime.
    await db().secret.update({
      where: { id: keyId },
      data: { note: new Uint8Array([1, 2, 3]) },
    })

    expect((await newest()).view.secretChange!.stale).toBe(true)
    const stale = await decide(row.id, { publicUrl: PUBLIC_URL })
    expect(stale.isError).toBe(true)
    expect(textOf(stale)).toMatch(/changed since the assistant asked/)
  })

  it("refuses what would change nothing, and a name taken", async () => {
    await createSecret(ctx, { name: "Other", value: "x" })

    expect(
      (
        await call("edit_secret", {
          name: "Linear key",
          reason: "x",
          description: "For Linear.",
        })
      ).text,
    ).toMatch(/Nothing would change/)
    expect(
      (
        await call("edit_secret", {
          name: "Linear key",
          reason: "x",
          new_name: "Other",
        })
      ).text,
    ).toMatch(/already exists/)
    expect(await db().permissionRequest.count()).toBe(0)
  })
})

describe("rotate_secret", () => {
  it("asks for a new value, has PCP make it on the owner's yes, remakes the services and clears the alerts", async () => {
    const server = await upstream(keyId)
    await writeServer(ctx, server.id, {
      status: "auth_required",
      statusMessage: "rejected the credentials",
    })
    await call("rotate_secret", {
      name: "Linear key",
      reason: "The old key leaked.",
      generate: { format: "alphanumeric", length: 40 },
    })
    const { row, view } = await newest()

    expect(view.title).toBe('Give the secret "Linear key" a new value')
    expect(view.decisions[0]!.label).toBe("Save the new value")
    expect(view.secretChange).toMatchObject({
      action: "rotate",
      uses: [{ name: "Linear", via: "auth" }],
      generate: { format: "alphanumeric", length: 40 },
    })

    // Nothing typed and nothing made is no answer.
    expect((await decide(row.id, { publicUrl: PUBLIC_URL })).isError).toBe(true)

    const done = await decide(row.id, {
      publicUrl: PUBLIC_URL,
      generate: { format: "alphanumeric", length: 40 },
    })
    expect(done.isError, textOf(done)).not.toBe(true)
    const value = await readSecretValue(ctx, keyId)
    expect(value).toMatch(/^[A-Za-z0-9]{40}$/)
    expect(value).not.toBe(VALUE)
    expect(textOf(done)).toContain("that PCP made itself")
    expect(textOf(done)).toContain("Made again with it: 1 of 1 services.")
    expect(JSON.stringify(done)).not.toContain(value)
    expect(JSON.stringify(await newest())).not.toContain(value)
    expect(remade).toEqual([keyId])
    expect(
      (await db().mcpServer.findUniqueOrThrow({ where: { id: server.id } }))
        .status,
    ).toBe("ok")
  })

  it("takes a value the owner typed, and refuses once the value changed since", async () => {
    await call("rotate_secret", { name: "Linear key", reason: "Leaked." })
    const { row } = await newest()

    // The owner gave it a new value themselves in the meantime.
    await updateSecret(ctx, keyId, { value: "owner-typed-value" })
    const stale = await decide(row.id, {
      publicUrl: PUBLIC_URL,
      secretValue: "typed-new-value",
    })
    expect(stale.isError).toBe(true)
    expect(remade).toEqual([])

    // Asked again, on the secret as it is now: a new request.
    await call("rotate_secret", {
      name: "Linear key",
      reason: "Leaked, still.",
    })
    const again = await newest()
    expect(again.row.id).not.toBe(row.id)
    const done = await decide(again.row.id, {
      publicUrl: PUBLIC_URL,
      secretValue: "typed-new-value",
    })
    expect(done.isError, textOf(done)).not.toBe(true)
    expect(await readSecretValue(ctx, keyId)).toBe("typed-new-value")
    expect(textOf(done)).not.toContain("typed-new-value")
  })

  it("refuses to make one-time codes", async () => {
    await createSecret(ctx, {
      name: "Codes",
      value: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      kind: "totp",
    })

    expect(
      (
        await call("rotate_secret", {
          name: "Codes",
          reason: "x",
          generate: { length: 20 },
        })
      ).text,
    ).toMatch(/PCP does not make one/)
  })
})

describe("rotate_secret with value_from", () => {
  const KEPT = "kept-token-ZXCV-0987654321"

  /** A result of the requesting token's own, pass-only as keep makes one. */
  async function keep(
    text = KEPT,
    options: { token?: string; passOnly?: boolean } = {},
  ) {
    const kept = await keepResult(ctx, {
      tokenId: options.token ?? tokenId,
      serverId: null,
      toolName: "mint_token",
      text,
      mediaType: "text/plain",
      passOnly: options.passOnly ?? true,
    })

    return { $result: kept.id }
  }

  it("takes a pass-only result of the token as the new value, on the owner's yes, and never shows it", async () => {
    const server = await upstream(keyId)
    await writeServer(ctx, server.id, {
      status: "auth_required",
      statusMessage: "rejected the credentials",
    })
    const handle = await keep()
    const asked = await call("rotate_secret", {
      name: "Linear key",
      reason: "The key was reissued.",
      value_from: handle,
    })
    const { row, view } = await newest()

    expect(asked.isError, asked.text).toBe(false)
    expect(view.valueFrom).toMatchObject({
      id: handle.$result,
      source: "mint_token",
      length: KEPT.length,
      passOnly: true,
      expired: false,
    })
    expect(view.secretChange?.rows[0]!.after).toContain("mint_token")
    expect(view.lines.join("\n")).not.toContain(KEPT)

    const done = await decide(row.id, { publicUrl: PUBLIC_URL })
    expect(done.isError, textOf(done)).not.toBe(true)
    expect(textOf(done)).toContain("from the kept result you named")
    expect(textOf(done)).toContain("Made again with it: 1 of 1 services.")

    // The value is the kept one, and the old one is gone.
    expect(await readSecretValue(ctx, keyId)).toBe(KEPT)
    const stored = await db().secret.findFirstOrThrow({ where: { id: keyId } })
    expect(Buffer.from(stored.ciphertext).toString("utf8")).not.toContain(VALUE)
    expect(remade).toEqual([keyId])
    expect(
      (await db().mcpServer.findUniqueOrThrow({ where: { id: server.id } }))
        .status,
    ).toBe("ok")

    // Nowhere it could have been left: the answer, the request as the
    // assistant checks it, the request's stored rows or the log.
    const checked = await call("check_permission", { id: row.id })
    const rows = await db().permissionRequest.findMany()
    const log = await readRequestLog(ctx)
    for (const where of [
      JSON.stringify(done),
      checked.text,
      asked.text,
      JSON.stringify(await newest()),
      JSON.stringify(rows),
      JSON.stringify(log),
    ]) {
      expect(where).not.toContain(KEPT)
    }
    expect(Buffer.from(rows[0]!.argsCiphertext).toString("utf8")).not.toContain(
      KEPT,
    )
  })

  it("refuses another token's result before anything is asked, and an id it never had", async () => {
    const other = await createApiToken(ctx, {
      name: "Other",
      allowAllServers: true,
      serverIds: [],
    })
    const otherScope = (await resolveApiToken(other.token))!
    const theirs = await keep(KEPT, { token: otherScope.tokenId })

    for (const handle of [theirs, { $result: "nope" }]) {
      const asked = await call("rotate_secret", {
        name: "Linear key",
        reason: "Leaked.",
        value_from: handle,
      })

      expect(asked.isError).toBe(true)
      expect(asked.text).toContain("not there for this token")
      expect(asked.text).not.toContain(KEPT)
    }

    expect(await db().permissionRequest.count()).toBe(0)
  })

  it("refuses generate with it, a value that is not text or is empty or too long or has control characters", async () => {
    const handle = await keep()
    const both = await call("rotate_secret", {
      name: "Linear key",
      reason: "Leaked.",
      value_from: handle,
      generate: { format: "hex" },
    })
    expect(both.isError).toBe(true)

    const bytes = await keepBytes(ctx, {
      tokenId,
      serverId: null,
      toolName: "download",
      bytes: Buffer.from([0xff, 0xfe, 0x41, 0x80]),
      mediaType: "application/octet-stream",
      name: null,
    })
    const bad: Array<[unknown, RegExp]> = [
      [{ $result: bytes.id }, /not valid UTF-8|not text/],
      [await keep(""), /Enter the secret's value/],
      [await keep("x".repeat(64 * 1024 + 1)), /too large/],
      [await keep("bell\u0007here"), /does not show on screen/],
      [await keep("two\r\nlines"), /does not show on screen/],
      [{ ...(await keep()), as: "base64" }, /handle alone|These arguments/],
    ]

    for (const [value_from, why] of bad) {
      const asked = await call("rotate_secret", {
        name: "Linear key",
        reason: "Leaked.",
        value_from,
      })

      expect(asked.isError, JSON.stringify(value_from)).toBe(true)
      expect(asked.text).toMatch(why)
    }

    expect(await db().permissionRequest.count()).toBe(0)
    expect(await readSecretValue(ctx, keyId)).toBe(VALUE)
  })

  it("refuses one-time codes, and a typed value or recipe beside it", async () => {
    await createSecret(ctx, {
      name: "Codes",
      value: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      kind: "totp",
    })
    const codes = await call("rotate_secret", {
      name: "Codes",
      reason: "New seed.",
      value_from: await keep(),
    })
    expect(codes.isError).toBe(true)

    await call("rotate_secret", {
      name: "Linear key",
      reason: "Leaked.",
      value_from: await keep(),
    })
    const { row } = await newest()

    for (const options of [
      { secretValue: "typed-instead" },
      { generate: { format: "hex" } },
    ]) {
      const refused = await decide(row.id, {
        publicUrl: PUBLIC_URL,
        ...options,
      })
      expect(refused.isError).toBe(true)
    }

    expect(await readSecretValue(ctx, keyId)).toBe(VALUE)
  })

  it("writes nothing when the result expired before the owner answered, and says so", async () => {
    const handle = await keep()
    await call("rotate_secret", {
      name: "Linear key",
      reason: "Reissued.",
      value_from: handle,
    })
    const { row } = await newest()
    await db().toolResult.update({
      where: { id: handle.$result },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const shown = await newest()
    expect(shown.view.valueFrom?.expired).toBe(true)

    const done = await decide(row.id, { publicUrl: PUBLIC_URL })
    expect(textOf(done)).toContain("not there for this token any more")
    expect(textOf(done)).toContain("Nothing was saved")
    expect(await readSecretValue(ctx, keyId)).toBe(VALUE)
    expect(remade).toEqual([])
    const checked = await call("check_permission", { id: row.id })
    expect(checked.text).toContain("Nothing was saved")
  })

  it("is a request of its own per result, not the one already waiting", async () => {
    await call("rotate_secret", {
      name: "Linear key",
      reason: "Leaked.",
      value_from: await keep("first-kept-value"),
    })
    const first = await newest()
    await call("rotate_secret", {
      name: "Linear key",
      reason: "Leaked.",
      value_from: await keep("second-kept-value"),
    })

    expect((await newest()).row.id).not.toBe(first.row.id)
  })
})

describe("rotate_secret and what uses the secret", () => {
  it("clears the credential alerts of a service and a wrapper that use it", async () => {
    const upstreamServer = await upstream()
    const service = newId()
    await db().mcpServer.create({
      data: serverCreateData(ctx, {
        id: service,
        vaultId: ctx.vaultId,
        kind: "service",
        name: "Docs",
        slug: "docs",
        url: "pcp:service",
        serviceSpec: {
          create: {
            plainDefinition: "{}",
            hash: "0",
            engine: "docker",
            plainContainerName: "pcp-docs",
            env: JSON.stringify({ API_KEY: keyId }),
          },
        },
      }),
    })
    const wrapper = newId()
    await db().mcpServer.create({
      data: serverCreateData(ctx, {
        id: wrapper,
        vaultId: ctx.vaultId,
        kind: "wrapper",
        name: "Lookup",
        slug: "lookup",
        url: "pcp:wrapper",
        wrapperSpec: {
          create: {
            plainDefinition: JSON.stringify({
              version: 1,
              tools: [],
              secrets: [
                {
                  secret: "Linear key",
                  secretId: keyId,
                  serverId: upstreamServer.id,
                  tool: "search",
                  argument: "/key",
                  template: "{{secret}}",
                  url: "https://linear.example/mcp",
                },
              ],
            }),
            hash: "x",
          },
        },
      }),
    })

    for (const id of [service, wrapper]) {
      await writeServer(ctx, id, {
        status: "auth_required",
        statusMessage: "rejected the credentials",
      })
    }

    await call("rotate_secret", { name: "Linear key", reason: "Leaked." })
    const done = await decide((await newest()).row.id, {
      publicUrl: PUBLIC_URL,
      secretValue: "a-new-value",
    })
    expect(done.isError, textOf(done)).not.toBe(true)

    for (const id of [service, wrapper]) {
      expect(
        (await db().mcpServer.findUniqueOrThrow({ where: { id } })).status,
        id,
      ).toBe("ok")
    }
  })

  it("is not refused as changed when the secret's scope was filled in after the upgrade", async () => {
    // As the migration leaves a secret from before.
    await db().secret.update({
      where: { id: keyId },
      data: { scopeAnywhere: null },
    })
    await call("edit_secret", {
      name: "Linear key",
      reason: "Clearer.",
      description: "The Linear token.",
    })
    const { row, view } = await newest()

    expect(view.secretChange!.stale).toBe(false)
    const done = await decide(row.id, { publicUrl: PUBLIC_URL })
    expect(done.isError, textOf(done)).not.toBe(true)
  })
})

describe("change_secret_scope", () => {
  it("asks to add a server and a site, shows each to tick, and makes only the ticked ones", async () => {
    const linear = await upstream()
    await call("change_secret_scope", {
      name: "Linear key",
      reason: "Linear's server should send it.",
      add_servers: ["linear"],
      add_sites: [{ origin: "https://linear.app/login" }],
    })
    const { row, view } = await newest()

    expect(view.secretChange).toMatchObject({
      action: "scope",
      scope: { anywhere: false, consumers: [] },
      changes: [
        { key: "site:add:https://linear.app", what: "site" },
        { key: `server:add:${linear.id}`, label: "Let Linear use it" },
      ],
    })

    const done = await decide(row.id, {
      publicUrl: PUBLIC_URL,
      sites: { keep: [`server:add:${linear.id}`] },
    })
    expect(done.isError, textOf(done)).not.toBe(true)
    expect(textOf(done)).toContain("let Linear use it")
    expect(textOf(done)).toContain("Not done: adding https://linear.app.")
    expect(
      (await readSecretScopes(ctx, [keyId])).get(keyId)!.consumers,
    ).toMatchObject([{ id: linear.id, granted: true, inUse: false }])
    expect(await sitesOf(ctx, keyId)).toEqual([])
  })

  it("refuses to take away what uses it now, and a change of nothing", async () => {
    await upstream(keyId)

    expect(
      (
        await call("change_secret_scope", {
          name: "Linear key",
          reason: "x",
          remove_servers: ["linear"],
        })
      ).text,
    ).toMatch(/uses "Linear key" now/)
    expect(
      (
        await call("change_secret_scope", {
          name: "Linear key",
          reason: "x",
          add_servers: ["linear"],
        })
      ).text,
    ).toMatch(/Nothing would change/)
  })

  it("writes nothing when one change cannot be made: a server that uses it since stays", async () => {
    const linear = await upstream()
    await grantSecretScope(ctx, keyId, linear.id)
    await call("change_secret_scope", {
      name: "Linear key",
      reason: "Linear is done with; it signs in at linear.app now.",
      remove_servers: ["linear"],
      add_sites: [{ origin: "https://linear.app" }],
    })
    const { row } = await newest()
    // Linear starts using it since (not part of the secret's basis).
    await db().mcpServer.update({
      where: { id: linear.id },
      data: { authType: "header", authSecretId: keyId },
    })

    const refused = await decide(row.id, {
      publicUrl: PUBLIC_URL,
      sites: {
        keep: ["site:add:https://linear.app", `server:remove:${linear.id}`],
      },
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatch(/Linear uses "Linear key" now/)
    // The site ticked beside it was not added either.
    expect(await sitesOf(ctx, keyId)).toEqual([])
    expect(
      await db().secretScope.count({
        where: { secretId: keyId, serverId: linear.id },
      }),
    ).toBe(1)
  })

  it("refuses an answer once the scope moved since it was asked", async () => {
    const linear = await upstream()
    await call("change_secret_scope", {
      name: "Linear key",
      reason: "x",
      add_servers: ["linear"],
    })
    const { row } = await newest()
    await bindOrigin(ctx, keyId, "https://late.example")

    const stale = await decide(row.id, {
      publicUrl: PUBLIC_URL,
      sites: { keep: [`server:add:${linear.id}`] },
    })
    expect(stale.isError).toBe(true)
    expect(textOf(stale)).toMatch(/changed since/)
  })
})

describe("delete_secret", () => {
  it("runs only through execute_destructive, shows what uses it, and deletes only once nothing does", async () => {
    const write = await call(
      "delete_secret",
      { name: "Linear key", reason: "Unused." },
      "execute_write",
    )
    expect(write.isError).toBe(true)
    expect(write.text).toMatch(/execute_destructive/)

    const server = await upstream(keyId)
    await call("delete_secret", { name: "Linear key", reason: "Unused." })
    const { row, view } = await newest()

    expect(view.decisions[0]!.label).toBe("Delete it")
    expect(view.secretChange).toMatchObject({
      action: "delete",
      blocking: [{ name: "Linear", via: "auth" }],
    })
    const blocked = await decide(row.id, { publicUrl: PUBLIC_URL })
    expect(blocked.isError).toBe(true)
    expect(textOf(blocked)).toMatch(/used by Linear\. Change those first/)
    expect(await db().secret.count({ where: { id: keyId } })).toBe(1)

    // The owner changes the server, then answers again.
    await db().mcpServer.update({
      where: { id: server.id },
      data: { authSecretId: null, authType: "none" },
    })
    const done = await decide(row.id, { publicUrl: PUBLIC_URL })
    expect(done.isError, textOf(done)).not.toBe(true)
    expect(textOf(done)).toContain('deleted the secret "Linear key"')
    expect(await db().secret.count({ where: { id: keyId } })).toBe(0)
  })
})

describe("PCP's own secrets", () => {
  it("are refused by every one of them before the owner is asked, with what changes them", async () => {
    await writeManagedSecret(ctx, {
      kind: "oauth",
      name: "Linear sign-in",
      description: "Linear's OAuth tokens.",
      value: "{}",
    })
    const name = "Linear sign-in"

    for (const [tool, args] of [
      ["edit_secret", { description: "x" }],
      ["rotate_secret", {}],
      ["change_secret_scope", { add_sites: [{ origin: "https://a.example" }] }],
      ["delete_secret", {}],
    ] as const) {
      const refused = await call(tool, { name, reason: "x", ...args })

      expect(refused.isError, tool).toBe(true)
      expect(refused.text, tool).toMatch(
        /the sign-in PCP keeps for a server it connected through OAuth/,
      )
    }

    expect(await db().permissionRequest.count()).toBe(0)
  })
})

describe("also allows", () => {
  it("is shown when a proposal names a secret outside its scope, and the owner's yes keeps it there", async () => {
    await call("register_server", {
      name: "Tracker",
      url: "https://tracker.example/mcp",
      auth_type: "header",
      secret: "Linear key",
    })
    const { row, view } = await newest()

    expect(view.alsoAllows).toEqual([
      {
        key: `also:${keyId}:new`,
        secretId: keyId,
        secretName: "Linear key",
        consumerId: null,
        consumer: "Tracker",
      },
    ])

    const refused = await decidePermission(
      ctx,
      row.id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      executor,
    )
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatch(
      /also lets Tracker use your secret "Linear key"/,
    )

    const done = await decidePermission(
      ctx,
      row.id,
      "allow_once",
      { publicUrl: PUBLIC_URL, alsoAllow: [`also:${keyId}:new`] },
      executor,
    )
    expect(done.isError, textOf(done)).not.toBe(true)
    const tracker = await db().mcpServer.findFirstOrThrow({
      where: { authSecretId: keyId },
    })
    expect(
      await db().secretScope.count({
        where: { secretId: keyId, serverId: tracker.id },
      }),
    ).toBe(1)
  })

  it("is not shown for a consumer the owner granted, the secret not being allowed anywhere", async () => {
    const granted = await upstream()
    const other = await createServer(ctx, {
      name: "Other",
      url: "https://other.example/mcp",
      authType: "none",
    })
    await grantSecretScope(ctx, keyId, granted.id)
    expect(
      (await db().secret.findUniqueOrThrow({ where: { id: keyId } }))
        .scopeAnywhere,
    ).toBe(false)

    expect(
      await alsoAllowsFor(ctx, [
        {
          id: keyId,
          consumers: [
            { id: granted.id, name: "Linear" },
            { id: other.id, name: "Other" },
          ],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        key: `also:${keyId}:${other.id}`,
        consumerId: other.id,
      }),
    ])
    expect(tokenId).toBeTruthy()
  })

  it("keeps only what the request made, not a use another change made meanwhile", async () => {
    const elsewhere = await createServer(ctx, {
      name: "Elsewhere",
      url: "https://elsewhere.example/mcp",
      authType: "none",
    })
    await call("register_server", {
      name: "Tracker",
      url: "https://tracker.example/mcp",
      auth_type: "header",
      secret: "Linear key",
    })
    const { row } = await newest()
    const racing: PermissionExecutor = {
      ...executor,
      // While the yes runs, the owner's own page gives Elsewhere the secret.
      async syncTools(...args) {
        await db().mcpServer.update({
          where: { id: elsewhere.id },
          data: { authType: "header", authSecretId: keyId },
        })
        return executor.syncTools(...args)
      },
    }

    const done = await decidePermission(
      ctx,
      row.id,
      "allow_once",
      { publicUrl: PUBLIC_URL, alsoAllow: [`also:${keyId}:new`] },
      racing,
    )
    expect(done.isError, textOf(done)).not.toBe(true)
    const tracker = await db().mcpServer.findFirstOrThrow({
      where: { authSecretId: keyId, NOT: { id: elsewhere.id } },
    })
    expect(
      await db().secretScope.findMany({
        where: { secretId: keyId },
        select: { serverId: true },
      }),
    ).toEqual([{ serverId: tracker.id }])
  })
})
