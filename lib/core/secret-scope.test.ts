import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import { admitSecretUse, bindOrigin, grantSecretUse } from "./browser-secrets"
import { createBrowserServer } from "./browser/server"
import type { VaultContext } from "./context"
import { db } from "./db"
import { isPcpError } from "./errors"
import { newId } from "./ids"
import { resolveSecretRef, type SecretRefUse } from "./secret-refs"
import {
  ensureSecretScopes,
  grantSecretScope,
  readSecretScopes,
  removeFromSecretScope,
  scopeCovers,
  setSecretAnywhere,
} from "./secret-scope"
import { createSecret, writeManagedSecret } from "./secrets"
import { serverCreateData } from "./server-meta"
import { createServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// A secret's scope (#162): where it may be used, worked out for secrets
// from before from their uses, checked in the one resolver for every
// consumer, and the browser's own gate for one with no sites.

let cleanup: () => Promise<void>
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({ name: "Ada", password: "correct horse battery" })
})

afterEach(async () => {
  await cleanup()
})

async function headerServer(name: string, secretId: string | null = null) {
  return createServer(ctx, {
    name,
    url: `https://${name.toLowerCase()}.example/mcp`,
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

async function service(name: string, env: Record<string, string>) {
  const id = newId()

  await db().mcpServer.create({
    data: serverCreateData(ctx, {
      id,
      vaultId: ctx.vaultId,
      kind: "service",
      name,
      slug: name.toLowerCase(),
      url: "pcp:service",
      serviceSpec: {
        create: {
          plainDefinition: "{}",
          hash: "0",
          engine: "docker",
          plainContainerName: `pcp-${name.toLowerCase()}`,
          env: JSON.stringify(env),
        },
      },
    }),
  })

  return id
}

async function wrapper(name: string, secretId: string, serverId: string) {
  const id = newId()
  const definition = {
    version: 1,
    tools: [],
    secrets: [
      {
        secret: "Key",
        secretId,
        serverId,
        tool: "search",
        argument: "/key",
        template: "{{secret}}",
        url: "https://upstream.example/mcp",
      },
    ],
  }

  await db().mcpServer.create({
    data: serverCreateData(ctx, {
      id,
      vaultId: ctx.vaultId,
      kind: "wrapper",
      name,
      slug: name.toLowerCase(),
      url: "pcp:wrapper",
      wrapperSpec: {
        create: { plainDefinition: JSON.stringify(definition), hash: "x" },
      },
    }),
  })

  return id
}

/** As a row from before the scope: the migration's mark. */
async function fromBefore(id: string) {
  await db().secret.update({
    where: { id },
    data: { scopeAnywhere: null },
  })
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (isPcpError(error)) return error.message
    throw error
  }
  throw new Error("expected a refusal")
}

describe("the scope of a secret from before (the migration)", () => {
  it("gives a used secret its uses as its scope and an unused one anywhere, once", async () => {
    const sent = await createSecret(ctx, { name: "Sent", value: "a" })
    const spare = await createSecret(ctx, { name: "Spare", value: "b" })
    const typed = await createSecret(ctx, { name: "Typed", value: "c" })
    const upstream = await headerServer("Upstream", sent.id)
    const docs = await service("Docs", { API_KEY: sent.id })
    const lookup = await wrapper("Lookup", sent.id, upstream.id)
    await bindOrigin(ctx, typed.id, "https://shop.example")

    // As the migration leaves them: no scope yet.
    for (const { id } of [sent, spare, typed]) await fromBefore(id)

    await ensureSecretScopes(ctx)

    const rows = await db().secret.findMany({
      select: { id: true, scopeAnywhere: true },
    })
    expect(
      Object.fromEntries(rows.map((row) => [row.id, row.scopeAnywhere])),
    ).toEqual({ [sent.id]: false, [spare.id]: true, [typed.id]: true })
    expect(
      (
        await db().secretScope.findMany({
          where: { secretId: sent.id },
          select: { serverId: true },
        })
      )
        .map((row) => row.serverId)
        .sort(),
    ).toEqual([upstream.id, docs, lookup].sort())

    const scopes = await readSecretScopes(ctx)
    expect(scopes.get(sent.id)).toMatchObject({
      anywhere: false,
      consumers: [
        { name: "Docs", kind: "service", inUse: true, granted: true },
        { name: "Lookup", wrapper: true, inUse: true, granted: true },
        { name: "Upstream", kind: "server", inUse: true, granted: true },
      ],
    })
    // Nothing changes on day one: what used it still may, and the one
    // nothing used may be used anywhere, as before.
    for (const id of [upstream.id, docs, lookup]) {
      expect(await scopeCovers(ctx, sent.id, id)).toBe(true)
    }
    expect(await scopeCovers(ctx, spare.id, upstream.id)).toBe(true)
    expect(await scopeCovers(ctx, sent.id, null)).toBe(false)

    // A second pass finds nothing to do and writes nothing twice.
    await ensureSecretScopes(ctx)
    expect(await db().secretScope.count()).toBe(3)
  })
})

describe("resolveSecretRef and the scope", () => {
  const USES: SecretRefUse[] = [
    { kind: "header" },
    { kind: "basic" },
    { kind: "oauth_client" },
    { kind: "service_env" },
    { kind: "wrapper_binding" },
    { kind: "wrapper_binding", typed: true },
    { kind: "mail" },
    { kind: "caldav" },
  ]

  it("refuses a secret outside the consumer's scope for every use, naming change_secret_scope", async () => {
    await createSecret(ctx, { name: "Key", value: "v" })
    const other = await headerServer("Other")

    for (const use of USES) {
      const consumer = { id: other.id, name: "Other" }

      expect(
        await refusal(resolveSecretRef(ctx, "Key", { ...use, consumer })),
        use.kind,
      ).toMatch(
        /has not allowed the secret "Key" for Other\. change_secret_scope/,
      )
      // A proposal hears it is outside, and the owner's page shows it.
      expect(
        await resolveSecretRef(ctx, "Key", {
          ...use,
          consumer,
          scope: "ask",
        }),
        use.kind,
      ).toMatchObject({ name: "Key", inScope: false })
      // The owner's yes to that page.
      expect(
        await resolveSecretRef(ctx, "Key", {
          ...use,
          consumer,
          scope: "granted",
        }),
        use.kind,
      ).toMatchObject({ name: "Key", inScope: false })
      // No consumer named: the owner's own lookups, as before.
      expect(await resolveSecretRef(ctx, "Key", use), use.kind).toMatchObject({
        inScope: true,
      })
    }
  })

  it("lets through a consumer the owner granted, one that uses it now, and anything for one allowed anywhere", async () => {
    const key = await createSecret(ctx, { name: "Key", value: "v" })
    const granted = await headerServer("Granted")
    const using = await headerServer("Using", key.id)
    const docs = await service("Docs", { API_KEY: key.id })
    const lookup = await wrapper("Lookup", key.id, using.id)
    const stranger = await headerServer("Stranger")

    await grantSecretScope(ctx, key.id, granted.id)

    const resolves = (use: SecretRefUse, id: string) =>
      resolveSecretRef(ctx, "Key", { ...use, consumer: { id, name: id } })

    expect(await resolves({ kind: "header" }, granted.id)).toMatchObject({
      inScope: true,
    })
    expect(await resolves({ kind: "header" }, using.id)).toMatchObject({
      inScope: true,
    })
    expect(await resolves({ kind: "service_env" }, docs)).toMatchObject({
      inScope: true,
    })
    expect(await resolves({ kind: "wrapper_binding" }, lookup)).toMatchObject({
      inScope: true,
    })
    await expect(resolves({ kind: "mail" }, stranger.id)).rejects.toThrow(
      /change_secret_scope/,
    )

    await setSecretAnywhere(ctx, key.id, true)
    expect(await resolves({ kind: "caldav" }, stranger.id)).toMatchObject({
      inScope: true,
    })
    // A consumer a proposal would make is covered only by anywhere.
    expect(
      await resolveSecretRef(ctx, "Key", {
        kind: "header",
        consumer: { id: null, name: "New" },
      }),
    ).toMatchObject({ inScope: true })
  })

  it("keeps a consumer that uses it while it does, and takes one away that does not", async () => {
    const key = await createSecret(ctx, { name: "Key", value: "v" })
    const using = await headerServer("Using", key.id)
    const spare = await headerServer("Spare")
    await grantSecretScope(ctx, key.id, spare.id)
    await grantSecretScope(ctx, key.id, using.id)

    expect(await refusal(removeFromSecretScope(ctx, key.id, using.id))).toMatch(
      /Using uses this secret now/,
    )
    await removeFromSecretScope(ctx, key.id, spare.id)
    expect(await scopeCovers(ctx, key.id, spare.id)).toBe(false)
    expect(await scopeCovers(ctx, key.id, using.id)).toBe(true)
  })

  it("grants only servers, services and wrappers of the vault", async () => {
    const key = await createSecret(ctx, { name: "Key", value: "v" })
    const browser = await createBrowserServer(ctx)

    await expect(grantSecretScope(ctx, key.id, browser.id)).rejects.toThrow(
      /not found/,
    )
    await expect(grantSecretScope(ctx, key.id, "nope")).rejects.toThrow(
      /not found/,
    )
  })
})

describe("the browser's gate and the scope", () => {
  const use = {
    tabId: "t1",
    origin: "https://webmail.example",
    url: "https://webmail.example/login",
    title: "Sign in",
    field: 'the textbox "Password"',
    call: { tab: "t1", ref: "e3" },
  }

  async function typing(bound = false) {
    const { token } = await createApiToken(ctx, {
      name: `Claude ${newId()}`,
      allowAllServers: true,
    })
    const tokenId = (await resolveApiToken(token))!.tokenId
    const browser =
      (await db().mcpServer.findFirst({ where: { kind: "browser" } })) ??
      (await createBrowserServer(ctx))

    return {
      tokenId,
      type: () =>
        admitSecretUse(ctx, {
          tokenId,
          serverId: browser.id,
          name: "Mail password",
          use,
          ...(bound ? { bound: true } : {}),
        }),
    }
  }

  it("asks every time for a secret with no site outside its scope: Once types it that time, an allowance for a while does not", async () => {
    // A mail account's password, never given a site (day one's case).
    const { id } = await createSecret(ctx, {
      name: "Mail password",
      value: "v",
    })
    await headerServer("Mail", id)
    const { tokenId, type } = await typing()

    await expect(type()).rejects.toMatchObject({
      ask: { kind: "secret_use", input: { outOfScope: true } },
    })

    // An hour's allowance (from before, or for another site's sake) is not
    // an answer to this use.
    await grantSecretUse(ctx, {
      tokenId,
      secretId: id,
      origin: use.origin,
      level: "hour",
    })
    await expect(type()).rejects.toMatchObject({
      ask: { input: { outOfScope: true } },
    })

    // The owner's Once: typed that one time, the scope unchanged.
    await grantSecretUse(ctx, {
      tokenId,
      secretId: id,
      origin: use.origin,
      level: "once",
    })
    await expect(type()).resolves.toMatchObject({ name: "Mail password" })
    expect(await db().secretBrowserOrigin.count()).toBe(0)
    await expect(type()).rejects.toMatchObject({
      ask: { input: { outOfScope: true } },
    })

    // Always at this site adds the site: then it is in scope, as before.
    await grantSecretUse(ctx, {
      tokenId,
      secretId: id,
      origin: use.origin,
      level: "always",
    })
    await expect(type()).resolves.toMatchObject({ name: "Mail password" })
  })

  it("lets a wrapper's place for it type it through the gate as before", async () => {
    const { id } = await createSecret(ctx, {
      name: "Mail password",
      value: "v",
    })
    const browser = await createBrowserServer(ctx)
    await wrapper("Mail flow", id, browser.id)
    const { tokenId, type } = await typing(true)

    // Asked about the site as before, not as outside its scope.
    const asked = await type().catch((error: unknown) => error)
    expect(asked).toMatchObject({ ask: { kind: "secret_use" } })
    expect(
      (asked as { ask: { input: { outOfScope?: true } } }).ask.input.outOfScope,
    ).toBeUndefined()

    // And an hour's allowance counts there, as before.
    await grantSecretUse(ctx, {
      tokenId,
      secretId: id,
      origin: use.origin,
      level: "hour",
    })
    await expect(type()).resolves.toMatchObject({ name: "Mail password" })
  })

  it("asks as before for one allowed anywhere, and for one with a site", async () => {
    const { id } = await createSecret(ctx, {
      name: "Mail password",
      value: "v",
      anywhere: true,
    })
    const { type } = await typing()
    const asked = await type().catch((error: unknown) => error)

    expect(asked).toMatchObject({ ask: { kind: "secret_use" } })
    expect(
      (asked as { ask: { input: { outOfScope?: true } } }).ask.input.outOfScope,
    ).toBeUndefined()

    await setSecretAnywhere(ctx, id, false)
    await bindOrigin(ctx, id, "https://other.example")
    const again = await type().catch((error: unknown) => error)
    expect(
      (again as { ask: { input: { outOfScope?: true } } }).ask.input.outOfScope,
    ).toBeUndefined()
  })
})

describe("filling in a scope from before", () => {
  it("leaves a secret nothing seems to use unfilled while a wrapper's definition does not read, and fills it once it does", async () => {
    const spare = await createSecret(ctx, { name: "Spare", value: "b" })
    const used = await createSecret(ctx, { name: "Used", value: "a" })
    await headerServer("Upstream", used.id)
    const broken = newId()
    await db().mcpServer.create({
      data: serverCreateData(ctx, {
        id: broken,
        vaultId: ctx.vaultId,
        kind: "wrapper",
        name: "Broken",
        slug: "broken",
        url: "pcp:wrapper",
        wrapperSpec: {
          create: { plainDefinition: "{not json", hash: "x" },
        },
      }),
    })
    await fromBefore(spare.id)
    await fromBefore(used.id)

    await ensureSecretScopes(ctx)

    const marks = async () =>
      Object.fromEntries(
        (
          await db().secret.findMany({
            select: { id: true, scopeAnywhere: true },
          })
        ).map((row) => [row.id, row.scopeAnywhere]),
      )
    // The one with a use is narrowed; the other is not made anywhere.
    expect(await marks()).toEqual({ [spare.id]: null, [used.id]: false })

    await db().mcpServer.delete({ where: { id: broken } })
    await ensureSecretScopes(ctx)
    expect((await marks())[spare.id]).toBe(true)
  })

  it("never makes one of PCP's own secrets anywhere", async () => {
    await writeManagedSecret(ctx, {
      kind: "generated",
      name: "svc/API_KEY",
      description: "A value PCP made.",
      value: "x",
    })
    await db().secret.updateMany({ data: { scopeAnywhere: null } })

    await ensureSecretScopes(ctx)

    expect(
      (await db().secret.findFirstOrThrow({ where: { kind: "generated" } }))
        .scopeAnywhere,
    ).toBe(false)
  })
})
