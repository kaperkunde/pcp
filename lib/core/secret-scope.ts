import type { VaultContext } from "./context"
import { db } from "./db"
import { notFound, PcpError } from "./errors"
import { SERVER_META_SELECT, serverName, serverSlug } from "./server-meta"
import { kindWords, secretUses, type SecretUse } from "./secret-uses"
import { isOwnerSecretKind } from "./secrets"

/**
 * Where one of the owner's secrets may be used (#162): its scope, granted
 * on the owner's pages only.
 *
 * - **Consumers** (`secret_scope` rows): the servers, API endpoints, mail
 *   and calendar accounts, services and wrappers that may name it, in a
 *   header or sign-in, a variable or a wrapper's place for one. Whatever
 *   uses it now is in its scope too, row or not: a use is only ever made by
 *   the owner's own pick on their pages or by their yes to an assistant's
 *   proposal, and either is the grant.
 * - **Sites** (`secret_browser_origin`, browser-secrets.ts): where the
 *   browser types it, as before.
 * - **Anywhere** (`secret.scope_anywhere`): any consumer, and for the
 *   browser any site after asking the owner, as every secret was before
 *   the scope.
 *
 * `resolveSecretRef` (secret-refs.ts) is the one place a secret named by
 * name is checked against it. An assistant's proposal that names a secret
 * outside its scope is shown to the owner as "also allows <secret> for
 * <consumer>", and their yes adds that consumer alone, once it is made
 * (secret-scope-asks.ts keepAllowed). Only the owner widens a scope; nothing an assistant sends does.
 *
 * A secret from before the scope (`scope_anywhere` null, the migration's
 * mark) gets its uses as its scope, or anywhere when nothing uses it, on
 * the first request that holds the vault's key (`ensureSecretScopes`): its
 * uses are partly in sealed definitions that SQL cannot read.
 */

/** Something that names a secret: a server's id, or one a proposal makes. */
export type SecretConsumer = {
  /** The server's, endpoint's, account's, service's or wrapper's id; null for one a proposal would make. */
  id: string | null
  /** Its name, as the owner and the assistant read it. */
  name: string
}

/** One consumer of a secret's scope, as the owner's pages show it. */
export type SecretScopeConsumer = {
  id: string
  name: string
  slug: string
  /** In plain words: "server", "API endpoint", "wrapper", … */
  kind: string
  wrapper: boolean
  /** It uses the secret now (secret-uses.ts): it stays while it does. */
  inUse: boolean
  /** The owner granted it (a row), whether it uses it now or not. */
  granted: boolean
}

export type SecretScopeState = {
  anywhere: boolean
  /** Granted or in use, by name. */
  consumers: SecretScopeConsumer[]
}

const SERVER = { ...SERVER_META_SELECT, kind: true } as const

/** The uses a scope holds: servers, services and wrappers, never a repository. */
function scopedUses(uses: readonly SecretUse[]): SecretUse[] {
  return uses.filter((use) => use.via !== "repo")
}

/**
 * Gives every secret from before the scope its uses as its scope, or
 * anywhere when nothing uses it: once per secret, whoever gets there first
 * (the claim is the update of its mark), inside a request that holds the
 * vault's key. Cheap when there is nothing to do.
 */
export async function ensureSecretScopes(ctx: VaultContext): Promise<void> {
  const pending = await db().secret.findMany({
    where: { vaultId: ctx.vaultId, scopeAnywhere: null },
    select: { id: true, kind: true },
  })

  if (pending.length === 0) {
    return
  }

  const report = { unread: 0 }
  const usage = await secretUses(
    ctx,
    pending.map((row) => row.id),
    report,
  )

  for (const { id, kind } of pending) {
    const uses = scopedUses(usage.get(id)?.uses ?? [])
    // Rows name servers: the Google sign-in is in scope by using the secret.
    const serverIds = [
      ...new Set(uses.filter((use) => !use.account).map((use) => use.id)),
    ]
    // PCP's own secrets are for what they were made for, never anywhere.
    const anywhere = uses.length === 0 && isOwnerSecretKind(kind)

    // A wrapper whose definition did not read may use it: "nothing uses
    // it" is not known, so it waits for a request where they all read.
    if (anywhere && report.unread > 0) {
      continue
    }

    await db().$transaction(async (tx) => {
      const { count } = await tx.secret.updateMany({
        where: { id, scopeAnywhere: null },
        data: { scopeAnywhere: anywhere },
      })

      if (count !== 1) {
        return
      }

      const existing = new Set(
        (
          await tx.secretScope.findMany({
            where: { secretId: id },
            select: { serverId: true },
          })
        ).map((row) => row.serverId),
      )
      const missing = serverIds.filter((serverId) => !existing.has(serverId))

      if (missing.length > 0) {
        await tx.secretScope.createMany({
          data: missing.map((serverId) => ({ secretId: id, serverId })),
        })
      }
    })
  }
}

