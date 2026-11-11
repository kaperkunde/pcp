import { readFileSync } from "node:fs"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { stopCleanup, cleanupIdle } from "../cleanup/runtime"
import type { VaultContext } from "../context"
import { databaseFile } from "../data-dir"
import { keyedHash } from "../crypto"
import { db } from "../db"
import { allowSiteFor, loadSiteAllowances } from "../allowances"
import { createApiToken, listApiTokens, resolveApiToken } from "../api-tokens"
import { exportVault, readExport, restoreExport } from "../backup"
import { previewOf } from "../backup-format"
import {
  bindOrigin,
  grantSecretUse,
  isBoundOrigin,
  listSecretAllowances,
  sitesOf,
  takeSecretUse,
} from "../browser-secrets"
import {
  createSecret,
  findOwnerSecretByName,
  listSecrets,
  updateSecret,
} from "../secrets"
import {
  getSetting,
  getVaultSetting,
  setSetting,
  SETTING_PUBLIC_URL,
} from "../settings"
import { scratchDatabase } from "../test-db"
import { downloadByLink, shareResult } from "../file-links"
import { describeResults, keepResult, openResult } from "../tool-results"
import { createUploadLink, uploadPageView } from "../upload-links"
import { setupVault } from "../vault"
import { deleteVault } from "../vault-reset"
import { sealedTokenName } from "../token-names"
import {
  addFetchSite,
  decideSite,
  listFetchRules,
  loadFetchRules,
  setFetchRuleShared,
} from "../web-fetch"
import {
  type Converter,
  ensureSealed,
  forgetSealedVaults,
  SEAL_CONVERTERS,
} from "./convert"
import { knownSealed } from "./state"

// The owner's descriptive values are sealed at rest (#96): what each table
// stores, that every reader takes the old plain form too, and that a vault
// from before is sealed by the requests that follow.

let cleanup: () => Promise<void>
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  forgetSealedVaults()
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
})

afterEach(async () => {
  await stopCleanup()
  await cleanupIdle()
  forgetSealedVaults()
  await cleanup()
})

/** Whether the text is anywhere in the database's files. */
async function onDisk(text: string): Promise<boolean> {
  await db().$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)")
  return readFileSync(databaseFile()).includes(Buffer.from(text, "utf8"))
}

describe("keyedHash", () => {
  it("depends on the key, the label and the text", () => {
    const other = Buffer.alloc(32, 7)
    const hash = keyedHash(ctx.dek, "a", "x")

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(keyedHash(ctx.dek, "a", "x")).toBe(hash)
    expect(keyedHash(ctx.dek, "b", "x")).not.toBe(hash)
    expect(keyedHash(ctx.dek, "a", "y")).not.toBe(hash)
    expect(keyedHash(other, "a", "x")).not.toBe(hash)
  })
})

describe("settings", () => {
  it("seals a vault's setting and keeps the public address plain", async () => {
    await setSetting(ctx, "pacing", '{"marker":"SETTING-MARKER-1"}')
    await setSetting(ctx, SETTING_PUBLIC_URL, "https://pcp.example")

    expect(await getSetting(ctx, "pacing")).toBe(
      '{"marker":"SETTING-MARKER-1"}',
    )
    expect(await onDisk("SETTING-MARKER-1")).toBe(false)
    expect(await getVaultSetting(ctx.vaultId, SETTING_PUBLIC_URL)).toBe(
      "https://pcp.example",
    )
    await expect(getVaultSetting(ctx.vaultId, "pacing")).rejects.toThrow()
  })

  it("reads one from before as it was, and seals it on a request", async () => {
    await db().setting.create({
      data: { vaultId: ctx.vaultId, key: "toolTiers", value: '{"a":"read"}' },
    })

    expect(await getSetting(ctx, "toolTiers")).toBe('{"a":"read"}')
    expect(await ensureSealed(ctx)).toBe(true)

    const row = await db().setting.findFirstOrThrow({
      where: { key: "toolTiers" },
    })
    expect(row.value).toMatch(/^pcp-sealed:v1:/)
    expect(await getSetting(ctx, "toolTiers")).toBe('{"a":"read"}')
  })
})

