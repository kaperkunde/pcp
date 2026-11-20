import type { PermissionKind } from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import type { RegisterArgs } from "./permissions"
import { SECRET_META_SELECT, secretName } from "./secret-meta"
import { keepUsesInScope, outOfScope } from "./secret-scope"
import type { ServiceChangeAsk } from "./services/proposals"
import type { WrapperChangeAsk } from "./wrappers/admin"

/**
 * A proposal that names one of the owner's secrets for something outside
 * the secret's scope (#162, secret-scope.ts): a new server's, endpoint's or
 * account's sign-in (register_server), a new service's variable, or a
 * wrapper's place for one. Its page shows "also allows <secret> for
 * <consumer>", ticked; the owner's yes needs each ticked, and once what it
 * proposed is made, what now uses the secret is kept in its scope. Nothing
 * an assistant sends ticks it.
 */
export type AlsoAllow = {
  /** "also:<secret id>": what the owner's answer names. */
  key: string
  secretId: string
  secretName: string
  /** What would use it, by name: the proposed one, or the wrapper. */
  consumer: string
}

type Named = { id: string; consumerId: string | null; consumer: string }

/** The secrets a request names that it would make something use. */
function namedSecrets(kind: PermissionKind, args: unknown): Named[] {
  if (kind === "register") {
    const asked = args as RegisterArgs
    const ids = [
      asked.authSecretId,
      asked.oauthClientSecretId,
      ...(asked.authExtraHeaders ?? []).map((extra) => extra.secretId),
    ].filter((id): id is string => typeof id === "string" && id !== "")

    return ids.map((id) => ({ id, consumerId: null, consumer: asked.name }))
  }

  if (kind === "service_change") {
    const asked = args as Partial<ServiceChangeAsk>

    // An image update names no secret.
    if (!Array.isArray(asked.env)) {
      return []
    }

    return asked.env.flatMap((variable) =>
      variable.secretId
        ? [{ id: variable.secretId, consumerId: null, consumer: asked.name! }]
        : [],
    )
  }

  if (kind === "wrapper_change") {
    const asked = args as WrapperChangeAsk

    if (
      (asked.action !== "create" && asked.action !== "update") ||
      !asked.definition
    ) {
      return []
    }

    return asked.definition.secrets.flatMap((binding) =>
      binding.secretId
        ? [
            {
              id: binding.secretId,
              consumerId: asked.serverId,
              consumer: asked.name,
            },
          ]
        : [],
    )
  }

  return []
}

/** What a pending request would also allow, as its page shows it. */
export async function alsoAllowsOf(
  ctx: VaultContext,
  kind: PermissionKind,
  args: unknown,
): Promise<AlsoAllow[]> {
  const named = namedSecrets(kind, args)

  if (named.length === 0) {
    return []
  }

  const rows = await db().secret.findMany({
    where: { vaultId: ctx.vaultId, id: { in: named.map((each) => each.id) } },
    select: SECRET_META_SELECT,
  })
  const names = new Map(rows.map((row) => [row.id, secretName(ctx, row)]))
  const found: AlsoAllow[] = []

  for (const each of named) {
    const name = names.get(each.id)

    if (!name || found.some((also) => also.secretId === each.id)) {
      continue
    }

    const out = await outOfScope(ctx, [{ id: each.id, name }], each.consumerId)

    if (out.length > 0) {
      found.push({
        key: `also:${each.id}`,
        secretId: each.id,
        secretName: name,
        consumer: each.consumer,
      })
    }
  }

  return found
}

/**
 * The owner's answer to a request that also allows secrets: each one it
 * shows has to be ticked, or nothing is made. Null when it will do.
 */
export async function checkAlsoAllows(
  ctx: VaultContext,
  kind: PermissionKind,
  args: unknown,
  ticked: readonly string[] | undefined,
): Promise<string | null> {
  const missing = (await alsoAllowsOf(ctx, kind, args)).filter(
    (also) => !(ticked ?? []).includes(also.key),
  )

  if (missing.length === 0) {
    return null
  }

  const first = missing[0]!

  return `This also lets ${first.consumer} use your secret "${first.secretName}": tick it to agree, or answer Not now.`
}

/** After the owner's yes: what uses those secrets now stays in their scope. */
export async function keepAlsoAllowed(
  ctx: VaultContext,
  kind: PermissionKind,
  args: unknown,
): Promise<void> {
  await keepUsesInScope(
    ctx,
    namedSecrets(kind, args).map((each) => each.id),
  )
}
