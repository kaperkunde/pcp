import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { gunzipSync } from "node:zlib"

import { createApiToken, resolveApiToken } from "./api-tokens"
import {
  encodeExport,
  exportFileName,
  exportVault,
  readExport,
  restoreExport,
} from "./backup"
import { EXPORT_AAD, type ExportPayloadJson } from "./backup-format"
import { storeTools } from "./catalogue"
import {
  asBytes,
  decrypt,
  decryptString,
  deriveKek,
  encryptString,
  type ScryptParams,
} from "./crypto"
import { db } from "./db"
import { getHostJson, setHostJson } from "./host-settings"
import { createMailAccount } from "./mail/accounts"
import { createMemory, listMemories } from "./memories"
import { DDNS_CONFIG_KEY, DDNS_STATUS_KEY } from "./network/ddns"
import { UPDATE_CONFIG_KEY, UPDATE_STATUS_KEY } from "./updates/state"
import { createSecret, deleteSecret, revealSecret } from "./secrets"
import { createServer } from "./servers"
import { createSession, resolveSession } from "./sessions"
import { getSetting, SETTING_PUBLIC_URL, setSetting } from "./settings"
import { scratchDatabase } from "./test-db"
import { keepResult, readResult } from "./tool-results"
import {
  ownerVault,
  resetPasswordWithRecoveryKey,
  setupVault,
  unlockOwnerVault,
} from "./vault"

// Export and restore against a scratch database: the file carries the
// vault's rows as they are, a restore puts them back whole, and every way a
// file can be wrong is refused with a reason. Every file costs a scrypt run
// to make and one to open, so the suites get more than the default 5 s.

let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
})

afterEach(async () => {
  await cleanup()
})

const PASSWORD = "correct horse battery staple"
const EXPORT_PASSWORD = "a long export password"

/** A vault with one of everything, and the facts a test checks afterwards. */
async function populate() {
  const { vaultId, dek, recoveryKey } = await setupVault({
    name: "Ada",
    password: PASSWORD,
  })
  const ctx = { vaultId, dek }
  const secret = await createSecret(ctx, { name: "api-key", value: "s3cret" })
  const spare = await createSecret(ctx, { name: "spare", value: "unused" })
  const server = await createServer(ctx, {
    name: "Upstream",
    url: "https://upstream.example/mcp",
    authType: "header",
    authHeaderName: "Authorization",
    authValueTemplate: "Bearer {{secret}}",
    authSecretId: secret.id,
  })
  await storeTools(server.id, [
    { name: "alpha", description: "First", inputSchema: { type: "object" } },
    { name: "beta", description: "Second", inputSchema: { type: "object" } },
  ])
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  })
  await createMemory(ctx, { path: "notes.md", text: "Remember this." })
  await setSetting(ctx, SETTING_PUBLIC_URL, "https://pcp.example")
  await setHostJson(DDNS_CONFIG_KEY, {
    provider: "duckdns",
    subdomain: "ada",
    token: "duck-token",
  })
  await setHostJson(DDNS_STATUS_KEY, { lastIp: "203.0.113.5" })
  await setHostJson(UPDATE_CONFIG_KEY, { check: false })
  await setHostJson(UPDATE_STATUS_KEY, {
    lastCheckedAt: "2026-01-01T00:00:00.000Z",
  })

  return {
    ctx,
    recoveryKey,
    secretId: secret.id,
    spareId: spare.id,
    serverId: server.id,
    token,
  }
}

/** The payload as the file holds it, for tests that bend it. */
async function openRaw(file: Buffer, password: string) {
  const envelope = JSON.parse(file.toString("utf8")) as {
    kdf: ScryptParams
    data: string
  }
  const key = await deriveKek(password, envelope.kdf)
  const packed = decrypt(key, Buffer.from(envelope.data, "base64"), EXPORT_AAD)

  return JSON.parse(gunzipSync(packed).toString("utf8")) as ExportPayloadJson
}

