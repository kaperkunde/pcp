import type { VaultContext } from "./context"
import { asBytes, decryptString, encryptString } from "./crypto"
import { db } from "./db"
import { invalid, notFound, PcpError } from "./errors"
import { newId } from "./ids"

/**
 * The secret store. Values are ciphertext under the vault's data key
 * (lib/core/crypto.ts); this module is the only place they are decrypted.
 *
 * `text` secrets are the owner's: API keys, passwords, whatever an MCP
 * server needs to be sent. `oauth` secrets are managed: the token set PCP
 * obtained for a server through OAuth, kept here so it is encrypted like
 * everything else and shows up in the same list.
 */

export type SecretKind = "text" | "oauth"

export type SecretSummary = {
  id: string
  name: string
  description: string
  kind: SecretKind
  createdAt: Date
  updatedAt: Date
  lastUsedAt: Date | null
  /** Servers that send this secret, or hold their OAuth tokens in it. */
  usedBy: Array<{ id: string; name: string }>
}

const MAX_NAME = 100
const MAX_DESCRIPTION = 500
const MAX_VALUE = 64 * 1024

function aad(secretId: string): string {
  return `secret:${secretId}`
}

export function validateSecretName(name: string): string | null {
  if (!name) {
    return "Enter a name."
  }

  if (name.length > MAX_NAME) {
    return `Keep the name under ${MAX_NAME} characters.`
  }

  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._\-/]*$/u.test(name)) {
    return "Use letters, numbers, spaces, dots, dashes, underscores or slashes."
  }

  return null
}

export async function listSecrets(ctx: VaultContext): Promise<SecretSummary[]> {
  const rows = await db().secret.findMany({
    where: { vaultId: ctx.vaultId },
    include: {
      authFor: { select: { id: true, name: true } },
      oauthClientFor: { select: { id: true, name: true } },
      oauthTokensFor: { select: { id: true, name: true } },
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  })

  return rows.map((row) => {
    const usedBy = new Map<string, { id: string; name: string }>()

    for (const server of [
      ...row.authFor,
      ...row.oauthClientFor,
      ...row.oauthTokensFor,
    ]) {
      usedBy.set(server.id, server)
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      kind: row.kind as SecretKind,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastUsedAt: row.lastUsedAt,
      usedBy: [...usedBy.values()],
    }
  })
}

/** A secret the owner entered, found by its name (for register_server). */
export async function findTextSecretByName(
  ctx: VaultContext,
  name: string,
): Promise<{ id: string; name: string } | null> {
  return db().secret.findFirst({
    where: { vaultId: ctx.vaultId, name: name.trim(), kind: "text" },
    select: { id: true, name: true },
  })
}

export async function createSecret(
  ctx: VaultContext,
  input: { name: string; value: string; description?: string },
): Promise<{ id: string }> {
  const name = input.name.trim()
  const nameProblem = validateSecretName(name)

  if (nameProblem) {
    throw invalid(nameProblem)
  }

  if (!input.value) {
    throw invalid("Enter the secret's value.")
  }

  if (input.value.length > MAX_VALUE) {
    throw invalid("That value is too large for a secret.")
  }

  const description = (input.description ?? "").trim().slice(0, MAX_DESCRIPTION)

  const existing = await db().secret.findUnique({
    where: { vaultId_name: { vaultId: ctx.vaultId, name } },
    select: { id: true },
  })

  if (existing) {
    throw new PcpError("conflict", `A secret named "${name}" already exists.`)
  }

  const id = newId()

  await db().secret.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      name,
      description,
      kind: "text",
      ciphertext: asBytes(encryptString(ctx.dek, input.value, aad(id))),
    },
  })

  return { id }
}

/**
 * Creates one of the owner's secrets for a value they typed somewhere other
 * than the Secrets page, under a name made from `base` that is free (a
 * number is added when it is not).
 */
