import type { PasswordRecipe } from "../constants"
import { DEFAULT_TOKEN_RECIPE } from "../constants"
import type { VaultContext } from "../context"
import { db } from "../db"
import {
  createGeneratedSecret,
  deleteManagedSecret,
  generatedSecretName,
  takeBackGenerated,
} from "../secrets"
import { blockingUses, secretUses } from "../secret-uses"
import { isPcpError, PcpError } from "../errors"
import {
  generatedEnv,
  type ServiceDefinition,
  type ServiceEnvBindings,
  type ServiceGenerated,
} from "./definition"
import type { LoadedService } from "./services"

/**
 * The variables a service's definition marks `generated` (format 6): PCP
 * makes each one's value, a managed `generated` secret of the vault
 * (secrets.ts createGeneratedSecret: the CSPRNG, stored at once, never
 * revealed or renamed, never named by an assistant), named
 * "<service>/<VARIABLE>" (generatedSecretName) and bound to the variable.
 * From there it goes as every bound secret does: decrypted only in
 * upstream.ts, handed to the container over standard input, and sent by
 * the server the service registers when the variable is its header's
 * (registers.auth). No step of the owner's, and no choice of theirs: the
 * launch form, the review and the service's page show it as made by PCP.
 *
 * Each is the service's own, bound to it by id: a variable already bound
 * keeps its value (a remake), and one made now is always a new secret. A
 * name that is taken (a service of the same name renamed since, or removed
 * with the server it registered kept, which still sends its value) gets
 * "-2", "-3", …, so two services never share a token. Only what this call
 * made is taken back when a launch fails (takeBackGenerated). Removing the
 * service removes them, unless something still sends one.
 */

/** How many names a new value tries before PCP gives up. */
const MAX_NAME_TRIES = 50

/** A value made for a variable, and whether this call made it. */
export type MadeSecret = { id: string; created: boolean }

/** The recipe a `generated` variable's value is made by. */
export function generatedRecipe(generated: ServiceGenerated): PasswordRecipe {
  if (generated === true) {
    return DEFAULT_TOKEN_RECIPE
  }

  return {
    ...DEFAULT_TOKEN_RECIPE,
    ...(generated.length !== undefined ? { length: generated.length } : {}),
    // Letters and digits, unless the definition asks for symbols.
    ...(generated.symbols ? { format: "password", symbols: true } : {}),
  }
}

/**
 * Makes (or finds) the value for each generated variable the bindings leave
 * unbound, and answers the bindings with them and the variables so bound.
 * Each secret goes into `made` as soon as it exists, so a caller that fails
 * part way (here or after) takes back exactly what it made.
 */
export async function makeGeneratedSecrets(
  ctx: VaultContext,
  {
    service,
    definition,
    bindings,
    made,
  }: {
    service: string
    definition: ServiceDefinition
    bindings: ServiceEnvBindings
    made: MadeSecret[]
  },
): Promise<{ bindings: ServiceEnvBindings; generated: string[] }> {
  const bound = { ...bindings }
  const generated: string[] = []

  for (const entry of generatedEnv(definition)) {
    if (bound[entry.name]) {
      continue
    }

    const id = await newGeneratedSecret(ctx, {
      service,
      variable: entry.name,
      recipe: generatedRecipe(entry.generated),
    })
    made.push({ id, created: true })
    bound[entry.name] = id
    generated.push(entry.name)
  }

  return { bindings: bound, generated }
}

/**
 * A new generated secret for one variable of one service: never one that
 * exists already under that name (another service's, or one a kept server
 * still sends), whose value would then be shared; the name gets "-2", "-3",
 * … until it is free.
 */
async function newGeneratedSecret(
  ctx: VaultContext,
  {
    service,
    variable,
    recipe,
  }: { service: string; variable: string; recipe: PasswordRecipe },
): Promise<string> {
  // Room for the "-n" a taken name gets, within a name's length.
  const thing = service.slice(0, 60)

  for (let n = 1; n <= MAX_NAME_TRIES; n++) {
    const name = generatedSecretName(
      thing,
      n === 1 ? variable : `${variable}-${n}`,
    )
    let secret: { id: string; created: boolean }

    try {
      secret = await createGeneratedSecret(ctx, {
        name,
        recipe,
        description: `PCP made this value for ${variable} of the service ${service}.`,
      })
    } catch (error) {
      // A secret of the owner's by that name: the next one.
      if (isPcpError(error) && error.code === "conflict") {
        continue
      }

      throw error
    }

    if (secret.created) {
      return secret.id
    }
  }

  throw new PcpError(
    "conflict",
    `PCP could not find a free name for the value of ${variable} of ${service}: rename or remove some of the secrets named after it.`,
  )
}

/** Takes back what a launch that failed made for its variables. */
export async function dropGeneratedSecrets(
  ctx: VaultContext,
  made: MadeSecret[],
): Promise<void> {
  await takeBackGenerated(ctx, made).catch(() => {})
}

/**
 * A service whose definition gained a generated variable since it was
 * launched (an update, a repository's change, a definition saved): its
 * value is made now, on a way in that may make the container again
 * (upstream.ts serviceAccess with bindGenerated), and bound on the service
 * as at launch; `loaded` takes the binding in place, so the remake hands
 * it to the container. The server it registered moves to it only when the
 * container is made with it (services.ts followRegisteredAuth), never
 * before. Nothing happens when every generated variable has a secret.
 */
export async function bindGeneratedEnv(
  ctx: VaultContext,
  loaded: LoadedService,
): Promise<LoadedService> {
  const missing = generatedEnv(loaded.definition).filter(
    (entry) => !loaded.env[entry.name],
  )

  if (missing.length === 0) {
    return loaded
  }

  const made: MadeSecret[] = []
  let env: ServiceEnvBindings

  try {
    env = (
      await makeGeneratedSecrets(ctx, {
        service: loaded.server.name.replace(/ service$/, ""),
        definition: loaded.definition,
        bindings: loaded.env,
        made,
      })
    ).bindings
    await db().serviceSpec.update({
      where: { serverId: loaded.server.id },
      data: { env: JSON.stringify(env) },
    })
  } catch (error) {
    await dropGeneratedSecrets(ctx, made)
    throw error
  }

  loaded.env = env
  return loaded
}

/** The values PCP made that a service's variables take: its generated ones. */
export async function generatedSecretsOf(
  ctx: VaultContext,
  bindings: ServiceEnvBindings,
): Promise<string[]> {
  const ids = [...new Set(Object.values(bindings))]

  return (
    await db().secret.findMany({
      where: { vaultId: ctx.vaultId, id: { in: ids }, kind: "generated" },
      select: { id: true },
    })
  ).map((secret) => secret.id)
}

/**
 * After a service is removed: the values PCP made for its variables go too
 * (deleteManagedSecret), unless something still uses one (secret-uses.ts,
 * the one list of uses: the server it registered, kept, another service's
 * variable, a wrapper's place). While a wrapper's definition does not read,
 * its uses are unknown, so nothing is dropped then.
 */
export async function dropUnusedGeneratedSecrets(
  ctx: VaultContext,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) {
    return
  }

  const report = { unread: 0 }
  const usage = await secretUses(ctx, ids, report)

  if (report.unread > 0) {
    return
  }

  for (const id of ids) {
    if (
      usage.has(id) &&
      blockingUses(usage.get(id), "generated").length === 0
    ) {
      await deleteManagedSecret(ctx, id)
    }
  }
}
