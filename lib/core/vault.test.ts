import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createApiToken,
  listApiTokens,
  resolveApiToken,
  revokeApiToken,
} from "./api-tokens"
import { db } from "./db"
import { PcpError } from "./errors"
import { buildInstructions, loadGatewayServers } from "./gateway"
import {
  createSecret,
  deleteSecret,
  listSecrets,
  revealSecret,
  updateSecret,
  writeManagedSecret,
} from "./secrets"
import { createServer, getServer, listServers, updateServer } from "./servers"
import { createSession, destroySession, resolveSession } from "./sessions"
import { scratchDatabase } from "./test-db"
import {
  changePassword,
  isSetUp,
  resetPasswordWithRecoveryKey,
  rotateRecoveryKey,
  setupVault,
  unlockOwnerVault,
} from "./vault"

// The core against a real (scratch) SQLite database: setup, the three ways
// in, and the rows the gateway reads. Crypto details are in crypto.test.ts.

let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
})

afterEach(async () => {
  await cleanup()
})

const PASSWORD = "correct horse battery staple"

describe("setup and sign-in", () => {
  it("creates the vault once and unlocks it with the password", async () => {
    expect(await isSetUp()).toBe(false)

    const { vaultId, recoveryKey } = await setupVault({
      name: "Ada",
      password: PASSWORD,
    })
    expect(await isSetUp()).toBe(true)
    expect(recoveryKey).toMatch(/^pcp_recovery_/)

    await expect(
      setupVault({ name: "Eve", password: PASSWORD }),
    ).rejects.toThrow(PcpError)

    expect(await unlockOwnerVault("wrong")).toBeNull()
    const ctx = await unlockOwnerVault(PASSWORD)
    expect(ctx?.vaultId).toBe(vaultId)
  })

  it("rejects a short password", async () => {
    await expect(
      setupVault({ name: "Ada", password: "short" }),
    ).rejects.toThrow(/at least/)
  })

  it("keeps a session in a cookie the database cannot use on its own", async () => {
    const { vaultId, dek } = await setupVault({
      name: "Ada",
      password: PASSWORD,
    })
    const { cookieValue } = await createSession({ vaultId, dek })

    const resolved = await resolveSession(cookieValue)
    expect(resolved?.ctx.vaultId).toBe(vaultId)
    expect(resolved?.ctx.dek.equals(dek)).toBe(true)

    // The database holds only a hash of the cookie's secret.
    const grant = await db().keyGrant.findFirstOrThrow({
      where: { kind: "session" },
    })
    expect(cookieValue).not.toContain(grant.lookupHash ?? "x")

    const [id] = cookieValue.split(".")
    expect(await resolveSession(`${id}.not-the-secret`)).toBeNull()
    expect(await resolveSession("garbage")).toBeNull()

    await destroySession(resolved!.sessionId)
    expect(await resolveSession(cookieValue)).toBeNull()
    expect(await db().keyGrant.count({ where: { kind: "session" } })).toBe(0)
  })

  it("changes the password and recovers with the recovery key", async () => {
    const { vaultId, dek, recoveryKey } = await setupVault({
      name: "Ada",
      password: PASSWORD,
    })
    const ctx = { vaultId, dek }

    await expect(
      changePassword(ctx, "wrong", "another long password"),
    ).rejects.toThrow(/current password/)
    await changePassword(ctx, PASSWORD, "another long password")
    expect(await unlockOwnerVault(PASSWORD)).toBeNull()
    expect(
      (await unlockOwnerVault("another long password"))?.dek.equals(dek),
    ).toBe(true)

    const { cookieValue } = await createSession(ctx)
    await expect(
      resetPasswordWithRecoveryKey("pcp_recovery_nope", "third long password"),
    ).rejects.toThrow(/recovery key/)
    const recovered = await resetPasswordWithRecoveryKey(
      ` ${recoveryKey} `,
      "third long password",
    )
    expect(recovered.dek.equals(dek)).toBe(true)
    expect((await unlockOwnerVault("third long password"))?.vaultId).toBe(
      vaultId,
    )
    // Recovery signs every browser out.
    expect(await resolveSession(cookieValue)).toBeNull()
  })
})

describe("recovery key rotation", () => {
  it("leaves exactly one working recovery key", async () => {
    const { vaultId, dek, recoveryKey } = await setupVault({
      name: "Ada",
      password: PASSWORD,
    })
    const fresh = await rotateRecoveryKey({ vaultId, dek })

    expect(fresh).not.toBe(recoveryKey)
    expect(
      await db().keyGrant.count({ where: { vaultId, kind: "recovery" } }),
    ).toBe(1)
    await expect(
      resetPasswordWithRecoveryKey(recoveryKey, "another long password"),
    ).rejects.toThrow(/recovery key/)
    expect(
      (
        await resetPasswordWithRecoveryKey(fresh, "another long password")
      ).dek.equals(dek),
    ).toBe(true)
  })
})