export async function createSecretNamedAfter(
  ctx: VaultContext,
  input: { base: string; value: string; description?: string },
): Promise<{ id: string; name: string }> {
  const base =
    input.base
      .replace(/[^\p{L}\p{N} ._\-/]+/gu, " ")
      .replace(/\s+/g, " ")
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .trim()
      .slice(0, MAX_NAME - 4) || "Secret"

  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`
    const taken = await db().secret.findUnique({
      where: { vaultId_name: { vaultId: ctx.vaultId, name } },
      select: { id: true },
    })

    if (!taken) {
      const { id } = await createSecret(ctx, {
        name,
        value: input.value,
        description: input.description,
      })

      return { id, name }
    }
  }
}

export async function updateSecret(
  ctx: VaultContext,
  id: string,
  input: { name?: string; description?: string; value?: string },
): Promise<void> {
  const row = await db().secret.findFirst({
    where: { id, vaultId: ctx.vaultId },
  })

  if (!row) {
    throw notFound("That secret")
  }

  const data: {
    name?: string
    description?: string
    ciphertext?: Uint8Array<ArrayBuffer>
  } = {}

  if (input.name !== undefined) {
    if (row.kind !== "text") {
      throw invalid("Managed secrets keep their name.")
    }

    const name = input.name.trim()
    const nameProblem = validateSecretName(name)

    if (nameProblem) {
      throw invalid(nameProblem)
    }

    if (name !== row.name) {
      const clash = await db().secret.findUnique({
        where: { vaultId_name: { vaultId: ctx.vaultId, name } },
        select: { id: true },
      })

      if (clash) {
        throw new PcpError(
          "conflict",
          `A secret named "${name}" already exists.`,
        )
      }
    }

    data.name = name
  }

  if (input.description !== undefined) {
    data.description = input.description.trim().slice(0, MAX_DESCRIPTION)
  }

  if (input.value !== undefined) {
    if (row.kind !== "text") {
      throw invalid("Managed secrets are written by the server they belong to.")
    }

    if (!input.value) {
      throw invalid("Enter the secret's value.")
    }

    if (input.value.length > MAX_VALUE) {
      throw invalid("That value is too large for a secret.")
    }

    data.ciphertext = asBytes(encryptString(ctx.dek, input.value, aad(id)))
  }

  await db().secret.update({ where: { id }, data })
}

export async function deleteSecret(ctx: VaultContext, id: string) {
  const row = await db().secret.findFirst({
    where: { id, vaultId: ctx.vaultId },
    include: {
      authFor: { select: { name: true } },
      oauthClientFor: { select: { name: true } },
      oauthTokensFor: { select: { name: true } },
    },
  })

  if (!row) {
    throw notFound("That secret")
  }

  const users = [...row.authFor, ...row.oauthClientFor].map(
    (server) => server.name,
  )

  if (users.length > 0) {
    throw new PcpError(
      "conflict",
      `This secret is used by ${users.join(", ")}. Change those servers first.`,
    )
  }

  if (row.kind === "oauth") {
    // The server that held its tokens here is no longer connected.
    await db().mcpServer.updateMany({
      where: { vaultId: ctx.vaultId, oauthTokensId: id },
      data: { oauthConnectedAt: null, status: "unknown", statusMessage: "" },
    })
  }

  await db().secret.delete({ where: { id } })
}

/** The plain value, for showing the owner. */
export async function revealSecret(
  ctx: VaultContext,
  id: string,
): Promise<string> {
  const row = await db().secret.findFirst({
    where: { id, vaultId: ctx.vaultId },
  })

  if (!row) {
    throw notFound("That secret")
  }

  return decryptString(ctx.dek, Buffer.from(row.ciphertext), aad(id))
}

/** The plain value, for sending upstream. Records that it was used. */
export async function readSecretValue(
  ctx: VaultContext,
  id: string,
): Promise<string> {
  const row = await db().secret.findFirst({
    where: { id, vaultId: ctx.vaultId },
  })

  if (!row) {
    throw notFound("That secret")
  }

  void db()
    .secret.update({ where: { id }, data: { lastUsedAt: new Date() } })
    .catch(() => {})

  return decryptString(ctx.dek, Buffer.from(row.ciphertext), aad(id))
}

/**
 * Creates or replaces a managed secret (OAuth tokens for a server). Named
 * after the owning server so it cannot collide with the owner's names.
 */
export async function writeManagedSecret(
  ctx: VaultContext,
  input: { name: string; description: string; value: string },
): Promise<{ id: string }> {
  const existing = await db().secret.findUnique({
    where: { vaultId_name: { vaultId: ctx.vaultId, name: input.name } },
    select: { id: true, kind: true },
  })

  if (existing) {
    if (existing.kind !== "oauth") {
      throw new PcpError(
        "conflict",
        `A secret named "${input.name}" already exists.`,
      )
    }

    await db().secret.update({
      where: { id: existing.id },
      data: {
        description: input.description,
        ciphertext: asBytes(
          encryptString(ctx.dek, input.value, aad(existing.id)),
        ),
      },
    })

    return { id: existing.id }
  }

  const id = newId()

  await db().secret.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      name: input.name,
      description: input.description,
      kind: "oauth",
      ciphertext: asBytes(encryptString(ctx.dek, input.value, aad(id))),
    },
  })

  return { id }
}

export async function deleteManagedSecret(
  ctx: VaultContext,
  id: string,
): Promise<void> {
  await db().secret.deleteMany({
    where: { id, vaultId: ctx.vaultId, kind: "oauth" },
  })
}
