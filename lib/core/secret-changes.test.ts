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
import {
  createSecret,
  readSecretValue,
  updateSecret,
  writeManagedSecret,
} from "./secrets"
import { serverCreateData, writeServer } from "./server-meta"
import { createServer } from "./servers"
import { entryCall } from "./test-handles"
import { scratchDatabase } from "./test-db"
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
        key: `also:${keyId}`,
        secretId: keyId,
        secretName: "Linear key",
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
      { publicUrl: PUBLIC_URL, alsoAllow: [`also:${keyId}`] },
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

  it("is not shown for a consumer the secret's scope covers", async () => {
    const tracker = await upstream()
    await grantSecretScope(ctx, keyId, tracker.id)
    await db().secret.update({
      where: { id: keyId },
      data: { scopeAnywhere: true },
    })
    await call("register_server", {
      name: "Tracker two",
      url: "https://tracker2.example/mcp",
      auth_type: "header",
      secret: "Linear key",
    })

    expect((await newest()).view.alsoAllows).toEqual([])
    expect(tokenId).toBeTruthy()
  })
})
