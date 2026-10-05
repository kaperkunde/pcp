import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "./context"
import { db } from "./db"
import { createSecret, listSecrets } from "./secrets"
import {
  asServerKind,
  createServer,
  isBrowserKind,
  isMailKind,
  kindNoun,
  normalizeBasicAuth,
  normalizeOAuthClient,
  oauthTokensObsolete,
  updateServer,
} from "./servers"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// The registry's pieces that mail accounts share with MCP servers: kinds,
// a login (user name and secret), and the OAuth settings.

describe("kinds", () => {
  it("tells a mail account from the other kinds", () => {
    expect(isMailKind("jmap")).toBe(true)
    expect(isMailKind("imap")).toBe(true)
    expect(isMailKind("mcp")).toBe(false)
    expect(isMailKind("openapi")).toBe(false)
  })

  it("tells the browser from everything PCP reaches at an address", () => {
    expect(isBrowserKind("browser")).toBe(true)
    expect(isBrowserKind("mcp")).toBe(false)
    expect(isMailKind("browser")).toBe(false)
    expect(asServerKind("browser")).toBe("browser")
    expect(kindNoun("browser")).toBe("the browser")
  })

  it("reads an unknown kind as an MCP server", () => {
    expect(asServerKind("imap")).toBe("imap")
    expect(asServerKind("openapi")).toBe("openapi")
    expect(asServerKind("smtp")).toBe("mcp")
  })
})

describe("oauthTokensObsolete", () => {
  const existing = {
    oauthTokensId: "s1",
    url: "https://mail.example.com/jmap/session",
    oauthClientId: null,
  }

  it("keeps tokens while OAuth, the address and the client stay", () => {
    expect(
      oauthTokensObsolete(existing, {
        authType: "oauth",
        url: existing.url,
        oauthClientId: null,
      }),
    ).toBe(false)
  })

  it("drops them when any of those changes", () => {
    expect(
      oauthTokensObsolete(existing, {
        authType: "basic",
        url: existing.url,
        oauthClientId: null,
      }),
    ).toBe(true)
    expect(
      oauthTokensObsolete(existing, {
        authType: "oauth",
        url: "https://other.example.com/jmap/session",
        oauthClientId: null,
      }),
    ).toBe(true)
    expect(
      oauthTokensObsolete(existing, {
        authType: "oauth",
        url: existing.url,
        oauthClientId: "pcp",
      }),
    ).toBe(true)
  })

  it("has nothing to drop without tokens", () => {
    expect(
      oauthTokensObsolete(
        { ...existing, oauthTokensId: null },
        { authType: "none", url: existing.url, oauthClientId: null },
      ),
    ).toBe(false)
  })
})

describe("with a vault", () => {
  let cleanup: () => Promise<void>
  let ctx: VaultContext

  beforeEach(async () => {
    ;({ cleanup } = await scratchDatabase())
    ctx = await setupVault({
      name: "Ada",
      password: "correct horse battery staple",
    })
  })

  afterEach(async () => {
    await cleanup()
  })

  describe("normalizeBasicAuth", () => {
    it("takes a user name and one of the owner's secrets", async () => {
      const { id } = await createSecret(ctx, {
        name: "Mail password",
        value: "app-password",
      })

      expect(
        await normalizeBasicAuth(ctx, {
          authUsername: "  ada@example.com ",
          authSecretId: id,
        }),
      ).toEqual({ authUsername: "ada@example.com", authSecretId: id })
    })

    it("refuses what would change what is sent", async () => {
      const { id } = await createSecret(ctx, {
        name: "Mail password",
        value: "app-password",
      })

      await expect(
        normalizeBasicAuth(ctx, { authUsername: "", authSecretId: id }),
      ).rejects.toThrow(/user name/)
      await expect(
        normalizeBasicAuth(ctx, { authUsername: "ada:x", authSecretId: id }),
      ).rejects.toThrow(/colon/)
      await expect(
        normalizeBasicAuth(ctx, {
          authUsername: "ada\r\nA1 LOGOUT",
          authSecretId: id,
        }),
      ).rejects.toThrow(/line breaks/)
      await expect(
        normalizeBasicAuth(ctx, { authUsername: "ada", authSecretId: null }),
      ).rejects.toThrow(/secret/)
      await expect(
        normalizeBasicAuth(ctx, { authUsername: "ada", authSecretId: "nope" }),
      ).rejects.toThrow(/does not exist/)
    })
  })

  describe("normalizeOAuthClient", () => {
    it("holds a typed client secret back, to be saved with the row", async () => {
      const data = await normalizeOAuthClient(
        ctx,
        {
          oauthClientId: " pcp ",
          oauthClientSecretValue: "client-secret",
          oauthScope: " openid offline_access ",
        },
        { name: "Mail" },
      )

      expect(data).toMatchObject({
        oauthClientId: "pcp",
        oauthClientSecretId: null,
        oauthScope: "openid offline_access",
        oauthAuthorizeParams: null,
        newSecret: {
          base: "Mail OAuth client secret",
          value: "client-secret",
        },
      })
      expect(await listSecrets(ctx)).toEqual([])
    })

    it("refuses a client secret without a client ID", async () => {
      await expect(
        normalizeOAuthClient(
          ctx,
          { oauthClientSecretValue: "x" },
          { name: "Mail" },
        ),
      ).rejects.toThrow(/client ID/)
    })
  })

  it("updateServer still drops tokens that belong to an old configuration", async () => {
    const input = {
      name: "Tools",
      url: "https://tools.example.com/mcp",
      authType: "oauth" as const,
    }
    const { id } = await createServer(ctx, input)
    const tokens = await db().secret.create({
      data: {
        id: "managed",
        vaultId: ctx.vaultId,
        name: `oauth/${id}`,
        kind: "oauth",
        ciphertext: Buffer.from("x"),
      },
    })
    await db().mcpServer.update({
      where: { id },
      data: { oauthTokensId: tokens.id, oauthConnectedAt: new Date() },
    })

    await updateServer(ctx, id, { ...input, description: "Same sign-in" })
    expect(
      (await db().mcpServer.findUniqueOrThrow({ where: { id } })).oauthTokensId,
    ).toBe(tokens.id)

    await updateServer(ctx, id, { ...input, authType: "none" })
    const row = await db().mcpServer.findUniqueOrThrow({ where: { id } })
    expect(row.oauthTokensId).toBeNull()
    expect(row.oauthConnectedAt).toBeNull()
    expect(
      await db().secret.findUnique({ where: { id: "managed" } }),
    ).toBeNull()
  })

  it("updateServer refuses a mail account", async () => {
    const { id } = await createServer(ctx, {
      name: "Mail",
      url: "https://mail.example.com/jmap/session",
      authType: "none",
    })
    await db().mcpServer.update({ where: { id }, data: { kind: "jmap" } })

    await expect(
      updateServer(ctx, id, {
        name: "Mail",
        url: "https://mail.example.com/jmap/session",
        authType: "none",
      }),
    ).rejects.toThrow(/This is a mail account/)
  })
})
