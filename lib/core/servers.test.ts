import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "./context"
import { db } from "./db"
import { NEW_SECRET } from "./constants"
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
  validateUsername,
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
    const sender = { name: "Mail" }

    it("takes a user name and one of the owner's secrets", async () => {
      const { id } = await createSecret(ctx, {
        name: "Mail password",
        value: "app-password",
      })

      expect(
        await normalizeBasicAuth(
          ctx,
          { authUsername: "  ada@example.com ", authSecretId: id },
          sender,
        ),
      ).toEqual({
        authUsername: "ada@example.com",
        authSecretId: id,
        newSecret: null,
      })
    })

    it("holds a typed password back, to be saved with the row", async () => {
      const data = await normalizeBasicAuth(
        ctx,
        {
          authUsername: "ada@example.com",
          authSecretId: NEW_SECRET,
          authSecretName: " Ada mail ",
          authSecretValue: "app-password",
        },
        sender,
      )

      expect(data).toEqual({
        authUsername: "ada@example.com",
        authSecretId: null,
        newSecret: {
          name: "Ada mail",
          base: "Mail password",
          value: "app-password",
          description: "The password for ada@example.com at Mail.",
        },
      })
      // Nothing is saved until the row is.
      expect(await listSecrets(ctx)).toHaveLength(0)
    })

    it("refuses a typed password with no value, or a name in use", async () => {
      await createSecret(ctx, { name: "Taken", value: "x" })

      await expect(
        normalizeBasicAuth(
          ctx,
          {
            authUsername: "ada",
            authSecretId: NEW_SECRET,
            authSecretValue: "",
          },
          sender,
        ),
      ).rejects.toThrow(/value/i)
      await expect(
        normalizeBasicAuth(
          ctx,
          {
            authUsername: "ada",
            authSecretId: NEW_SECRET,
            authSecretName: "Taken",
            authSecretValue: "app-password",
          },
          sender,
        ),
      ).rejects.toThrow(/Taken/)
    })

    it("refuses what would change what is sent", async () => {
      const { id } = await createSecret(ctx, {
        name: "Mail password",
        value: "app-password",
      })
      const basic = (authUsername: string, authSecretId: string | null) =>
        normalizeBasicAuth(ctx, { authUsername, authSecretId }, sender)

      await expect(basic("", id)).rejects.toThrow(/user name/)
      await expect(basic("ada:x", id)).rejects.toThrow(/colon/)
      await expect(basic("ada\r\nA1 LOGOUT", id)).rejects.toThrow(/line breaks/)
      await expect(basic("ada", null)).rejects.toThrow(/secret/)
      await expect(basic("ada", "nope")).rejects.toThrow(/does not exist/)
    })
  })

  describe("validateUsername", () => {
    it("trims a mailbox address", () => {
      expect(validateUsername(" ada@example.com ")).toBe("ada@example.com")
    })

    it("refuses an empty one, a colon, control characters and a long one", () => {
      expect(() => validateUsername("")).toThrow(/user name/)
      expect(() => validateUsername(null)).toThrow(/user name/)
      expect(() => validateUsername("a:b")).toThrow(/colon/)
      expect(() => validateUsername("a\nb")).toThrow(/line breaks/)
      expect(() => validateUsername("a".repeat(321))).toThrow(/too long/)
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
