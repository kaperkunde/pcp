import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import { admitSecretUse, bindOrigin } from "./browser-secrets"
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
import { createSecret } from "./secrets"
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
  it("never types a secret with no sites unless it may be used anywhere, and then asks", async () => {
    const { token } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })
    const tokenId = (await resolveApiToken(token))!.tokenId
    const browser = await createBrowserServer(ctx)
    await createSecret(ctx, { name: "Key", value: "v" })
    const use = {
      tabId: "t1",
      origin: "https://shop.example",
      url: "https://shop.example/login",
      title: "Sign in",
      field: 'the textbox "Password"',
      call: { tab: "t1", ref: "e3" },
    }
    const typing = () =>
      admitSecretUse(ctx, {
        tokenId,
        serverId: browser.id,
        name: "Key",
        use,
      })

    expect(await refusal(typing())).toMatch(
      /has no sites the browser may type it at.*change_secret_scope/,
    )

    const { id } = (await db().secret.findFirst({ select: { id: true } }))!
    await setSecretAnywhere(ctx, id, true)
    // Allowed anywhere: the owner is asked, as before.
    await expect(typing()).rejects.toMatchObject({
      ask: { kind: "secret_use" },
    })

    // With a site and not anywhere: asked at its site.
    await setSecretAnywhere(ctx, id, false)
    await bindOrigin(ctx, id, "https://shop.example")
    await expect(typing()).rejects.toMatchObject({
      ask: { kind: "secret_use" },
    })
  })
})
