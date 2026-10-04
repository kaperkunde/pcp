import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { CATALOGUE_MAX_AGE_MS, rereadDue } from "./gateway"
import { createSecret } from "./secrets"
import { createServer, updateServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// When the gateway reads a server's tools again, and when saving a server
// says its tools may have changed.

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
})