describe("the export file", { timeout: 60_000 }, () => {
  it("holds the rows as they are, under the export password, without sessions", async () => {
    const { ctx, token } = await populate()
    await createSession(ctx)

    const file = await exportVault(ctx, EXPORT_PASSWORD)
    const text = file.toString("utf8")
    expect(text).not.toContain("s3cret")
    expect(text).not.toContain(token)

    const payload = await openRaw(file, EXPORT_PASSWORD)
    expect(payload.vault.name).toBe("Ada")
    expect(payload.publicUrl).toBe("https://pcp.example")
    expect(payload.tables.keyGrants.map((grant) => grant.kind).sort()).toEqual([
      "api_token",
      "password",
      "recovery",
    ])
    expect(payload.tables.secrets).toHaveLength(2)
    expect(payload.tables.tools).toHaveLength(2)
    expect(payload.tables.memories).toHaveLength(1)
    expect(payload.host.map((row) => row.key).sort()).toEqual(
      [DDNS_CONFIG_KEY, UPDATE_CONFIG_KEY].sort(),
    )
    // A machine's status never travels.
    expect(JSON.stringify(payload)).not.toContain("2026-01-01T00:00:00.000Z")
    // Ciphertext, not values: the secret is as unreadable here as on disk.
    expect(JSON.stringify(payload)).not.toContain("s3cret")
    expect(JSON.stringify(payload)).not.toContain("Remember this.")

    const { preview } = await readExport(file, EXPORT_PASSWORD)
    expect(preview.vaultName).toBe("Ada")
    expect(preview.counts).toMatchObject({
      servers: 1,
      endpoints: 0,
      tools: 2,
      secrets: 2,
      tokens: 1,
      memories: 1,
    })
    expect(preview.host).toEqual({
      ddns: true,
      ddnsName: "ada.duckdns.org",
      https: false,
      updateCheck: false,
    })
  })

  it("asks at least as much of the export password as of the owner's", async () => {
    const { ctx } = await populate()
    await expect(exportVault(ctx, "short")).rejects.toThrow(/at least/)
  })

  it("is named after the day", () => {
    expect(exportFileName(new Date("2026-10-04T23:59:00Z"))).toBe(
      "pcp-export-2026-10-04.pcpexport",
    )
  })
})

