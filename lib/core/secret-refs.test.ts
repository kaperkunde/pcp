import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "./context"
import { asBytes, encryptString } from "./crypto"
import { db } from "./db"
import {
  credentialUse,
  resolveSecretRef,
  SECRET_REF_USES,
  secretKindsFor,
  type SecretRefUse,
} from "./secret-refs"
import { secretUses } from "./secret-uses"
import {
  createGeneratedSecret,
  createSecret,
  deleteManagedSecret,
  deleteSecret,
  listSecrets,
  readSecretValue,
  writeManagedSecret,
} from "./secrets"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// The one way a field that takes a secret by name finds it (#162), and the
// managed value PCP makes for a service's variable with no step of the
// owner's.

// "12345678901234567890" in base32: RFC 6238's seed.
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

let cleanup: () => Promise<void>
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({ name: "Ada", password: "correct horse battery" })
})

afterEach(async () => {
  await cleanup()
})

const EVERY_USE: SecretRefUse[] = [
  ...SECRET_REF_USES.map((kind) => ({ kind }) as SecretRefUse),
  { kind: "wrapper_binding", typed: true },
]

describe("resolveSecretRef", () => {
  it("finds a text secret for every use, by its name trimmed", async () => {
    const { id } = await createSecret(ctx, { name: "Shop key", value: "k" })

    for (const use of EVERY_USE) {
      expect(await resolveSecretRef(ctx, "  Shop key ", use), use.kind).toEqual(
        { id, name: "Shop key", kind: "text" },
      )
    }

    expect(await resolveSecretRef(ctx, "Shop", { kind: "header" })).toBeNull()
  })

  it("finds one-time codes only where the browser types them", async () => {
    const { id } = await createSecret(ctx, {
      name: "Shop codes",
      value: SEED,
      kind: "totp",
    })
    const found = []

    for (const use of EVERY_USE) {
      if (await resolveSecretRef(ctx, "Shop codes", use)) {
        found.push(use)
      }
    }

    expect(found).toEqual([
      { kind: "browser_type" },
      { kind: "wrapper_binding", typed: true },
    ])
    expect(
      await resolveSecretRef(ctx, "Shop codes", { kind: "browser_type" }),
    ).toEqual({ id, name: "Shop codes", kind: "totp" })
  })

  it("never names a managed secret, for any use", async () => {
    for (const kind of ["oauth", "ssh_key", "proxy_password"] as const) {
      await writeManagedSecret(ctx, {
        name: `Managed ${kind}`,
        description: "",
        value: "v",
        kind,
      })
    }
    await createGeneratedSecret(ctx, { name: "Managed generated" })

    for (const name of [
      "Managed oauth",
      "Managed ssh_key",
      "Managed proxy_password",
      "Managed generated",
    ]) {
      for (const use of EVERY_USE) {
        expect(await resolveSecretRef(ctx, name, use), name).toBeNull()
      }
    }
  })

  it("says per use which kinds it may name", () => {
    expect(secretKindsFor({ kind: "browser_type" })).toEqual(["text", "totp"])
    expect(secretKindsFor({ kind: "wrapper_binding" })).toEqual(["text"])
    expect(secretKindsFor({ kind: "service_env" })).toEqual(["text"])
  })

  it("tells a server's own secret's use from how it signs in", () => {
    expect(credentialUse({ authType: "header" })).toEqual({ kind: "header" })
    expect(credentialUse({ authType: "basic" })).toEqual({ kind: "basic" })
    expect(credentialUse({ authType: "oauth", mail: true })).toEqual({
      kind: "oauth_client",
    })
    expect(credentialUse({ authType: "basic", mail: true })).toEqual({
      kind: "mail",
    })
    expect(credentialUse({ authType: "header", calendar: true })).toEqual({
      kind: "caldav",
    })
  })
})

describe("createGeneratedSecret", () => {
  it("makes a managed token once, never handing back or changing its value", async () => {
    const made = await createGeneratedSecret(ctx, {
      name: "Docs service key",
      description: "DOCS_KEY of the service Docs.",
    })

    expect(made).toEqual({
      id: expect.any(String),
      name: "Docs service key",
      created: true,
    })
    expect(JSON.stringify(made)).not.toMatch(/[A-Za-z0-9]{48}/)
    const value = await readSecretValue(ctx, made.id)
    expect(value).toMatch(/^[A-Za-z0-9]{48}$/)
    expect(
      (await db().secret.findUniqueOrThrow({ where: { id: made.id } })).kind,
    ).toBe("generated")

    // Made again (a remake): the same secret, the same value.
    expect(
      await createGeneratedSecret(ctx, { name: "Docs service key" }),
    ).toEqual({ ...made, created: false })
    expect(await readSecretValue(ctx, made.id)).toBe(value)
  })

  it("makes what a recipe says", async () => {
    const made = await createGeneratedSecret(ctx, {
      name: "Hex key",
      recipe: {
        format: "hex",
        length: 64,
        lowercase: true,
        uppercase: true,
        digits: true,
        symbols: true,
        exclude: "",
      },
    })

    expect(await readSecretValue(ctx, made.id)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("refuses a name the owner's secret has, and a name that is not one", async () => {
    await createSecret(ctx, { name: "Taken", value: "mine" })

    await expect(createGeneratedSecret(ctx, { name: "Taken" })).rejects.toThrow(
      /already exists/,
    )
    await expect(createGeneratedSecret(ctx, { name: "" })).rejects.toThrow(
      /Enter a name/,
    )
  })

  it("is listed as PCP's own and removed as a managed secret", async () => {
    const made = await createGeneratedSecret(ctx, { name: "Made" })

    expect(
      (await listSecrets(ctx)).find((secret) => secret.id === made.id)?.kind,
    ).toBe("generated")
    await deleteManagedSecret(ctx, made.id)
    expect(await db().secret.count({ where: { id: made.id } })).toBe(0)
  })
})

describe("what uses a secret", () => {
  it("blocks deleting it under a service's variable or a linked repository, and lists both", async () => {
    const key = await createSecret(ctx, { name: "Key", value: "k" })
    // As createRepo writes it, without asking GitHub.
    const repoId = "repo-1"
    await db().repo.create({
      data: {
        id: repoId,
        vaultId: ctx.vaultId,
        ciphertext: asBytes(
          encryptString(
            ctx.dek,
            JSON.stringify({ owner: "ada", name: "items", branch: "main" }),
            `repo:${repoId}`,
          ),
        ),
        secretId: key.id,
      },
    })

    const usage = (await secretUses(ctx, [key.id])).get(key.id)!
    expect(usage.uses).toEqual([
      expect.objectContaining({
        name: "ada/items",
        kind: "linked repository",
        via: "repo",
      }),
    ])
    expect(
      (await listSecrets(ctx)).find((secret) => secret.id === key.id)?.usedBy,
    ).toEqual([{ id: usage.uses[0]!.id, name: "ada/items" }])
    await expect(deleteSecret(ctx, key.id)).rejects.toThrow(
      /used by ada\/items\. Change those first/,
    )
  })
})
