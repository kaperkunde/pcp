import type { PermissionKind } from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { siblingInstances } from "./definition-rows"
import type { RegisterArgs } from "./permissions"
import { SECRET_META_SELECT, secretName } from "./secret-meta"
import {
  consumersNow,
  grantSecretScope,
  scopeCovers,
  type SecretConsumer,
} from "./secret-scope"
import type { ServiceChangeAsk } from "./services/proposals"
import type { WrapperChangeAsk } from "./wrappers/admin"

/**
 * What an assistant's proposal, or a linked repository's item, would let
 * use one of the owner's secrets outside the secret's scope (#162,
 * secret-scope.ts): a new server's, endpoint's or account's sign-in
 * (register_server), a new service's variable, a wrapper's place for one
 * (on the wrapper and on every other instance of its definition, which a
 * change is copied to: wrappers/admin.ts shareWrapper), or what a
 * repository's item applies. Its page shows one "Also allow <secret> for
 * <consumer>" per secret and consumer, ticked; the owner's yes needs each
 * ticked, and once it is made keeps exactly those in the scope
 * (`keepAllowed`), nothing else that happens to use the secret. Nothing an
 * assistant sends ticks one.
 */
export type AlsoAllow = {
  /** "also:<secret id>:<consumer id, or new>": what the answer names. */
  key: string
  secretId: string
  secretName: string
  /** The consumer's id; null for the one the request makes. */
  consumerId: string | null
  /** What would use it, by name. */
  consumer: string
}

/** A secret a request names, and everything that would use it. */
export type NamedSecret = { id: string; consumers: SecretConsumer[] }

/**
 * A wrapper and every other instance of its definition, which get the same
 * places for secrets; for a new wrapper, the one it makes.
 */
export async function wrapperConsumers(
  ctx: VaultContext,
  wrapperId: string | null,
  name: string,
): Promise<SecretConsumer[]> {
  if (wrapperId === null) {
    return [{ id: null, name }]
  }

  const siblings = (await siblingInstances(ctx, wrapperId)).filter(
    (sibling) => sibling.kind === "wrapper",
  )

  return [
    { id: wrapperId, name },
    ...siblings.map((sibling) => ({ id: sibling.id, name: sibling.name })),
  ]
}

/** The secrets a request names that it would make something use. */
async function namedSecrets(
  ctx: VaultContext,
  kind: PermissionKind,
  args: unknown,
): Promise<NamedSecret[]> {
  if (kind === "register") {
    const asked = args as RegisterArgs
    const ids = [
      asked.authSecretId,
      asked.oauthClientSecretId,
      ...(asked.authExtraHeaders ?? []).map((extra) => extra.secretId),
    ].filter((id): id is string => typeof id === "string" && id !== "")

    return ids.map((id) => ({
      id,
      consumers: [{ id: null, name: asked.name }],
    }))
  }

  if (kind === "service_change") {
    const asked = args as Partial<ServiceChangeAsk>

    // An image update names no secret.
    if (!Array.isArray(asked.env)) {
      return []
    }

    return asked.env.flatMap((variable) =>
      variable.secretId
        ? [
            {
              id: variable.secretId,
              consumers: [{ id: null, name: asked.name! }],
            },
          ]
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

    const consumers = await wrapperConsumers(
      ctx,
      asked.action === "update" ? asked.serverId : null,
      asked.name,
    )

    return asked.definition.secrets.flatMap((binding) =>
      binding.secretId ? [{ id: binding.secretId, consumers }] : [],
    )
  }

  return []
}

/**
 * Each secret and consumer of `named` the secret's scope does not cover,
 * once each, with the secret's name as the vault has it now.
 */
export async function alsoAllowsFor(
  ctx: VaultContext,
  named: readonly NamedSecret[],
): Promise<AlsoAllow[]> {
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

    if (!name) {
      continue
    }

    for (const consumer of each.consumers) {
      const key = `also:${each.id}:${consumer.id ?? "new"}`

      if (
        found.some((also) => also.key === key) ||
        (await scopeCovers(ctx, each.id, consumer.id))
      ) {
        continue
      }

      found.push({
        key,
        secretId: each.id,
        secretName: name,
        consumerId: consumer.id,
        consumer: consumer.name,
      })
    }
  }

  return found
}

/** What a pending request would also allow, as its page shows it. */
export async function alsoAllowsOf(
  ctx: VaultContext,
  kind: PermissionKind,
  args: unknown,
): Promise<AlsoAllow[]> {
  return alsoAllowsFor(ctx, await namedSecrets(ctx, kind, args))
}

/**
 * The owner's answer to what also allows secrets: each shown has to be
 * ticked, or nothing is made. Null when it will do.
 */
export function missingAlsoAllow(
  shown: readonly AlsoAllow[],
  ticked: readonly string[] | undefined,
): string | null {
  const missing = shown.filter((also) => !(ticked ?? []).includes(also.key))

  if (missing.length === 0) {
    return null
  }

  const first = missing[0]!

  return `This also lets ${first.consumer} use your secret "${first.secretName}": tick it to agree, or answer Not now.`
}

/** checkAlsoAllows for a pending request. */
export async function checkAlsoAllows(
  ctx: VaultContext,
  kind: PermissionKind,
  args: unknown,
  ticked: readonly string[] | undefined,
): Promise<string | null> {
  return missingAlsoAllow(await alsoAllowsOf(ctx, kind, args), ticked)
}

/**
 * Before the owner's yes runs: what the request would also allow, and what
 * uses those secrets now, so `keepAllowed` can tell what it made.
 */
export async function beforeAllowing(
  ctx: VaultContext,
  shown: AlsoAllow[],
): Promise<{ shown: AlsoAllow[]; before: Map<string, Set<string>> }> {
  return {
    shown,
    before: await consumersNow(
      ctx,
      shown.map((also) => also.secretId),
    ),
  }
}

/**
 * Once the yes made what it proposed: exactly what the owner ticked, kept
 * in each secret's scope. A consumer it names by id is granted; the one it
 * makes ("new") is whatever uses the secret now that did not before.
 * Nothing else that uses the secret is kept.
 */
export async function keepAllowed(
  ctx: VaultContext,
  { shown, before }: { shown: AlsoAllow[]; before: Map<string, Set<string>> },
  ticked: readonly string[] | undefined,
): Promise<void> {
  const chosen = shown.filter((also) => (ticked ?? []).includes(also.key))

  if (chosen.length === 0) {
    return
  }

  const after = await consumersNow(
    ctx,
    chosen.map((also) => also.secretId),
  )

  for (const also of chosen) {
    const ids =
      also.consumerId !== null
        ? [also.consumerId]
        : [...(after.get(also.secretId) ?? [])].filter(
            (id) => !(before.get(also.secretId)?.has(id) ?? false),
          )

    for (const id of ids) {
      await grantSecretScope(ctx, also.secretId, id)
    }
  }
}