describe("restoring", { timeout: 60_000 }, () => {
  it("puts everything back, and the password, recovery key and tokens keep working", async () => {
    const { ctx, recoveryKey, secretId, spareId, token } = await populate()
    const file = await exportVault(ctx, EXPORT_PASSWORD)
    const before = await db().mcpTool.findFirst({ where: { name: "alpha" } })

    // Changes after the export: gone once it is restored.
    await deleteSecret(ctx, spareId)
    const marker = await createSecret(ctx, { name: "marker", value: "later" })
    const session = await createSession(ctx)
    await setHostJson(DDNS_CONFIG_KEY, {
      provider: "duckdns",
      subdomain: "changed",
      token: "other",
    })
    await setHostJson(UPDATE_CONFIG_KEY, { check: true })

    const { payload } = await readExport(file, EXPORT_PASSWORD)
    await restoreExport(
      payload,
      { into: "vault", vaultId: ctx.vaultId },
      { restoreHostSettings: false },
    )

    const unlocked = await unlockOwnerVault(PASSWORD)
    expect(unlocked?.vaultId).toBe(ctx.vaultId)
    expect(await revealSecret(unlocked!, secretId)).toBe("s3cret")
    expect(await revealSecret(unlocked!, spareId)).toBe("unused")
    await expect(revealSecret(unlocked!, marker.id)).rejects.toThrow(
      /not found/,
    )
    expect((await resolveApiToken(token))?.tokenName).toBe("Claude")
    expect(await resolveSession(session.cookieValue)).toBeNull()
    expect(await getSetting(unlocked!, SETTING_PUBLIC_URL)).toBe(
      "https://pcp.example",
    )
    expect(
      (await listMemories(unlocked!)).map((memory) => memory.text),
    ).toEqual(["Remember this."])
    // Timestamps are the file's, not the restore's.
    const after = await db().mcpTool.findFirst({ where: { name: "alpha" } })
    expect(after?.updatedAt.toISOString()).toBe(before?.updatedAt.toISOString())
    expect(after?.id).toBe(before?.id)
    // Host settings stayed as they were: they were not asked for.
    expect(await getHostJson(DDNS_CONFIG_KEY)).toMatchObject({
      subdomain: "changed",
    })
    expect(await getHostJson(UPDATE_CONFIG_KEY)).toEqual({ check: true })

    // The recovery key from before the export still opens it.
    const recovered = await resetPasswordWithRecoveryKey(
      recoveryKey,
      "another good password",
    )
    expect(recovered.vaultId).toBe(ctx.vaultId)
  })

  it("brings a mail account back as it was, without the answers PCP kept for a day", async () => {
    const { ctx, secretId } = await populate()
    const imap = await createMailAccount(ctx, {
      protocol: "imap",
      name: "Post",
      url: "imaps://mail.example:993",
      smtpUrl: "smtps://mail.example:465",
      readOnly: false,
      authType: "basic",
      authUsername: "ada@example.com",
      authSecretId: secretId,
      mailFrom: "Ada <ada@example.com>",
    })
    const jmap = await createMailAccount(ctx, {
      protocol: "jmap",
      name: "Stalwart",
      url: "https://mail.example/.well-known/jmap",
      readOnly: true,
      authType: "basic",
      authUsername: "ada",
      authSecretId: secretId,
    })
    // What the session document said, as a check writes it.
    await db().mcpServer.update({
      where: { id: jmap.id },
      data: {
        mailApiUrl: "https://mail.example/jmap/",
        mailDownloadUrl:
          "https://mail.example/jmap/download/{accountId}/{blobId}/{name}",
        mailAccountId: "a1",
        mailSubmission: true,
      },
    })
    const tokenId = (await db().apiToken.findFirstOrThrow()).id
    const kept = await keepResult(ctx, {
      tokenId,
      serverId: imap.id,
      toolName: "get_email",
      text: "a long body ".repeat(10_000),
      mediaType: "text/plain",
    })
    expect((await readResult(ctx, { tokenId, id: kept.id })).total).toBe(
      kept.length,
    )
    const mail = await db().mcpServer.findMany({
      where: { id: { in: [imap.id, jmap.id] } },
      orderBy: { name: "asc" },
    })

    const file = await exportVault(ctx, EXPORT_PASSWORD)
    const payload = await openRaw(file, EXPORT_PASSWORD)
    expect(payload.tables).not.toHaveProperty("toolResults")
    expect(JSON.stringify(payload)).not.toContain(kept.id)
    const { payload: read, preview } = await readExport(file, EXPORT_PASSWORD)
    expect(preview.counts).toMatchObject({
      servers: 1,
      endpoints: 0,
      mailAccounts: 2,
    })

    await restoreExport(
      read,
      { into: "vault", vaultId: ctx.vaultId },
      { restoreHostSettings: false },
    )

    expect(
      await db().mcpServer.findMany({
        where: { id: { in: [imap.id, jmap.id] } },
        orderBy: { name: "asc" },
      }),
    ).toEqual(mail)
    await expect(
      readResult(ctx, { tokenId, id: kept.id }),
    ).rejects.toMatchObject({ code: "not_found" })
  })

  it("carries the browser's sign-ins as they are, and restores a file from before the browser", async () => {
    const { ctx } = await populate()
    const state = JSON.stringify({
      cookies: [{ name: "sid", value: "very-secret-cookie" }],
      origins: [],
    })
    await db().browserProfile.create({
      data: {
        vaultId: ctx.vaultId,
        ciphertext: asBytes(
          encryptString(ctx.dek, state, `browser_profile:${ctx.vaultId}`),
        ),
        sites: 3,
        cookies: 1,
        size: state.length,
        savedAt: new Date("2026-10-05T12:00:00Z"),
      },
    })
    const before = await db().browserProfile.findUniqueOrThrow({
      where: { vaultId: ctx.vaultId },
    })

    const file = await exportVault(ctx, EXPORT_PASSWORD)
    const payload = await openRaw(file, EXPORT_PASSWORD)
    expect(payload.tables.browserProfiles).toHaveLength(1)
    expect(JSON.stringify(payload)).not.toContain("very-secret-cookie")
    const { payload: read, preview } = await readExport(file, EXPORT_PASSWORD)
    expect(preview.counts.browserSites).toBe(3)

    await db().browserProfile.delete({ where: { vaultId: ctx.vaultId } })
    await restoreExport(
      read,
      { into: "vault", vaultId: ctx.vaultId },
      { restoreHostSettings: false },
    )
    const after = await db().browserProfile.findUniqueOrThrow({
      where: { vaultId: ctx.vaultId },
    })
    expect(after).toEqual(before)
    expect(
      decryptString(
        ctx.dek,
        Buffer.from(after.ciphertext),
        `browser_profile:${ctx.vaultId}`,
      ),
    ).toBe(state)

    // A file from before the browser has no such table, and restores
    // without sign-ins.
    const older = structuredClone(payload) as {
      tables: Record<string, unknown>
    }
    delete older.tables.browserProfiles
    const { payload: oldRead, preview: oldPreview } = await readExport(
      await encodeExport(older as ExportPayloadJson, EXPORT_PASSWORD),
      EXPORT_PASSWORD,
    )
    expect(oldPreview.counts.browserSites).toBe(0)
    await restoreExport(
      oldRead,
      { into: "vault", vaultId: ctx.vaultId },
      { restoreHostSettings: false },
    )
    expect(await db().browserProfile.count()).toBe(0)
  })

  it("restores a file from before mail accounts, with their columns empty", async () => {
    const { ctx, serverId } = await populate()
    const payload = await openRaw(
      await exportVault(ctx, EXPORT_PASSWORD),
      EXPORT_PASSWORD,
    )
    const older = structuredClone(payload)
    for (const row of older.tables.servers as Record<string, unknown>[]) {
      for (const column of [
        "authUsername",
        "mailApiUrl",
        "mailDownloadUrl",
        "mailAccountId",
        "mailSubmission",
        "smtpUrl",
        "mailFrom",
      ]) {
        delete row[column]
      }
    }

    const { payload: read } = await readExport(
      await encodeExport(older, EXPORT_PASSWORD),
      EXPORT_PASSWORD,
    )
    await restoreExport(
      read,
      { into: "vault", vaultId: ctx.vaultId },
      { restoreHostSettings: false },
    )

    expect(
      await db().mcpServer.findUniqueOrThrow({ where: { id: serverId } }),
    ).toMatchObject({
      kind: "mcp",
      authUsername: null,
      mailApiUrl: null,
      mailSubmission: false,
      smtpUrl: null,
      mailFrom: null,
    })
  })

  it("replaces the host's network settings only when asked, and drops their status", async () => {
    const { ctx } = await populate()
    const file = await exportVault(ctx, EXPORT_PASSWORD)
    await setHostJson(DDNS_CONFIG_KEY, null)
    await setHostJson(DDNS_STATUS_KEY, { lastIp: "198.51.100.9" })
    await setHostJson(UPDATE_CONFIG_KEY, { check: true })
    await setHostJson(UPDATE_STATUS_KEY, {
      lastCheckedAt: "2026-02-02T00:00:00.000Z",
    })

    const { payload } = await readExport(file, EXPORT_PASSWORD)
    await restoreExport(
      payload,
      { into: "vault", vaultId: ctx.vaultId },
      { restoreHostSettings: true },
    )

    expect(await getHostJson(DDNS_CONFIG_KEY)).toMatchObject({
      subdomain: "ada",
    })
    expect(await getHostJson(DDNS_STATUS_KEY)).toBeNull()
    // The owner's choice comes back; what GitHub said here stays.
    expect(await getHostJson(UPDATE_CONFIG_KEY)).toEqual({ check: false })
    expect(await getHostJson(UPDATE_STATUS_KEY)).toEqual({
      lastCheckedAt: "2026-02-02T00:00:00.000Z",
    })
  })

  it("restores into a PCP not set up yet, which then opens with the exported credentials", async () => {
    const { ctx, recoveryKey, token } = await populate()
    const file = await exportVault(ctx, EXPORT_PASSWORD)
    const { payload } = await readExport(file, EXPORT_PASSWORD)

    await expect(
      restoreExport(payload, { into: "fresh" }, { restoreHostSettings: false }),
    ).rejects.toThrow(/already set up/)

    // A new machine: an empty database.
    await cleanup()
    ;({ cleanup } = await scratchDatabase())
    expect(await ownerVault()).toBeNull()

    await expect(
      restoreExport(
        payload,
        { into: "vault", vaultId: ctx.vaultId },
        { restoreHostSettings: false },
      ),
    ).rejects.toThrow(/gone/)

    await restoreExport(
      payload,
      { into: "fresh" },
      { restoreHostSettings: true },
    )

    expect((await ownerVault())?.id).toBe(ctx.vaultId)
    expect((await unlockOwnerVault(PASSWORD))?.vaultId).toBe(ctx.vaultId)
    expect((await resolveApiToken(token))?.tokenName).toBe("Claude")
    expect(await getHostJson(DDNS_CONFIG_KEY)).toMatchObject({
      subdomain: "ada",
    })
    const recovered = await resetPasswordWithRecoveryKey(
      recoveryKey,
      "another good password",
    )
    expect(recovered.vaultId).toBe(ctx.vaultId)
  })

  it("replaces a vault with another one's export", async () => {
    const first = await populate()
    const file = await exportVault(first.ctx, EXPORT_PASSWORD)
    const { payload } = await readExport(file, EXPORT_PASSWORD)

    await cleanup()
    ;({ cleanup } = await scratchDatabase())
    const second = await setupVault({
      name: "Eve",
      password: "eve's own password",
    })
    await createSecret(second, { name: "eve-secret", value: "eve" })

    await restoreExport(
      payload,
      { into: "vault", vaultId: second.vaultId },
      { restoreHostSettings: false },
    )

    expect(await db().vault.count()).toBe(1)
    expect((await ownerVault())?.name).toBe("Ada")
    expect(await unlockOwnerVault("eve's own password")).toBeNull()
    expect((await unlockOwnerVault(PASSWORD))?.vaultId).toBe(first.ctx.vaultId)
    expect(await db().secret.count()).toBe(2)
  })

  it("writes a large catalogue in chunks", async () => {
    const { ctx, serverId } = await populate()
    await storeTools(
      serverId,
      Array.from({ length: 1200 }, (_, index) => ({
        name: `tool_${index}`,
        description: `Tool ${index}`,
        inputSchema: { type: "object" },
      })),
    )
    const file = await exportVault(ctx, EXPORT_PASSWORD)
    await db().mcpTool.deleteMany({})

    const { payload } = await readExport(file, EXPORT_PASSWORD)
    await restoreExport(
      payload,
      { into: "vault", vaultId: ctx.vaultId },
      { restoreHostSettings: false },
    )

    expect(await db().mcpTool.count()).toBe(1200)
  })
})

