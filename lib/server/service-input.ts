import type { VaultContext } from "@/lib/core/context"
import { invalid } from "@/lib/core/errors"
import { createSecret, deleteSecret } from "@/lib/core/secrets"

import { field, fields } from "./action-state"

/**
 * A service's own part as the launch form sends it
 * (components/service-form.tsx): its name, the SSH server, where its ports
 * are published, the secret each variable takes, and the owner's note.
 */
export function serviceInputFrom(formData: FormData) {
  const exitName = field(formData, "exit.name")

  return {
    name: field(formData, "name"),
    hostId: field(formData, "hostId"),
    publish: publishFrom(formData),
    env: envFrom(formData),
    values: valuesFrom(formData),
    // An exit's service: the exit PCP adds for it.
    ...(exitName
      ? { exit: { name: exitName, label: field(formData, "exit.label") } }
      : {}),
    note: field(formData, "note") || null,
  }
}

/** What was typed for the plain variables, as value.<NAME> fields. */
export function valuesFrom(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {}

  for (const [key, value] of formData.entries()) {
    if (key.startsWith("value.") && typeof value === "string" && value) {
      values[key.slice(6)] = value
    }
  }

  return values
}

/**
 * The new secrets typed in on the launch form, by the variable that takes
 * each (env.<NAME> set to NEW_SECRET, with newSecret.<NAME>.name and
 * .value beside it).
 */
export function newSecretsFrom(
  formData: FormData,
): Array<{ variable: string; name: string; value: string }> {
  const made: Array<{ variable: string; name: string; value: string }> = []

  for (const [key, value] of formData.entries()) {
    if (key.startsWith("env.") && value === NEW_SECRET) {
      const variable = key.slice(4)
      const name = field(formData, `newSecret.${variable}.name`)
      const secret = formData.get(`newSecret.${variable}.value`)

      if (!name || typeof secret !== "string" || !secret) {
        throw invalid(`Give the new secret for ${variable} a name and a value.`)
      }

      made.push({ variable, name, value: secret })
    }
  }

  return made
}

/** The launch form's choice that types a new secret in (service-form.tsx). */
export const NEW_SECRET = "__new__"

/** The variables' secrets, as env.<NAME> fields: the empty ones left out. */
export function envFrom(formData: FormData): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of formData.entries()) {
    if (
      key.startsWith("env.") &&
      typeof value === "string" &&
      value &&
      value !== NEW_SECRET
    ) {
      env[key.slice(4)] = value
    }
  }

  return env
}

export function publishFrom(formData: FormData) {
  const containers = fields(formData, "port.container")
  const hosts = fields(formData, "port.host")

  return {
    address: field(formData, "address"),
    ports: containers.map((container, at) => {
      const host = Number(hosts[at])
      if (!Number.isInteger(host)) {
        throw invalid(`Choose the SSH server's port for port ${container}.`)
      }
      return { container: Number(container), host }
    }),
  }
}

/**
 * Runs a launch with the new secrets typed in on its form saved first and
 * bound to their variables; when the launch fails, they are deleted again.
 */
export async function withNewSecrets<T>(
  ctx: VaultContext,
  formData: FormData,
  env: Record<string, string>,
  launch: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const made: string[] = []

  try {
    const bound = { ...env }

    for (const secret of newSecretsFrom(formData)) {
      const { id } = await createSecret(ctx, {
        name: secret.name,
        value: secret.value,
      })
      made.push(id)
      bound[secret.variable] = id
    }

    return await launch(bound)
  } catch (error) {
    for (const id of made) {
      await deleteSecret(ctx, id).catch(() => {})
    }

    throw error
  }
}
