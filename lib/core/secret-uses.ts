import type { VaultContext } from "./context"
import { db } from "./db"
import type { SecretKind } from "./secrets"
import { readEnvBindings } from "./services/definition"
import { readDefinition } from "./wrappers/definition"

/**
 * What uses each secret, by name, and the secrets' names for a token that
 * manages endpoints (list_secrets). Never a value: nothing here selects a
 * ciphertext, and nothing decrypts.
 */

/**
 * Something that uses a secret: a server that sends it, a wrapper with a
 * place for it, or a service whose variable takes it.
 */
export type SecretUse = {
  name: string
  slug: string
  /** In plain words: "server", "API endpoint", "mail account", … */
  kind: string
}

const KIND_WORDS: Record<string, string> = {
  mcp: "server",
  openapi: "API endpoint",
  jmap: "mail account",
  imap: "mail account",
  caldav: "calendar account",
  ssh: "SSH server",
  wrapper: "wrapper",
  service: "service",
}

function kindWords(kind: string): string {
  return KIND_WORDS[kind] ?? "server"
}

const SERVER = { id: true, name: true, slug: true, kind: true } as const

/**
 * Every server that sends one of these secrets or keeps its OAuth tokens or
 * client secret in it (the same relations listSecrets reads), and every
 * wrapper whose definition has a place for it, by secret id. All of the
 * vault's secrets when `ids` is left out.
 */
export async function secretUses(
  ctx: VaultContext,
  ids?: string[],
): Promise<Map<string, SecretUse[]>> {
  const rows = await db().secret.findMany({
    where: { vaultId: ctx.vaultId, ...(ids ? { id: { in: ids } } : {}) },
    select: {
      id: true,
      authFor: { select: SERVER },
      authHeaderFor: { select: { server: { select: SERVER } } },
      oauthClientFor: { select: SERVER },
      oauthTokensFor: { select: SERVER },
    },
  })
  // By secret, then by server id, so a server that uses one twice (a header
  // and its OAuth client) is named once.
  const uses = new Map<string, Map<string, SecretUse>>(
    rows.map((row) => [row.id, new Map()]),
  )
  const add = (
    secretId: string,
    server: { id: string; name: string; slug: string; kind: string },
  ) =>
    uses.get(secretId)?.set(server.id, {
      name: server.name,
      slug: server.slug,
      kind: kindWords(server.kind),
    })

  for (const row of rows) {
    for (const server of [
      ...row.authFor,
      ...row.authHeaderFor.map((header) => header.server),
      ...row.oauthClientFor,
      ...row.oauthTokensFor,
    ]) {
      add(row.id, server)
    }
  }

  const wrappers = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId, kind: "wrapper" },
    select: { ...SERVER, wrapperSpec: { select: { definition: true } } },
  })

  for (const wrapper of wrappers) {
    if (!wrapper.wrapperSpec) {
      continue
    }

    let bound: Array<string | null>

    try {
      bound = readDefinition(wrapper.wrapperSpec.definition).secrets.map(
        (binding) => binding.secretId,
      )
    } catch {
      // A definition that does not read is no use of anything.
      continue
    }

    for (const secretId of bound) {
      if (secretId) {
        add(secretId, wrapper)
      }
    }
  }

  const services = await db().serviceSpec.findMany({
    where: { server: { vaultId: ctx.vaultId } },
    select: { env: true, server: { select: SERVER } },
  })

  for (const service of services) {
    for (const secretId of Object.values(readEnvBindings(service.env))) {
      add(secretId, service.server)
    }
  }

  return new Map(
    [...uses].map(([id, found]) => [
      id,
      [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ]),
  )
}

/** "A, B and C", or "A, B, C and 4 more" past `max`. */
export function namesInWords(names: string[], max = 5): string {
  const shown = names.slice(0, max)
  const more = names.length - shown.length

  if (more > 0) {
    return `${shown.join(", ")} and ${more} more`
  }

  return shown.length <= 1
    ? (shown[0] ?? "")
    : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
}

export const MAX_LISTED_SECRETS = 100
export const MAX_LISTED_USES = 20
export const MAX_SECRET_QUERY = 100

const KIND_SHOWN: Record<SecretKind, string> = {
  text: "text",
  totp: "one-time codes (TOTP), typed by the browser only",
  oauth: "OAuth sign-in (kept by PCP for a server)",
  ssh_key: "SSH key (PCP's own, for an SSH server)",
  proxy_password: "proxy password (PCP's own, for a VPN service's exit)",
}

export type ListedSecret = {
  name: string
  description: string
  kind: string
  /** Whether naming it in register_server sends it rather than a new one. */
  reusable: boolean
  usedBy: SecretUse[]
  /** Further uses past MAX_LISTED_USES. */
  moreUses?: number
}

/**
 * The vault's secrets as a token that manages endpoints sees them: names,
 * descriptions, kinds and what uses each. Never a value or a date.
 */
export async function listSecretNames(
  ctx: VaultContext,
  query?: string,
): Promise<{ secrets: ListedSecret[]; more: number }> {
  const needle = query?.trim().toLowerCase().slice(0, MAX_SECRET_QUERY) ?? ""
  const rows = (
    await db().secret.findMany({
      where: { vaultId: ctx.vaultId },
      select: { id: true, name: true, description: true, kind: true },
      orderBy: [{ kind: "desc" }, { name: "asc" }],
    })
  ).filter(
    (row) =>
      !needle ||
      row.name.toLowerCase().includes(needle) ||
      row.description.toLowerCase().includes(needle),
  )
  const shown = rows.slice(0, MAX_LISTED_SECRETS)
  const uses = await secretUses(
    ctx,
    shown.map((row) => row.id),
  )

  return {
    secrets: shown.map((row) => {
      const usedBy = uses.get(row.id) ?? []
      const kind = (row.kind in KIND_SHOWN ? row.kind : "text") as SecretKind

      return {
        name: row.name,
        description: row.description,
        kind: KIND_SHOWN[kind],
        reusable: kind === "text",
        usedBy: usedBy.slice(0, MAX_LISTED_USES),
        ...(usedBy.length > MAX_LISTED_USES
          ? { moreUses: usedBy.length - MAX_LISTED_USES }
          : {}),
      }
    }),
    more: rows.length - shown.length,
  }
}