describe("secrets", () => {
  it("stores values encrypted and reads them back with the key", async () => {
    const ctx = await setupVault({ name: "Ada", password: PASSWORD })
    const { id } = await createSecret(ctx, {
      name: "GitHub token",
      value: "ghp_secret",
      description: "Personal access token",
    })

    const row = await db().secret.findUniqueOrThrow({ where: { id } })
    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain("ghp_")
    expect(await revealSecret(ctx, id)).toBe("ghp_secret")

    await expect(
      createSecret(ctx, { name: "GitHub token", value: "x" }),
    ).rejects.toThrow(/already exists/)
    await expect(
      createSecret(ctx, { name: "bad\nname", value: "x" }),
    ).rejects.toThrow()

    await updateSecret(ctx, id, { value: "ghp_rotated", name: "GitHub PAT" })
    expect(await revealSecret(ctx, id)).toBe("ghp_rotated")
    expect((await listSecrets(ctx)).map((s) => s.name)).toEqual(["GitHub PAT"])

    // A wrong key cannot read it.
    await expect(
      revealSecret({ vaultId: ctx.vaultId, dek: Buffer.alloc(32, 1) }, id),
    ).rejects.toThrow()

    await deleteSecret(ctx, id)
    expect(await listSecrets(ctx)).toEqual([])
  })
})

describe("managed OAuth secrets", () => {
  it("deleting one disconnects the server that kept its tokens there", async () => {
    const ctx = await setupVault({ name: "Ada", password: PASSWORD })
    const { id: serverId } = await createServer(ctx, {
      name: "Calendar",
      url: "https://calendar.example.com/mcp",
      authType: "oauth",
    })
    const { id: secretId } = await writeManagedSecret(ctx, {
      name: `oauth/${serverId}`,
      description: "tokens",
      value: "{}",
    })
    await db().mcpServer.update({
      where: { id: serverId },
      data: {
        oauthTokensId: secretId,
        oauthConnectedAt: new Date(),
        status: "ok",
      },
    })
    expect((await listServers(ctx))[0]?.connected).toBe(true)

    await deleteSecret(ctx, secretId)

    const [server] = await listServers(ctx)
    expect(server?.connected).toBe(false)
    expect(server?.status).toBe("unknown")
  })
})

describe("servers and tokens", () => {
  it("registers a server, scopes tokens to it and resolves bearer tokens", async () => {
    const ctx = await setupVault({ name: "Ada", password: PASSWORD })
    const secret = await createSecret(ctx, { name: "api key", value: "k" })

    const { id: serverId } = await createServer(ctx, {
      name: "My GitHub",
      url: "https://mcp.example.com/mcp",
      description: "Code hosting.",
      authType: "header",
      authSecretId: secret.id,
    })
    const server = await getServer(ctx, serverId)
    expect(server.slug).toBe("my-github")
    expect(server.authHeaderName).toBe("Authorization")
    expect(server.authValueTemplate).toBe("Bearer {{secret}}")

    // The secret is in use, so it cannot be deleted from under the server.
    await expect(deleteSecret(ctx, secret.id)).rejects.toThrow(
      /used by My GitHub/,
    )

    const second = await createServer(ctx, {
      name: "My GitHub",
      url: "https://other.example.com/mcp",
      authType: "none",
    })
    expect((await getServer(ctx, second.id)).slug).toBe("my-github-2")
    expect((await listServers(ctx)).map((s) => s.slug)).toEqual([
      "my-github",
      "my-github-2",
    ])

    await expect(
      updateServer(ctx, serverId, {
        name: "x",
        url: "ftp://nope",
        authType: "none",
      }),
    ).rejects.toThrow(/address/)

    const all = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })
    const scoped = await createApiToken(ctx, {
      name: "Only GitHub",
      allowAllServers: false,
      serverIds: [serverId],
    })
    expect(all.token).toMatch(/^pcp_/)

    const resolvedAll = await resolveApiToken(all.token)
    expect(resolvedAll?.ctx.vaultId).toBe(ctx.vaultId)
    expect(resolvedAll?.ctx.dek.equals(ctx.dek)).toBe(true)
    expect(resolvedAll?.serverIds).toBeNull()

    const resolvedScoped = await resolveApiToken(scoped.token)
    expect(resolvedScoped?.serverIds).toEqual([serverId])
    expect(await resolveApiToken("pcp_nope")).toBeNull()
    expect(await resolveApiToken(all.token.slice(0, -1))).toBeNull()

    const visible = await loadGatewayServers({
      ...resolvedScoped!,
      publicUrl: "http://localhost:3000",
    })
    expect(visible.map((s) => s.slug)).toEqual(["my-github"])
    expect(buildInstructions(visible)).toContain(
      "my-github: Code hosting. (0 tools)",
    )

    await revokeApiToken(ctx, all.id)
    expect(await resolveApiToken(all.token)).toBeNull()
    expect(
      (await listApiTokens(ctx)).find((t) => t.id === all.id)?.revokedAt,
    ).not.toBeNull()
    // The scoped token is unaffected.
    expect(await resolveApiToken(scoped.token)).not.toBeNull()
  })
})
