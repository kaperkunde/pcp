import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "./context"
import { db } from "./db"
import {
  createSecret,
  deleteSecret,
  listSecrets,
  updateSecret,
  writeManagedSecret,
} from "./secrets"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"
import { secretNameWhere } from "./secret-meta"

// The sign-in one of the owner's secrets belongs to: its login name and
// note, encrypted like the value, and the one-time codes that go with it.

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

async function summary(id: string) {
  return (await listSecrets(ctx)).find((secret) => secret.id === id)!
}

describe("a secret's sign-in", () => {
  it("keeps a login name and note encrypted, and names its one-time codes", async () => {
    const codes = await createSecret(ctx, {
      name: "Shop code",
      value: SEED,
      kind: "totp",
    })
    const { id } = await createSecret(ctx, {
      name: "Shop password",
      value: "hunter2",
      loginName: "  ada@example.com ",
      note: "The family account",
      totpCompanionId: codes.id,
    })

    expect(await summary(id)).toMatchObject({
      loginName: "ada@example.com",
      note: "The family account",
      totpCompanion: { id: codes.id, name: "Shop code" },
    })

    const row = await db().secret.findUniqueOrThrow({ where: { id } })
    expect(Buffer.from(row.loginName!).toString("latin1")).not.toContain(
      "ada@example.com",
    )
    expect(Buffer.from(row.note!).toString("latin1")).not.toContain("family")

    // Left out stays; empty takes it away.
    await updateSecret(ctx, id, { description: "Shop" })
    expect((await summary(id)).loginName).toBe("ada@example.com")
    await updateSecret(ctx, id, {
      loginName: "",
      note: "",
      totpCompanionId: null,
    })
    expect(await summary(id)).toMatchObject({
      loginName: null,
      note: null,
      totpCompanion: null,
    })
  })

  it("is opened only under its own row's id", async () => {
    const a = await createSecret(ctx, {
      name: "A",
      value: "a",
      loginName: "a@example.com",
    })
    const b = await createSecret(ctx, { name: "B", value: "b" })
    const row = await db().secret.findUniqueOrThrow({ where: { id: a.id } })

    // A login name moved onto another secret does not open there.
    await db().secret.update({
      where: { id: b.id },
      data: { loginName: row.loginName },
    })
    expect((await summary(b.id)).loginName).toBeNull()
  })

  it("refuses a login name or note on several lines, with hidden characters, or too long", async () => {
    const { id } = await createSecret(ctx, { name: "Shop", value: "x" })

    await expect(
      updateSecret(ctx, id, { loginName: "ada\nbob" }),
    ).rejects.toThrow(/one line/)
    await expect(updateSecret(ctx, id, { note: "look‮here" })).rejects.toThrow(
      /does not show on screen/,
    )
    await expect(
      updateSecret(ctx, id, { loginName: "a".repeat(201) }),
    ).rejects.toThrow(/200 characters/)
    await expect(
      updateSecret(ctx, id, { note: "n".repeat(301) }),
    ).rejects.toThrow(/300 characters/)
    await expect(
      createSecret(ctx, { name: "Other", value: "y", note: "one\ntwo" }),
    ).rejects.toThrow(/one line/)
    expect(
      await db().secret.count({ where: secretNameWhere(ctx, "Other") }),
    ).toBe(0)
  })

  it("names only a one-time code secret, from a text secret", async () => {
    const codes = await createSecret(ctx, {
      name: "Code",
      value: SEED,
      kind: "totp",
    })
    const other = await createSecret(ctx, { name: "Other", value: "o" })
    const { id } = await createSecret(ctx, { name: "Shop", value: "x" })

    await expect(
      updateSecret(ctx, id, { totpCompanionId: other.id }),
    ).rejects.toThrow(/one-time code secrets/)
    await expect(
      updateSecret(ctx, id, { totpCompanionId: "missing" }),
    ).rejects.toThrow(/one-time code secrets/)
    await expect(
      updateSecret(ctx, codes.id, { totpCompanionId: codes.id }),
    ).rejects.toThrow(/Only a text secret/)

    // Deleting the companion leaves the secret, naming none.
    await updateSecret(ctx, id, { totpCompanionId: codes.id })
    await deleteSecret(ctx, codes.id)
    expect((await summary(id)).totpCompanion).toBeNull()
  })

  it("is none of a managed secret's", async () => {
    const { id } = await writeManagedSecret(ctx, {
      name: "Build box SSH key",
      description: "PCP's key",
      value: "-----BEGIN OPENSSH PRIVATE KEY-----",
      kind: "ssh_key",
    })

    await expect(updateSecret(ctx, id, { loginName: "root" })).rejects.toThrow(
      /no sign-in/,
    )
    expect(await summary(id)).toMatchObject({
      loginName: null,
      note: null,
      totpCompanion: null,
    })
  })
})
