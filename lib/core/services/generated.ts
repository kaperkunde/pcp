import type { PasswordRecipe } from "../constants"
import type { VaultContext } from "../context"
import { db } from "../db"
import { generatePassword } from "../generate-password"
import { createSecretNamedAfter } from "../secrets"
import { setMcpHeaderCredential } from "../servers"
import {
  generatedEnv,
  registerAuth,
  type ServiceDefinition,
  type ServiceEnvBindings,
  type ServiceGenerated,
} from "./definition"
import { GENERATED_VALUE_LENGTH } from "./limits"
import type { LoadedService } from "./services"

/**
 * The variables a service's definition marks `generated` (format 6): PCP
 * makes each one's value at launch, a random one from Node's CSPRNG
 * (generate-password.ts), and keeps it as a secret of the vault named after
 * the service, bound to the variable like a secret the owner chose. From
 * there it goes as every bound secret does: decrypted only in upstream.ts,
 * handed to the container over standard input, and sent by the server the
 * service registers when the variable is its header's (registers.auth). No
 * step of the owner's, and the value is never handed back to anyone; the
 * owner sees the secret under Secrets, and a change to it there remakes the
 * service with the new one, as a change to any secret it takes does.
 *
 * A variable the owner bound a secret of their own to keeps theirs.
 *
 * (A helper for this belongs with the secrets, `createGeneratedSecret`;
 * until it is there, this makes one the way request_secret's `generate`
 * does: a text secret whose value PCP made.)
 */

/** The recipe a `generated` variable's value is made by. */
export function generatedRecipe(generated: ServiceGenerated): PasswordRecipe {
  const own = generated === true ? {} : generated

  return {
    length: own.length ?? GENERATED_VALUE_LENGTH,
    lowercase: true,
    uppercase: true,
    digits: true,
    // Letters and digits by default: what a header or an env file takes
    // as it is.
    symbols: own.symbols ?? false,
    exclude: "",
  }
}

/**
 * Makes the secrets for the generated variables the bindings leave unbound,
 * and answers the bindings with them. Each secret's id goes into `made` as
 * soon as it exists, so a caller that fails part way (here or after) takes
 * back exactly what it made.
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
    made: string[]
  },
): Promise<ServiceEnvBindings> {
  const bound = { ...bindings }

  for (const entry of generatedEnv(definition)) {
    if (bound[entry.name]) {
      continue
    }

    const { id } = await createSecretNamedAfter(ctx, {
      base: `${service} ${entry.name}`,
      value: generatePassword(generatedRecipe(entry.generated)),
      description: `PCP made this value for ${entry.name} of the service ${service} when it was launched.`,
    })
    bound[entry.name] = id
    made.push(id)
  }

  return bound
}

/** The secrets a service made for its generated variables, as stored. */
export function readGeneratedSecrets(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : []
  } catch {
    return []
  }
}

/**
 * A service whose definition gained a generated variable since it was
 * launched (an update, a repository's change, a definition saved): its
 * value is made now, before the container is made again with its
 * variables, and kept on the service as at launch. The server it
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

  const made: string[] = []
  let env: ServiceEnvBindings

  try {
    env = await makeGeneratedSecrets(ctx, {
      service: loaded.server.name,
      definition: loaded.definition,
      bindings: loaded.env,
      made,
    })
    const spec = await db().serviceSpec.findUniqueOrThrow({
      where: { serverId: loaded.server.id },
      select: { generatedSecrets: true },
    })
    await db().serviceSpec.update({
      where: { serverId: loaded.server.id },
      data: {
        env: JSON.stringify(env),
        generatedSecrets: JSON.stringify([
          ...readGeneratedSecrets(spec.generatedSecrets),
          ...made,
        ]),
      },
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

/**
 * After a service is removed: the secrets it made for its generated
 * variables go too, unless something still sends them (the server it
 * registered, kept, or another service's variable).
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
      await dropGeneratedSecrets(ctx, [id])
    }
  }
}

/** Takes back the secrets a launch that failed made for its variables. */
export async function dropGeneratedSecrets(
  ctx: VaultContext,
  ids: string[],
): Promise<void> {
  if (ids.length > 0) {
    await db()
      .secret.deleteMany({ where: { vaultId: ctx.vaultId, id: { in: ids } } })
      .catch(() => {})
  }
}