/** These secrets' scopes, by secret id (every one of the vault's without `ids`). */
export async function readSecretScopes(
  ctx: VaultContext,
  ids?: string[],
): Promise<Map<string, SecretScopeState>> {
  await ensureSecretScopes(ctx)

  const rows = await db().secret.findMany({
    where: { vaultId: ctx.vaultId, ...(ids ? { id: { in: ids } } : {}) },
    select: {
      id: true,
      scopeAnywhere: true,
      scope: { select: { server: { select: SERVER } } },
    },
  })
  const usage = await secretUses(
    ctx,
    rows.map((row) => row.id),
  )

  return new Map(
    rows.map((row) => {
      const consumers = new Map<string, SecretScopeConsumer>()

      for (const { server } of row.scope) {
        consumers.set(server.id, {
          id: server.id,
          name: serverName(ctx, server),
          slug: serverSlug(ctx, server),
          kind: kindWords(server.kind),
          wrapper: server.kind === "wrapper",
          inUse: false,
          granted: true,
        })
      }

      for (const use of scopedUses(usage.get(row.id)?.uses ?? [])) {
        const known = consumers.get(use.id)

        consumers.set(use.id, {
          id: use.id,
          name: use.name,
          slug: use.slug,
          kind: use.kind,
          wrapper: use.via === "wrapper_binding",
          inUse: true,
          granted: known?.granted ?? false,
        })
      }

      return [
        row.id,
        {
          anywhere: row.scopeAnywhere !== false,
          consumers: [...consumers.values()].sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
        },
      ]
    }),
  )
}

/** Whether the secret may be used anywhere. */
export async function isAnywhere(
  ctx: VaultContext,
  secretId: string,
): Promise<boolean> {
  await ensureSecretScopes(ctx)

  const row = await db().secret.findFirst({
    where: { id: secretId, vaultId: ctx.vaultId },
    select: { scopeAnywhere: true },
  })

  return row !== null && row.scopeAnywhere !== false
}

/**
 * Whether the secret's scope covers the consumer: anywhere, a row the owner
 * granted, or a use of it now. A consumer a proposal would make (no id yet)
 * is covered only by anywhere.
 */
export async function scopeCovers(
  ctx: VaultContext,
  secretId: string,
  consumerId: string | null,
): Promise<boolean> {
  if (await isAnywhere(ctx, secretId)) {
    return true
  }

  if (consumerId === null) {
    return false
  }

  const row = await db().secretScope.findUnique({
    where: { secretId_serverId: { secretId, serverId: consumerId } },
    select: { secretId: true },
  })

  if (row) {
    return true
  }

  return scopedUses(
    (await secretUses(ctx, [secretId])).get(secretId)?.uses ?? [],
  ).some((use) => use.id === consumerId)
}

/**
 * Why a secret is not used where it was named, for the assistant: the one
 * refusal of a secret outside its scope.
 */
export function scopeRefusal(secretName: string, consumerName: string): string {
  return `The owner has not allowed the secret "${secretName}" for ${consumerName}. change_secret_scope proposes it, which the owner answers in PCP; nothing was changed.`
}

/** Refuses, naming change_secret_scope, unless the scope covers the consumer. */
export async function requireInScope(
  ctx: VaultContext,
  secret: { id: string; name: string },
  consumer: SecretConsumer,
): Promise<void> {
  if (!(await scopeCovers(ctx, secret.id, consumer.id))) {
    throw new PcpError("forbidden", scopeRefusal(secret.name, consumer.name))
  }
}

