import type { PasswordRecipe } from "../constants"
import type { VaultContext } from "../context"
import { db } from "../db"
import { generatePassword } from "../generate-password"
import { createSecretNamedAfter } from "../secrets"
import {
  generatedEnv,
  type ServiceDefinition,
  type ServiceEnvBindings,
  type ServiceGenerated,
} from "./definition"
import { GENERATED_VALUE_LENGTH } from "./limits"

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
 * and answers the bindings with them, and the secrets made (for a launch
 * that fails to take back).
 */
export async function makeGeneratedSecrets(
  ctx: VaultContext,
  {
    service,
    definition,
    bindings,
  }: {
    service: string
    definition: ServiceDefinition
    bindings: ServiceEnvBindings
  },
): Promise<{ bindings: ServiceEnvBindings; made: string[] }> {
  const bound = { ...bindings }
  const made: string[] = []

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

  return { bindings: bound, made }
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
