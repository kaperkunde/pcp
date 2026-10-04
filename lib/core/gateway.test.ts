import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { NEW_SECRET } from "./constants"
import { CATALOGUE_MAX_AGE_MS, gatewayIcons, rereadDue } from "./gateway"
import { createSecret, listSecrets, revealSecret } from "./secrets"
import { createServer, updateServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// The icon the gateway names, when it reads a server's tools again, and when
// saving a server says its tools may have changed or saves a secret typed in
// with it.

const NOW = Date.parse("2026-10-01T12:00:00Z")
const HOUR = 60 * 60_000

function server(
  overrides: Partial<Parameters<typeof rereadDue>[0]> = {},
): Parameters<typeof rereadDue>[0] {
  return {
    kind: "mcp",
    specSource: null,
    status: "ok",
    lastSyncedAt: new Date(NOW - 7 * HOUR),
    ...overrides,
  }
}

describe("gatewayIcons", () => {
  it("points at PCP's own icons on its public address", () => {
    expect(gatewayIcons("https://pcp.example.com/")).toEqual([
      {
        src: "https://pcp.example.com/icons/icon-192.png",
        mimeType: "image/png",
        sizes: ["192x192"],
      },
      {
        src: "https://pcp.example.com/icons/icon-512.png",
        mimeType: "image/png",
        sizes: ["512x512"],
      },
    ])
  })
})

describe("rereadDue", () => {
  it("reads a list older than the limit, and not a fresh one", () => {
    expect(rereadDue(server(), NOW, CATALOGUE_MAX_AGE_MS)).toBe(true)
    expect(
      rereadDue(
        server({ lastSyncedAt: new Date(NOW - HOUR) }),
        NOW,
        CATALOGUE_MAX_AGE_MS,
      ),
    ).toBe(false)
  })

  it("counts a recent attempt, so a failing server is not retried each request", () => {
    const failing = server({ status: "error", lastSyncedAt: null })

    expect(rereadDue(failing, NOW, CATALOGUE_MAX_AGE_MS)).toBe(true)
    expect(rereadDue(failing, NOW, CATALOGUE_MAX_AGE_MS, NOW - HOUR)).toBe(
      false,
    )
    expect(rereadDue(failing, NOW, 60_000, NOW - 2 * 60_000)).toBe(true)
  })

  it("leaves a server waiting for sign-in and an uploaded schema alone", () => {
    expect(
      rereadDue(server({ status: "auth_required" }), NOW, CATALOGUE_MAX_AGE_MS),
    ).toBe(false)
    expect(
      rereadDue(
        server({ kind: "openapi", specSource: "upload" }),
        NOW,
        CATALOGUE_MAX_AGE_MS,
      ),
    ).toBe(false)
    expect(
      rereadDue(
        server({ kind: "openapi", specSource: "url" }),
        NOW,
        CATALOGUE_MAX_AGE_MS,
      ),
    ).toBe(true)
  })
})

describe("updateServer", () => {
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ cleanup } = await scratchDatabase())
  })

  afterEach(async () => {
    await cleanup()
  })

  it("says when the address or credentials changed", async () => {
    const { vaultId, dek } = await setupVault({
      name: "Owner",
      password: "correct horse battery staple",
    })
    const ctx = { vaultId, dek }
    const input = {
      name: "Tools",
      url: "https://tools.example.com/mcp",
      authType: "none" as const,
    }
    const { id } = await createServer(ctx, input)

    expect(
      await updateServer(ctx, id, { ...input, description: "Renamed" }),
    ).toEqual({ reconnect: false })
    expect(
      await updateServer(ctx, id, {
        ...input,
        url: "https://elsewhere.example.com/mcp",
      }),
    ).toEqual({ reconnect: true })
    expect(
      await updateServer(ctx, id, {
        ...input,
        url: "https://elsewhere.example.com/mcp",
        authType: "oauth",
      }),
    ).toEqual({ reconnect: true })
  })

  it("says so when a further secret header changes, and only then", async () => {
    const { vaultId, dek } = await setupVault({
      name: "Owner",
      password: "correct horse battery staple",
    })
    const ctx = { vaultId, dek }
    const key = await createSecret(ctx, { name: "key", value: "k" })
    const secretKey = await createSecret(ctx, {
      name: "secret key",
      value: "s",
    })
    const input = {
      name: "Tools",
      url: "https://tools.example.com/mcp",
      authType: "header" as const,
      authSecretId: key.id,
      authHeaderName: "X-API-Key",
      authValueTemplate: "{{secret}}",
      authExtraHeaders: [
        { secretId: secretKey.id, headerName: "X-Secret-API-Key" },
      ],
    }
    const { id } = await createServer(ctx, input)

    expect(
      await updateServer(ctx, id, { ...input, description: "Renamed" }),
    ).toEqual({ reconnect: false })
    expect(
      await updateServer(ctx, id, {
        ...input,
        authExtraHeaders: [
          { secretId: key.id, headerName: "X-Secret-API-Key" },
        ],
      }),
    ).toEqual({ reconnect: true })
    expect(
      await updateServer(ctx, id, { ...input, authExtraHeaders: [] }),
    ).toEqual({ reconnect: true })
  })

  it("saves a secret typed into the form, and only with the server", async () => {
    const ctx = await setupVault({
      name: "Owner",
      password: "correct horse battery staple",
    })
    const typed = {
      name: "Tools",
      url: "https://tools.example.com/mcp",
      authType: "header" as const,
      authSecretId: NEW_SECRET,
      authSecretValue: "tok-123",
    }

    // A bad address is found before the secret is saved.
    await expect(
      createServer(ctx, { ...typed, url: "ftp://tools.example.com" }),
    ).rejects.toThrow(/https/)
    expect(await listSecrets(ctx)).toEqual([])

    const { id } = await createServer(ctx, typed)
    const [secret] = await listSecrets(ctx)
    expect(secret).toMatchObject({
      name: "Tools key",
      usedBy: [{ id, name: "Tools" }],
    })
    expect(await revealSecret(ctx, secret!.id)).toBe("tok-123")

    // Switching to another new one on an edit, under a name of the owner's.
    expect(
      await updateServer(ctx, id, {
        ...typed,
        authSecretName: "Tools rotated",
        authSecretValue: "tok-456",
      }),
    ).toEqual({ reconnect: true })
    const rotated = (await listSecrets(ctx)).find(
      (each) => each.name === "Tools rotated",
    )
    expect(rotated?.usedBy).toEqual([{ id, name: "Tools" }])
    expect(await revealSecret(ctx, rotated!.id)).toBe("tok-456")
  })
})