async function requireSecret(ctx: VaultContext, secretId: string) {
  const row = await db().secret.findFirst({
    where: { id: secretId, vaultId: ctx.vaultId },
    select: { id: true, kind: true },
  })

  if (!row) {
    throw notFound("That secret")
  }

  return row
}

/**
 * Adds a server, endpoint, account, service or wrapper of the vault to the
 * secret's scope: the owner's pick on their page, or their yes to a
 * request that showed it. Adding one already there changes nothing.
 */
export async function grantSecretScope(
  ctx: VaultContext,
  secretId: string,
  serverId: string,
): Promise<void> {
  await requireSecret(ctx, secretId)

  const server = await db().mcpServer.findFirst({
    where: { id: serverId, vaultId: ctx.vaultId },
    select: { id: true, kind: true },
  })

  if (!server || !(SCOPE_KINDS as readonly string[]).includes(server.kind)) {
    throw notFound("That server")
  }

  await db().secretScope.upsert({
    where: { secretId_serverId: { secretId, serverId } },
    create: { secretId, serverId },
    update: {},
  })
}

/**
 * Takes a consumer out of the secret's scope: refused while it uses the
 * secret, which only changing that consumer ends.
 */
export async function removeFromSecretScope(
  ctx: VaultContext,
  secretId: string,
  serverId: string,
): Promise<void> {
  await requireSecret(ctx, secretId)

  const use = scopedUses(
    (await secretUses(ctx, [secretId])).get(secretId)?.uses ?? [],
  ).find((each) => each.id === serverId)

  if (use) {
    throw new PcpError(
      "conflict",
      `${use.name} uses this secret now, so it stays in its scope. Change ${use.name} first.`,
    )
  }

  await db().secretScope.deleteMany({ where: { secretId, serverId } })
}

/** Lets the secret be used anywhere, or only within its scope. */
export async function setSecretAnywhere(
  ctx: VaultContext,
  secretId: string,
  anywhere: boolean,
): Promise<void> {
  await ensureSecretScopes(ctx)
  await requireSecret(ctx, secretId)
  await db().secret.update({
    where: { id: secretId },
    data: { scopeAnywhere: anywhere },
  })
}

/** What uses each of these secrets now, by consumer id (no repositories). */
export async function consumersNow(
  ctx: VaultContext,
  secretIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const usage = await secretUses(ctx, [...new Set(secretIds)])

  return new Map(
    [...usage].map(([secretId, { uses }]) => [
      secretId,
      new Set(scopedUses(uses).map((use) => use.id)),
    ]),
  )
}

/**
 * The secrets of these ids whose scope does not cover the consumer: what a
 * proposal's page shows as "also allows", by id with the secret's name.
 */
export async function outOfScope(
  ctx: VaultContext,
  secrets: ReadonlyArray<{ id: string; name: string }>,
  consumerId: string | null,
): Promise<Array<{ id: string; name: string }>> {
  const seen = new Set<string>()
  const out: Array<{ id: string; name: string }> = []

  for (const secret of secrets) {
    if (seen.has(secret.id)) {
      continue
    }

    seen.add(secret.id)

    const exists = await db().secret.findFirst({
      where: { id: secret.id, vaultId: ctx.vaultId },
      select: { id: true },
    })

    if (exists && !(await scopeCovers(ctx, secret.id, consumerId))) {
      out.push(secret)
    }
  }

  return out
}

/**
 * What the owner can add to a secret's scope on the Secrets page: the
 * vault's servers, endpoints, mail and calendar accounts, services and
 * wrappers, by name.
 */
export async function listScopeCandidates(
  ctx: VaultContext,
): Promise<Array<{ id: string; name: string; kind: string }>> {
  const rows = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId, kind: { in: [...SCOPE_KINDS] } },
    select: SERVER,
  })

  return rows
    .map((row) => ({
      id: row.id,
      name: serverName(ctx, row),
      kind: kindWords(row.kind),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The kinds of server a secret's scope can name. */
export const SCOPE_KINDS = [
  "mcp",
  "openapi",
  "jmap",
  "imap",
  "caldav",
  "service",
  "wrapper",
] as const