describe("secrets", () => {
  it("seals the name and description, and finds the secret by name", async () => {
    const { id } = await createSecret(ctx, {
      name: "SECRET-NAME-MARKER",
      description: "SECRET-DESCRIPTION-MARKER",
      value: "v",
    })

    expect(await onDisk("SECRET-NAME-MARKER")).toBe(false)
    expect(await onDisk("SECRET-DESCRIPTION-MARKER")).toBe(false)
    expect(
      await findOwnerSecretByName(ctx, "SECRET-NAME-MARKER"),
    ).toMatchObject({ id, name: "SECRET-NAME-MARKER" })
    expect(await listSecrets(ctx)).toMatchObject([
      {
        id,
        name: "SECRET-NAME-MARKER",
        description: "SECRET-DESCRIPTION-MARKER",
      },
    ])

    const raw = await db().$queryRawUnsafe<
      Array<{ name: string; description: string; name_key: string }>
    >(`SELECT "name", "description", "name_key" FROM "secret"`)
    expect(raw).toEqual([
      {
        name: "",
        description: "",
        name_key: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ])
  })

  it("still refuses a second secret by the same name", async () => {
    await createSecret(ctx, { name: "Mail", value: "a" })
    const { id } = await createSecret(ctx, { name: "Shop", value: "b" })

    await expect(
      createSecret(ctx, { name: "Mail", value: "c" }),
    ).rejects.toThrow(/already exists/)
    await expect(updateSecret(ctx, id, { name: "Mail" })).rejects.toThrow(
      /already exists/,
    )
    // The database refuses one too, should a writer skip the check.
    await expect(
      db().secret.update({
        where: { id },
        data: {
          nameKey: (
            await db().secret.findFirstOrThrow({ where: { id: { not: id } } })
          ).nameKey,
        },
      }),
    ).rejects.toThrow()
  })

  it("reads a secret from before, finds it by name, and seals it", async () => {
    const { id } = await createSecret(ctx, { name: "x", value: "v" })
    await db().$executeRawUnsafe(
      `UPDATE "secret" SET "name" = 'Old mail', "description" = 'From before', "meta" = NULL, "name_key" = NULL WHERE "id" = ?`,
      id,
    )

    expect(await findOwnerSecretByName(ctx, "Old mail")).toMatchObject({ id })
    await expect(
      createSecret(ctx, { name: "Old mail", value: "c" }),
    ).rejects.toThrow(/already exists/)

    expect(await ensureSealed(ctx)).toBe(true)

    expect(await onDisk("From before")).toBe(false)
    expect(await findOwnerSecretByName(ctx, "Old mail")).toMatchObject({ id })
    expect(await listSecrets(ctx)).toMatchObject([
      { id, name: "Old mail", description: "From before" },
    ])
  })
})

describe("sites", () => {
  async function token(): Promise<string> {
    return (
      await createApiToken(ctx, {
        name: "Claude",
        allowAllServers: true,
        serverIds: [],
      })
    ).id
  }

  it("keeps a secret's sites as hashes and finds them by origin", async () => {
    const { id } = await createSecret(ctx, { name: "Shop", value: "v" })
    await bindOrigin(ctx, id, "https://shop-marker.example", {
      subdomains: true,
    })

    expect(await onDisk("shop-marker")).toBe(false)
    expect(await sitesOf(ctx, id)).toEqual([
      { origin: "https://shop-marker.example", subdomains: true },
    ])
    expect(
      await isBoundOrigin(ctx, id, "https://www.shop-marker.example"),
    ).toBe(true)
    expect(await isBoundOrigin(ctx, id, "https://other.example")).toBe(false)
  })

  it("keeps web fetch's sites and allowances as hashes", async () => {
    const tokenId = await token()
    await decideSite({ ctx, tokenId }, "fetched-marker.example", "GET")
    await addFetchSite(ctx, tokenId, {
      site: "added-marker.example",
      level: "allowed",
      shared: false,
    })
    await setFetchRuleShared(ctx, tokenId, "site", "added-marker.example", true)
    await allowSiteFor(ctx, tokenId, "allowed-marker.example", 15)

    expect(await onDisk("fetched-marker")).toBe(false)
    expect(await onDisk("added-marker")).toBe(false)
    expect(await onDisk("allowed-marker")).toBe(false)

    const rules = await loadFetchRules(ctx, tokenId)
    expect([...rules.ownSites.keys()]).toEqual(["fetched-marker.example"])
    expect(rules.sharedSites.get("added-marker.example")).toBe("allowed")
    expect([...rules.allowedSites.keys()]).toEqual(["allowed-marker.example"])
    expect(
      (await listFetchRules(ctx, tokenId)).sites
        .map((site) => site.host)
        .sort(),
    ).toEqual(["added-marker.example", "fetched-marker.example"])
  })

  it("keeps a token's allowance for a secret at a site as a hash", async () => {
    const tokenId = await token()
    const { id: secretId } = await createSecret(ctx, { name: "S", value: "v" })
    await grantSecretUse(ctx, {
      tokenId,
      secretId,
      origin: "https://allowance-marker.example",
      level: "hour",
    })

    expect(await onDisk("allowance-marker")).toBe(false)
    expect(await listSecretAllowances(ctx)).toMatchObject([
      { tokenId, secretId, origin: "https://allowance-marker.example" },
    ])
    expect(
      await takeSecretUse(ctx, {
        tokenId,
        secretId,
        origin: "https://allowance-marker.example",
      }),
    ).toBe(true)
    expect(
      await takeSecretUse(ctx, {
        tokenId,
        secretId,
        origin: "https://other.example",
      }),
    ).toBe(false)
  })

  it("reads a secret's allowance from before, and seals it on a request", async () => {
    const tokenId = await token()
    const { id: secretId } = await createSecret(ctx, { name: "S", value: "v" })
    await db().apiTokenSecretAllowance.create({
      data: {
        tokenId,
        secretId,
        origin: "https://old-allowance.example",
        until: new Date(Date.now() + 60_000),
        once: true,
      },
    })

    expect(await listSecretAllowances(ctx)).toMatchObject([
      { origin: "https://old-allowance.example", once: true },
    ])
    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("old-allowance")).toBe(false)
    expect(await listSecretAllowances(ctx)).toMatchObject([
      { origin: "https://old-allowance.example", once: true },
    ])
    // The once allowance is still used up once.
    const target = {
      tokenId,
      secretId,
      origin: "https://old-allowance.example",
    }
    expect(await takeSecretUse(ctx, target)).toBe(true)
    expect(await takeSecretUse(ctx, target)).toBe(false)
  })

  it("reads sites from before, and seals them on a request", async () => {
    const tokenId = await token()
    const { id: secretId } = await createSecret(ctx, { name: "S", value: "v" })
    await db().secretBrowserOrigin.create({
      data: { secretId, origin: "https://old-origin.example" },
    })
    await db().webFetchRule.create({
      data: {
        id: "rule-1",
        vaultId: ctx.vaultId,
        tokenId,
        scope: tokenId,
        kind: "site",
        key: "old-site.example",
        access: "allowed",
      },
    })
    await db().apiTokenSiteAllowance.create({
      data: {
        tokenId,
        host: "old-allowed.example",
        until: new Date(Date.now() + 60_000),
      },
    })

    expect(
      await isBoundOrigin(ctx, secretId, "https://old-origin.example"),
    ).toBe(true)
    expect(
      (await loadFetchRules(ctx, tokenId)).ownSites.get("old-site.example"),
    ).toBe("allowed")
    // A change to a site from before seals it rather than adding a second.
    await addFetchSite(ctx, tokenId, {
      site: "old-site.example",
      level: "blocked",
      shared: false,
    })
    expect(await db().webFetchRule.count({ where: { kind: "site" } })).toBe(1)

    expect(await ensureSealed(ctx)).toBe(true)

    expect(await onDisk("old-origin")).toBe(false)
    expect(await onDisk("old-site")).toBe(false)
    expect(await onDisk("old-allowed")).toBe(false)
    expect(
      await isBoundOrigin(ctx, secretId, "https://old-origin.example"),
    ).toBe(true)
    expect(
      (await loadFetchRules(ctx, tokenId)).ownSites.get("old-site.example"),
    ).toBe("blocked")
    expect([...(await loadSiteAllowances(ctx, tokenId)).keys()]).toEqual([
      "old-allowed.example",
    ])
  })
})

