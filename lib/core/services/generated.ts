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
import { setMcpHeaderCredential } from "../servers"
import {
  generatedEnv,
  registerAuth,
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
 * Made once per name: a remake, or a variable already bound, keeps it
 * (`created: false`); only what this call made is taken back when a launch
 * fails (takeBackGenerated). Removing the service removes them, unless
 * something still sends one.
 */

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

    const secret = await createGeneratedSecret(ctx, {
      name: generatedSecretName(service, entry.name),
      recipe: generatedRecipe(entry.generated),
      description: `PCP made this value for ${entry.name} of the service ${service}.`,
    })
    made.push({ id: secret.id, created: secret.created })
    bound[entry.name] = secret.id
    generated.push(entry.name)
  }

  return { bindings: bound, generated }
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
 * value is made now, before the container is made again with its
 * variables, and bound on the service as at launch. The server it
 * registered sends it when it is that server's header. Nothing happens
 * when every generated variable has a secret already.
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

  const auth = registerAuth(loaded.definition.registers)

  if (
    auth &&
    loaded.definition.registers.kind === "mcp" &&
    loaded.spec.registeredId &&
    missing.some((entry) => entry.name === auth.env)
  ) {
    await setMcpHeaderCredential(ctx, loaded.spec.registeredId, {
      headerName: auth.header,
      valueTemplate: auth.template,
      secretId: env[auth.env]!,
    })
  }

  return { ...loaded, env }
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
 * (deleteManagedSecret), unless something still sends one (the server it
 * registered, kept, or another service of the same name's variable).
 */
export async function dropUnusedGeneratedSecrets(
  ctx: VaultContext,
  ids: string[],
): Promise<void> {
  for (const id of ids) {
    const [servers, specs] = await Promise.all([
      db().mcpServer.count({
        where: { vaultId: ctx.vaultId, authSecretId: id },
      }),
      db().serviceSpec.count({
        where: { server: { vaultId: ctx.vaultId }, env: { contains: id } },
      }),
    ])

    if (servers === 0 && specs === 0) {
      await deleteManagedSecret(ctx, id)
    }
  }
}
