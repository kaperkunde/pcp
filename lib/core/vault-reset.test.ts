import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import { storeTools } from "./catalogue"
import { db } from "./db"
import { createDeviceKey, unlockWithDeviceKey } from "./device-keys"
import { getHostJson, setHostJson } from "./host-settings"
import { createMemory } from "./memories"
import { DDNS_CONFIG_KEY } from "./network/ddns"
import { appendRequestLog, logDays } from "./request-log"
import { createSecret } from "./secrets"
import { createServer } from "./servers"
import { createSession, resolveSession } from "./sessions"
import { SETTING_PUBLIC_URL, setSetting } from "./settings"
import { scratchDatabase } from "./test-db"
import { keepResult } from "./tool-results"
import { isSetUp, ownerVault, setupVault, unlockOwnerVault } from "./vault"
import { deleteVault } from "./vault-reset"

// Deleting the vault against a scratch database: every row of it goes, the
// request log with it, the machine's settings stay, and PCP is back to
// setup.

let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
})

afterEach(async () => {
  await cleanup()
})

const PASSWORD = "correct horse battery staple"

// Tables that belong to the machine rather than to a vault.
const KEPT_TABLES = new Set([
  "_prisma_migrations",
  "host_setting",
  "oauth_client",
])

/** Every table's row count, but the ones a deleted vault leaves. */
async function vaultRows(): Promise<Record<string, number>> {
  const tables = await db().$queryRawUnsafe<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  )
  const counts: Record<string, number> = {}

  for (const { name } of tables) {
    if (KEPT_TABLES.has(name)) {
      continue
    }

    const [row] = await db().$queryRawUnsafe<{ count: bigint | number }[]>(
      `SELECT COUNT(*) AS count FROM "${name}"`,
    )
    counts[name] = Number(row?.count ?? 0)
  }

  return counts
}

async function populate() {
  const { vaultId, dek } = await setupVault({ name: "Ada", password: PASSWORD })
  const ctx = { vaultId, dek }
  const secret = await createSecret(ctx, { name: "api-key", value: "s3cret" })
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
  ])
  const { id: tokenId, token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  })
  await keepResult(ctx, {
    tokenId,
    serverId: server.id,
    toolName: "alpha",
    text: "a long answer",
    mediaType: "text/plain",
  })
  await createMemory(ctx, { path: "notes.md", text: "Remember this." })
  await setSetting(ctx, SETTING_PUBLIC_URL, "https://pcp.example")
  await setHostJson(DDNS_CONFIG_KEY, { provider: "duckdns", subdomain: "ada" })
  const { cookieValue } = await createSession(ctx)
  const deviceKey = await createDeviceKey(ctx)
  await appendRequestLog({
    vaultId,
    tokenId,
    tool: "call_tool",
    ok: true,
    ms: 1,
  })

  return { ctx, token, cookieValue, deviceKey }
}

describe("deleteVault", { timeout: 30_000 }, () => {
  it("deletes every row of the vault and the request log, and keeps the machine's settings", async () => {
    const { ctx, token, cookieValue, deviceKey } = await populate()
    expect(await isSetUp()).toBe(true)
    expect(await logDays()).not.toHaveLength(0)
    expect(Object.values(await vaultRows()).some((count) => count > 0)).toBe(
      true,
    )

    await deleteVault(ctx)

    const left = Object.entries(await vaultRows()).filter(
      ([, count]) => count > 0,
    )
    expect(left).toEqual([])
    expect(await logDays()).toEqual([])
    expect(await getHostJson(DDNS_CONFIG_KEY)).toEqual({
      provider: "duckdns",
      subdomain: "ada",
    })

    // Nothing of it opens anything any more.
    expect(await resolveApiToken(token)).toBeNull()
    expect(await resolveSession(cookieValue)).toBeNull()
    expect(await unlockWithDeviceKey(deviceKey)).toBeNull()
    expect(await unlockOwnerVault(PASSWORD)).toBeNull()
  })

  it("leaves PCP to be set up again, as a new vault", async () => {
    const { ctx } = await populate()

    await deleteVault(ctx)

    expect(await isSetUp()).toBe(false)
    expect(await ownerVault()).toBeNull()

    const next = await setupVault({ name: "Grace", password: "another pass" })
    expect(next.vaultId).not.toBe(ctx.vaultId)
    expect(await isSetUp()).toBe(true)
    expect((await ownerVault())?.name).toBe("Grace")
  })

  it("refuses a vault that is already gone", async () => {
    const { ctx } = await populate()

    await deleteVault(ctx)

    await expect(deleteVault(ctx)).rejects.toThrow("already deleted")
  })
})
