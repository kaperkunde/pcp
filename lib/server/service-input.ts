import { invalid } from "@/lib/core/errors"

import { field, fields } from "./action-state"

/**
 * A service's own part as the launch form sends it
 * (components/service-form.tsx): its name, the SSH server, where its ports
 * are published, the secret each variable takes, and the owner's note.
 */
export function serviceInputFrom(formData: FormData) {
  return {
    name: field(formData, "name"),
    hostId: field(formData, "hostId"),
    publish: publishFrom(formData),
    env: envFrom(formData),
    note: field(formData, "note") || null,
  }
}

/** The variables' secrets, as env.<NAME> fields: the empty ones left out. */
export function envFrom(formData: FormData): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of formData.entries()) {
    if (key.startsWith("env.") && typeof value === "string" && value) {
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