describe("names", () => {
  const PASSWORD = "correct horse battery staple"

  async function claude() {
    return createApiToken(ctx, {
      name: "TOKEN-NAME-MARKER",
      allowAllServers: true,
      shareFiles: true,
    })
  }

  it("seals a token's name, and seals one from before on a request", async () => {
    const { id, token } = await claude()

    expect(await onDisk("TOKEN-NAME-MARKER")).toBe(false)
    expect((await resolveApiToken(token))?.tokenName).toBe("TOKEN-NAME-MARKER")

    await db().$executeRawUnsafe(
      `UPDATE "api_token" SET "name" = 'Old Claude', "sealed_name" = NULL WHERE "id" = ?`,
      id,
    )
    expect((await listApiTokens(ctx))[0]?.name).toBe("Old Claude")
    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("Old Claude")).toBe(false)
    expect((await listApiTokens(ctx))[0]?.name).toBe("Old Claude")
  })

  it("seals a linked file's name under its link, and the download keeps it", async () => {
    const { id: tokenId } = await claude()
    const kept = await keepResult(ctx, {
      tokenId,
      serverId: null,
      toolName: "read",
      text: "hello",
      mediaType: "text/plain",
      name: "FILE-NAME-MARKER.txt",
    })
    const link = await shareResult(ctx, {
      tokenId,
      id: kept.id,
      publicUrl: "https://pcp.example",
    })

    // The kept result's own name is sealed under the vault's key, the
    // link's under the link's.
    expect(
      await db().$queryRawUnsafe(`SELECT "name" FROM "file_link"`),
    ).toEqual([{ name: null }])
    expect(
      await db().$queryRawUnsafe(`SELECT "name" FROM "tool_result"`),
    ).toEqual([{ name: null }])
    expect(await onDisk("FILE-NAME-MARKER")).toBe(false)
    expect((await openResult(ctx, { tokenId, id: kept.id }))?.name).toBe(
      "FILE-NAME-MARKER.txt",
    )
    expect((await describeResults(ctx, tokenId, [kept.id]))[0]).toMatchObject({
      found: true,
      name: "FILE-NAME-MARKER.txt",
    })
    expect(await downloadByLink(link.url.split("/").pop()!)).toMatchObject({
      ok: true,
      name: "FILE-NAME-MARKER.txt",
    })
  })

  it("reads a kept file's name from before, and seals it on a request", async () => {
    const { id: tokenId } = await claude()
    const kept = await keepResult(ctx, {
      tokenId,
      serverId: null,
      toolName: "read",
      text: "hello",
      mediaType: "text/plain",
      name: "x.txt",
    })
    await db().$executeRawUnsafe(
      `UPDATE "tool_result" SET "name" = 'OLD-RESULT-NAME.txt', "sealed_name" = NULL WHERE "id" = ?`,
      kept.id,
    )

    expect((await openResult(ctx, { tokenId, id: kept.id }))?.name).toBe(
      "OLD-RESULT-NAME.txt",
    )
    expect(await ensureSealed(ctx)).toBe(true)
    expect(await onDisk("OLD-RESULT-NAME")).toBe(false)
    expect((await openResult(ctx, { tokenId, id: kept.id }))?.name).toBe(
      "OLD-RESULT-NAME.txt",
    )
  })

  it("shows the asking token's name on an upload page with the link alone", async () => {
    const { id: tokenId } = await claude()
    const link = await createUploadLink(ctx, {
      tokenId,
      publicUrl: "https://pcp.example",
      purpose: "Receipts",
    })

    expect(await uploadPageView(link.url.split("/").pop()!)).toMatchObject({
      state: "open",
      assistant: "TOKEN-NAME-MARKER",
    })
  })

  it("shows the names in an export only with its vault's password", async () => {
    await claude()
    const file = await exportVault(ctx, "export password 1234")

    const blind = await readExport(file, "export password 1234")
    expect(blind.preview.tokens.map((token) => token.name)).toEqual([null])

    const named = await readExport(file, "export password 1234", undefined, {
      vaultPassword: PASSWORD,
    })
    expect(named.preview.tokens.map((token) => token.name)).toEqual([
      "TOKEN-NAME-MARKER",
    ])

    await expect(
      readExport(file, "export password 1234", undefined, {
        vaultPassword: "not the password",
      }),
    ).rejects.toThrow(/not the password of the vault/)
  })
})

