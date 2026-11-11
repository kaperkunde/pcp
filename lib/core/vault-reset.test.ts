import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import { grantSecretUse } from "./browser-secrets"
import { storeTools } from "./catalogue"
import { db } from "./db"
import { createDeviceKey, unlockWithDeviceKey } from "./device-keys"
import { receiveFile } from "./file-links"
import { getHostJson, setHostJson } from "./host-settings"
import { createMemory } from "./memories"
import { DDNS_CONFIG_KEY } from "./network/ddns"
import { appendRequestLog, logDays } from "./request-log"
import { createSecret } from "./secrets"
import { createSshExit, writeExitAccess } from "./exits/exits"
import { createSshServer } from "./ssh/hosts"
import { createServer } from "./servers"
import { createSkill, setTokenSkills } from "./skills"
import { createSession, resolveSession } from "./sessions"
import { SETTING_PUBLIC_URL, setSetting } from "./settings"
import { serverCreateData } from "./server-meta"
import { scratchDatabase } from "./test-db"
import { keepResult } from "./tool-results"
import { createUploadLink } from "./upload-links"
import { setExcluded } from "./repos/store"
import { addLinkedRepo } from "./repos/test-vault"
import { setToolTier } from "./tool-tiers"
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
  // A service on an SSH server: rows only, nothing connects here.
  await db().mcpServer.create({
    data: serverCreateData(ctx, {
      id: "svc1",
      vaultId,
      kind: "service",
      name: "Docs service",
      slug: "docs-service",
      url: "pcp:service",
      serviceSpec: {
        create: {
          plainDefinition: "{}",
          hash: "0",
          engine: "docker",
          containerName: "pcp-docs",
          env: JSON.stringify({ API_KEY: secret.id }),
          registeredId: server.id,
        },
      },
    }),
  })
  // A storage root on an SSH server: rows only, nothing connects here.
  await db().mcpServer.create({
    data: serverCreateData(ctx, {
      id: "files1",
      vaultId,
      kind: "storage",
      name: "Scans",
      slug: "scans",
      url: "pcp:storage",
      storageRoot: { create: { path: "/srv/scans", mode: "encrypted" } },
      storageEntries: {
        create: { id: "entry1", nameKey: "k", meta: new Uint8Array([1]) },
      },
      storagePending: { create: { objectId: "0".repeat(32) } },
    }),
  })
  await storeTools(ctx, server.id, [
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
  await receiveFile(ctx, { tokenId, publicUrl: "https://pcp.example" })
  await createUploadLink(ctx, {
    tokenId,
    publicUrl: "https://pcp.example",
    purpose: "Receipts",
    maxFiles: 2,
  })
  await grantSecretUse(ctx, {
    tokenId,
    secretId: secret.id,
    origin: "https://shop.example",
    level: "always",
  })
  await createMemory(ctx, { path: "notes.md", text: "Remember this." })
  const skill = await createSkill(ctx, {
    name: "release-notes",
    description: "Write release notes.",
    body: "List the changes.",
    tools: [],
  })
  await setTokenSkills(ctx, tokenId, { all: false, skillIds: [skill.id] })
  const { repoId } = await addLinkedRepo(ctx, {
    skillId: skill.id,
    secretId: secret.id,
  })
  const kept = await createSkill(ctx, {
    name: "kept-out",
    description: "Not for the repository.",
    body: "Mine.",
    tools: [],
  })
  await setExcluded(ctx, repoId, { kind: "skill", id: kept.id }, true)
  const { id: sshId } = await createSshServer(ctx, {
    name: "VPS",
    host: "vps.example",
    username: "deploy",
  })
  const { id: exitId } = await createSshExit(ctx, {
    serverId: sshId,
    name: "us-vps",
  })
  await writeExitAccess(vaultId, tokenId, exitId, "allowed")
  // The owner's tier for a tool, kept apart from its row.
  await setToolTier(ctx, server.id, "alpha", "read")
  await setSetting(ctx, SETTING_PUBLIC_URL, "https://pcp.example")
  // A call the duplicate guard remembers.
  await db().callRecord.create({
    data: {
      vaultId,
      tokenId,
      id: "call1",
      serverId: server.id,
      toolName: "alpha",
      argsHash: "h",
      tier: "write",
      status: "succeeded",
    },
  })
  // A search vector cached for the owner's embeddings provider.
  await db().embeddingVector.create({
    data: {
      id: "vec1",
      vaultId,
      hash: "h",
      dimensions: 1,
      ciphertext: new Uint8Array([1]),
    },
  })
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
    const before = await vaultRows()
    expect(Object.values(before).some((count) => count > 0)).toBe(true)
    expect(before.repo).toBe(1)
    expect(before.repo_item).toBe(1)
    expect(before.secret_browser_origin).toBe(1)
    expect(before.api_token_secret_allowance).toBe(1)
    expect(before.call_record).toBe(1)
    expect(before.server_definition).toBe(1)
    expect(before.service_spec).toBe(1)
    expect(before.storage_root).toBe(1)
    expect(before.storage_entry).toBe(1)
    expect(before.storage_pending).toBe(1)
    expect(before.exit).toBe(1)
    expect(before.upload_link).toBe(1)
    expect(before.tool_tier).toBe(1)
    expect(before.embedding_vector).toBe(1)

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