describe("refusing a file", { timeout: 60_000 }, () => {
  it("with the wrong export password, or a changed byte", async () => {
    const { ctx } = await populate()
    const file = await exportVault(ctx, EXPORT_PASSWORD)

    await expect(readExport(file, "not the export password")).rejects.toThrow(
      /export password/,
    )

    const envelope = JSON.parse(file.toString("utf8")) as { data: string }
    const data = Buffer.from(envelope.data, "base64")
    data[Math.floor(data.length / 2)] ^= 0xff
    envelope.data = data.toString("base64")
    await expect(
      readExport(Buffer.from(JSON.stringify(envelope)), EXPORT_PASSWORD),
    ).rejects.toThrow(/export password/)
  })

  it("that is not an export, or asks for too much memory", async () => {
    await expect(
      readExport(Buffer.from("hello"), EXPORT_PASSWORD),
    ).rejects.toThrow(/not a PCP export/)
    await expect(
      readExport(Buffer.from('{"format":"other"}'), EXPORT_PASSWORD),
    ).rejects.toThrow(/not a PCP export/)

    const { ctx } = await populate()
    const file = await exportVault(ctx, EXPORT_PASSWORD)
    const envelope = JSON.parse(file.toString("utf8")) as {
      kdf: ScryptParams
    }
    envelope.kdf.N = 1 << 24
    await expect(
      readExport(Buffer.from(JSON.stringify(envelope)), EXPORT_PASSWORD),
    ).rejects.toThrow(/damaged/)
  })

  it("made by a newer PCP", async () => {
    const { ctx } = await populate()
    const file = await exportVault(ctx, EXPORT_PASSWORD)
    const payload = await openRaw(file, EXPORT_PASSWORD)

    const newerEnvelope = JSON.parse(file.toString("utf8")) as {
      version: number
    }
    newerEnvelope.version = 2
    await expect(
      readExport(Buffer.from(JSON.stringify(newerEnvelope)), EXPORT_PASSWORD),
    ).rejects.toThrow(/newer/)

    const withColumn = structuredClone(payload)
    ;(withColumn.tables.secrets[0] as Record<string, unknown>).colour = "red"
    await expect(
      readExport(
        await encodeExport(withColumn, EXPORT_PASSWORD),
        EXPORT_PASSWORD,
      ),
    ).rejects.toThrow(/newer/)

    const withMigration = structuredClone(payload)
    withMigration.schema = "99991231000000_from_the_future"
    await expect(
      readExport(
        await encodeExport(withMigration, EXPORT_PASSWORD),
        EXPORT_PASSWORD,
      ),
    ).rejects.toThrow(/newer/)
  })

  it("whose rows do not hold together", async () => {
    const { ctx } = await populate()
    const file = await exportVault(ctx, EXPORT_PASSWORD)
    const payload = await openRaw(file, EXPORT_PASSWORD)

    const noPassword = structuredClone(payload)
    noPassword.tables.keyGrants = noPassword.tables.keyGrants.filter(
      (grant) => grant.kind !== "password",
    )
    await expect(
      readExport(
        await encodeExport(noPassword, EXPORT_PASSWORD),
        EXPORT_PASSWORD,
      ),
    ).rejects.toThrow(/not consistent.*password/)

    const danglingKey = structuredClone(payload)
    danglingKey.tables.apiTokens[0]!.grantId = "nowhere"
    await expect(
      readExport(
        await encodeExport(danglingKey, EXPORT_PASSWORD),
        EXPORT_PASSWORD,
      ),
    ).rejects.toThrow(/not consistent.*token's key/)

    const sessionGrant = structuredClone(payload)
    sessionGrant.tables.keyGrants[0]!.kind = "session"
    await expect(
      readExport(
        await encodeExport(sessionGrant, EXPORT_PASSWORD),
        EXPORT_PASSWORD,
      ),
    ).rejects.toThrow(/not consistent/)

    const otherVault = structuredClone(payload)
    otherVault.tables.secrets[0]!.vaultId = "someone-else"
    await expect(
      readExport(
        await encodeExport(otherVault, EXPORT_PASSWORD),
        EXPORT_PASSWORD,
      ),
    ).rejects.toThrow(/another vault/)
  })
})