describe("the conversion", () => {
  function only(table: string): Converter {
    return SEAL_CONVERTERS.find((converter) => converter.table === table)!
  }

  async function plainSecret(name: string): Promise<string> {
    const { id } = await createSecret(ctx, { name: "x", value: "v" })
    await db().$executeRawUnsafe(
      `UPDATE "secret" SET "name" = ?, "meta" = NULL, "name_key" = NULL WHERE "id" = ?`,
      name,
      id,
    )
    return id
  }

  it("leaves what the owner changed between its read and its write", async () => {
    const id = await plainSecret("Before")
    const { id: tokenId } = await createApiToken(ctx, {
      name: "x",
      allowAllServers: true,
    })
    await db().$executeRawUnsafe(
      `UPDATE "api_token" SET "name" = 'Old token', "sealed_name" = NULL WHERE "id" = ?`,
      tokenId,
    )
    await db().setting.create({
      data: { vaultId: ctx.vaultId, key: "toolTiers", value: '{"a":1}' },
    })

    const secrets = await only("secret").read(ctx, 10)
    const tokens = await only("api_token").read(ctx, 10)
    const settings = await only("setting").read(ctx, 10)

    // The owner, in another request, between the read and the write.
    await updateSecret(ctx, id, { name: "Renamed", description: "New" })
    await db().apiToken.update({
      where: { id: tokenId },
      data: sealedTokenName(ctx, tokenId, "Renamed token"),
    })
    await setSetting(ctx, "toolTiers", '{"b":2}')

    for (const write of [...secrets, ...tokens, ...settings]) {
      expect(await write()).toBe(false)
    }

    expect(await listSecrets(ctx)).toMatchObject([
      { id, name: "Renamed", description: "New" },
    ])
    expect((await listApiTokens(ctx))[0]?.name).toBe("Renamed token")
    expect(await getSetting(ctx, "toolTiers")).toBe('{"b":2}')
  })

  it("runs once per vault at a time", async () => {
    await plainSecret("Old")

    const first = ensureSealed(ctx)
    const second = ensureSealed(ctx)

    expect(second).toBe(first)
    expect(await first).toBe(true)
  })

  it("goes on past a table it cannot seal, and names only the table", async () => {
    await plainSecret("SECRET-STUCK-MARKER")
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const stuck: Converter = {
      table: "stuck_table",
      read: async () => {
        throw new Error("a value that must not be logged")
      },
    }

    try {
      expect(
        await ensureSealed(ctx, { converters: [stuck, ...SEAL_CONVERTERS] }),
      ).toBe(false)
      expect(JSON.stringify(logged.mock.calls)).toContain("stuck_table")
      expect(JSON.stringify(logged.mock.calls)).not.toContain(
        "must not be logged",
      )
    } finally {
      logged.mockRestore()
    }

    // The other tables were sealed, and the file rebuilt.
    expect(await onDisk("SECRET-STUCK-MARKER")).toBe(false)
    expect(knownSealed(ctx.vaultId)).toBe(false)
    expect(await ensureSealed(ctx)).toBe(true)
  })

  it("forgets a vault that a restore replaced or that was deleted", async () => {
    expect(await ensureSealed(ctx)).toBe(true)
    expect(knownSealed(ctx.vaultId)).toBe(true)

    const { payload } = await readExport(
      await exportVault(ctx, "export password 1234"),
      "export password 1234",
    )
    await restoreExport(
      payload,
      { into: "vault", ctx },
      { restoreHostSettings: false },
    )
    expect(knownSealed(ctx.vaultId)).toBe(false)

    expect(await ensureSealed(ctx)).toBe(true)
    await deleteVault(ctx)
    expect(knownSealed(ctx.vaultId)).toBe(false)
  })

  it("shows a name it cannot open in an export as hidden", async () => {
    await createApiToken(ctx, { name: "Claude", allowAllServers: true })
    const { payload } = await readExport(
      await exportVault(ctx, "export password 1234"),
      "export password 1234",
    )
    payload.tables.apiTokens[0]!.sealedName = new Uint8Array(40)

    expect(previewOf(payload, new Map(), ctx.dek).tokens).toMatchObject([
      { name: null },
    ])
  })
})
