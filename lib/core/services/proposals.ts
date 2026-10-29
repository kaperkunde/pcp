import type { VaultContext } from "../context"
import { db } from "../db"
import { definitionBasis } from "../definitions"
import { invalid, PcpError } from "../errors"
import type { ShownText } from "../permission-rules"
import { checkPersonalNote, setPersonalNote } from "../personal-notes"
import {
  createSecretNamedAfter,
  deleteSecret,
  findTextSecretByName,
  validateSecretName,
} from "../secrets"
import { getServer, normalizeNameAndDescription } from "../servers"
import { parseSshAddress } from "../ssh/hosts"
import {
  parsePublish,
  parseServiceDefinition,
  reachUrl,
  type ServiceDefinition,
  type ServicePublish,
} from "./definition"
import { serviceOfDefinition, type ServiceLaunchInput } from "./services"

/**
 * A service an assistant proposes (register_server, kind "service"): a
 * permission request (`service_change`) that shows the owner everything
 * that would run, in full (the image by digest and where it updates from,
 * the ports and the SSH server's address they are published on, every
 * variable and the secret it takes, by name, the volumes, arguments, health
 * check and what PCP adds for it, and the SSH server), and launches nothing
 * until they agree. The owner approves what they were shown, or declines.
 *
 * Everything is checked before they are asked: the definition as the
 * owner's own launch checks it, the SSH server (one this token sees, whose
 * host key the owner pinned), the publish address against the definition,
 * and that PCP can reach what it registers. Secrets are named, never sent:
 * one the vault holds as a text secret is reused; one new name at most is
 * typed in by the owner on PCP's page, and its value never reaches the
 * assistant. Another instance of a service definition the token sees
 * (`definition`) is launched on that definition only while it is as the
 * owner was shown it (definitions.ts definitionBasis).
 */

/** One variable of the proposal and the secret it takes, by name. */
export type ProposedVariable = {
  name: string
  /** The secret's name; null for none (its fixed value, or nothing). */
  secret: string | null
  /** The vault's secret it is, when it holds one by that name. */
  secretId: string | null
}

export type ServiceChangeAsk = {
  name: string
  description: string
  definition: ServiceDefinition
  /** Another instance of a service definition, as the owner was shown it. */
  instanceOf?: {
    definitionId: string
    name: string
    basis: string
    instances: string[]
  }
  host: { id: string; name: string; address: string }
  publish: ServicePublish
  env: ProposedVariable[]
  /** A secret PCP does not hold yet, which the owner types in. */
  newSecret: string | null
  note: string | null
}

/** register_server's arguments for a service, as the gateway took them. */
export type ServiceProposalArgs = {
  name: string
  description?: string
  /** The definition, as an object or JSON text. */
  service?: unknown
  /** The short name of a service definition's server the token sees. */
  definition?: { id: string; name: string; basis: string; instances: string[] }
  /** The SSH server, a row of kind ssh the token sees. */
  sshServerId: string
  publishAddress?: string
  publishPorts?: Array<{ container: number; host: number }>
  envSecrets?: Array<{ name: string; secret: string }>
  note?: string
}

/**
 * The request the owner is asked, checked as far as it can be before they
 * are: refused here with what to change, never on their page.
 */
export async function prepareServiceProposal(
  ctx: VaultContext,
  args: ServiceProposalArgs,
): Promise<ServiceChangeAsk> {
  const note = checkPersonalNote(args.note)
  let definition: ServiceDefinition
  let description: string

  if (args.definition) {
    const shared = await serviceOfDefinition(ctx, args.definition.id)
    definition = shared.definition
    description = shared.description
  } else {
    let value = args.service

    if (typeof value === "string") {
      try {
        value = JSON.parse(value)
      } catch {
        throw invalid("service is the definition as JSON: it does not parse.")
      }
    }

    definition = parseServiceDefinition(value)
    description = args.description ?? ""
  }

  // An exit is the owner's alone to add (lib/core/exits/): an assistant
  // names one in its calls, never makes one.
  if (definition.registers.kind === "exit") {
    throw invalid(
      "This service would add an exit (a VPN's way out), which only the owner adds, on their SSH server's page in PCP. Ask them to add it there.",
    )
  }

  const named = normalizeNameAndDescription({ name: args.name, description })
  const host = await db().mcpServer.findFirst({
    where: { id: args.sshServerId, vaultId: ctx.vaultId, kind: "ssh" },
  })

  if (!host) {
    throw invalid("ssh_server names one of the owner's SSH servers.")
  }

  if (!host.sshHostKey) {
    throw new PcpError(
      "state",
      `PCP has not pinned ${host.name}'s host key yet, so it runs nothing there: the owner checks the server on its page first, then you can ask again.`,
    )
  }

  const address = parseSshAddress(host.url).host
  const publish = parsePublish(
    {
      address: args.publishAddress?.trim() || "0.0.0.0",
      ports: definition.ports.map(({ container }) => ({
        container,
        host:
          args.publishPorts?.find((entry) => entry.container === container)
            ?.host ?? container,
      })),
    },
    definition,
  )

  for (const entry of args.publishPorts ?? []) {
    if (!definition.ports.some((port) => port.container === entry.container)) {
      throw invalid(
        `publish_ports names port ${entry.container}, which the service does not publish.`,
      )
    }
  }

  if (
    definition.registers.kind !== "none" &&
    !reachUrl(publish, address, definition.registers.port)
  ) {
    throw invalid(
      `PCP reaches what the service serves at the address its port is published on, and ${publish.address} is ${host.name}'s own loopback: leave publish_address out (0.0.0.0), or name one of ${host.name}'s own addresses.`,
    )
  }

  const known = new Set(definition.env.map((entry) => entry.name))
  const given = new Map<string, string>()

  for (const entry of args.envSecrets ?? []) {
    if (!known.has(entry.name)) {
      throw invalid(`The service has no variable called ${entry.name}.`)
    }

    if (given.has(entry.name)) {
      throw invalid(`env_secrets names ${entry.name} twice.`)
    }

    given.set(entry.name, entry.secret.trim())
  }

  let newSecret: string | null = null
  const env: ProposedVariable[] = []

  for (const entry of definition.env) {
    const secretName = given.get(entry.name) ?? null
    const stored = secretName
      ? await findTextSecretByName(ctx, secretName)
      : null

    if (secretName && !stored) {
      const problem = validateSecretName(secretName)

      if (problem) {
        throw invalid(`The secret for ${entry.name}: ${problem}`)
      }

      // One new secret, typed in on PCP's page; the rest the owner holds.
      if (newSecret && newSecret !== secretName) {
        throw invalid(
          `Only one new secret can be typed in on PCP's page, and "${newSecret}" is it: name secrets the owner already stored for the others (list_secrets names them), or ask them to add "${secretName}" first.`,
        )
      }

      newSecret = secretName
    }

    if (!secretName && entry.required && entry.value === undefined) {
      throw invalid(
        `The service needs ${entry.name}: name the secret it takes in env_secrets.`,
      )
    }

    env.push({
      name: entry.name,
      secret: stored?.name ?? secretName,
      secretId: stored?.id ?? null,
    })
  }

  const auth =
    definition.registers.kind === "openapi" ? definition.registers.auth : null

  if (auth && !given.has(auth.env)) {
    throw invalid(
      `The endpoint sends ${auth.env}'s secret in ${auth.header}: name it in env_secrets.`,
    )
  }

  return {
    name: named.name,
    description: named.description,
    definition,
    ...(args.definition
      ? {
          instanceOf: {
            definitionId: args.definition.id,
            name: args.definition.name,
            basis: args.definition.basis,
            instances: args.definition.instances,
          },
        }
      : {}),
    host: { id: host.id, name: host.name, address },
    publish,
    env,
    newSecret,
    note,
  }
}

/** The definition as the owner reads it: every field, in order. */
function definitionText(definition: ServiceDefinition): string {
  return JSON.stringify(definition, null, 2)
}

/** What the owner reads on the request's page: all of it. */
export function describeServiceAsk(ask: ServiceChangeAsk): {
  title: string
  lines: string[]
  warning: string | null
  full: ShownText[]
} {
  const { definition, publish } = ask
  const registers = definition.registers
  const lines = [
    `Runs on your SSH server ${ask.host.name} (${ask.host.address}), with the Docker or Podman there`,
    `Image: ${definition.image}`,
    definition.source
      ? `Updates from: ${definition.source}, when you update it on its page`
      : "Updates: by hand only (it names no image to update from)",
    publish.ports.length > 0
      ? `Published on ${publish.address}: ${publish.ports.map((port) => `${port.host} → ${port.container}`).join(", ")}${publish.address === "0.0.0.0" || publish.address === "::" ? " (every address of the SSH server)" : ""}`
      : "Publishes no port",
    ...ask.env.map((entry) => {
      const fixed = definition.env.find(
        (each) => each.name === entry.name,
      )?.value

      return entry.secret === null
        ? `Variable ${entry.name}: ${fixed !== undefined ? `its fixed value, ${fixed}` : "not set"}`
        : entry.secretId
          ? `Variable ${entry.name}: your secret "${entry.secret}"`
          : `Variable ${entry.name}: a new secret, saved as "${entry.secret}", which you enter here when you agree`
    }),
    definition.volumes.length > 0
      ? `Named volumes (never a folder of the server): ${definition.volumes.map((volume) => `${volume.name} at ${volume.path}`).join(", ")}`
      : "No volumes: it keeps nothing when its container is made again",
    ...(definition.args.length > 0
      ? [`Arguments: ${definition.args.join(" ")}`]
      : []),
    definition.health.kind === "http"
      ? `Health check: GET ${definition.health.path} on port ${definition.health.port}`
      : "No health check",
    registers.kind === "openapi"
      ? `PCP adds an API endpoint from ${registers.specPath} on port ${registers.port}${registers.auth ? `, sending ${registers.auth.env}'s secret in ${registers.auth.header}` : ""}`
      : registers.kind === "mcp"
        ? `PCP adds an MCP server at ${registers.path} on port ${registers.port}`
        : "PCP adds no server for it",
    ...(ask.instanceOf
      ? [
          `Another service of ${ask.instanceOf.name}, beside ${ask.instanceOf.instances.join(", ") || "(none)"}: it shares their definition, so a change to it changes every one of them`,
        ]
      : []),
    "Its tools (status, logs, start, stop, restart) and what it adds ask you first, for every token, as a new server's do",
    ...(ask.note
      ? [
          `Your note on it, which every assistant that sees it reads as yours:\n${ask.note}`,
        ]
      : []),
  ]
  const secrets = ask.env.filter((entry) => entry.secret !== null)

  return {
    title: `Launch the service ${ask.name} on ${ask.host.name}?`,
    lines,
    warning: `PCP will pull ${definition.image} and run it on ${ask.host.name}${secrets.length > 0 ? `, handing it ${secrets.map((entry) => `"${entry.secret}"`).join(" and ")}` : ""}. Only agree if you trust the image.`,
    full: [{ label: "Its definition", text: definitionText(definition) }],
  }
}

export type ServiceLauncher = (
  ctx: VaultContext,
  input: ServiceLaunchInput,
) => Promise<{
  id: string
  registeredId: string | null
  message: string
}>

/**
 * The owner said yes: launches exactly what they were shown, with the
 * secret they typed in (saved under the name shown, and removed again when
 * the launch fails), and gives the token that asked what it launched.
 */
export async function applyServiceChange(
  ctx: VaultContext,
  ask: ServiceChangeAsk,
  {
    tokenId,
    secretValue,
    launch,
  }: { tokenId: string; secretValue?: string; launch: ServiceLauncher },
): Promise<string> {
  if (
    ask.instanceOf &&
    (await definitionBasis(ask.instanceOf.definitionId)) !==
      ask.instanceOf.basis
  ) {
    throw new PcpError(
      "state",
      `${ask.instanceOf.name} has changed since this was asked (or is gone), so nothing was launched. The assistant can ask again.`,
    )
  }

  let saved: { id: string; name: string } | null = null
  const env: Record<string, string> = {}

  for (const entry of ask.env) {
    if (entry.secret === null) {
      continue
    }

    let id = entry.secretId

    if (!id && entry.secret === ask.newSecret) {
      if (secretValue && !saved) {
        saved = await createSecretNamedAfter(ctx, {
          base: entry.secret,
          value: secretValue,
          description: `${entry.name} of the service ${ask.name}.`,
        })
      }

      id =
        saved?.id ?? (await findTextSecretByName(ctx, entry.secret))?.id ?? null
    }

    if (!id) {
      throw invalid(`Enter the value of the secret "${entry.secret}".`)
    }

    env[entry.name] = id
  }

  let launched: Awaited<ReturnType<ServiceLauncher>>

  try {
    launched = await launch(ctx, {
      name: ask.name,
      description: ask.description,
      hostId: ask.host.id,
      ...(ask.instanceOf
        ? { definitionId: ask.instanceOf.definitionId }
        : { definition: ask.definition }),
      publish: ask.publish,
      env,
      note: ask.note,
    })
  } catch (error) {
    // The secret was typed in for this service alone.
    if (saved) {
      await deleteSecret(ctx, saved.id).catch(() => {})
    }

    throw error
  }

  if (ask.note) {
    // launchService sets it; this keeps it when a stand-in launched.
    await setPersonalNote(ctx, "server", launched.id, ask.note).catch(() => {})
  }

  const token = await db().apiToken.findUniqueOrThrow({
    where: { id: tokenId },
    select: { allowAllServers: true },
  })

  // A token scoped to chosen servers reaches what it just launched.
  if (!token.allowAllServers) {
    for (const serverId of [launched.id, launched.registeredId]) {
      if (serverId) {
        await db().apiTokenServer.upsert({
          where: { tokenId_serverId: { tokenId, serverId } },
          create: { tokenId, serverId },
          update: {},
        })
      }
    }
  }

  const service = await getServer(ctx, launched.id)
  const registered = launched.registeredId
    ? await getServer(ctx, launched.registeredId).catch(() => null)
    : null
  const keptAs = saved
    ? ` The secret the owner entered is saved in PCP as "${saved.name}".`
    : ""

  return `${launched.message} The service is "${service.slug}" (status, logs, start, stop, restart)${registered ? `, and what it serves is "${registered.slug}" with ${registered.tools.length} tool${registered.tools.length === 1 ? "" : "s"}` : ""}. Its tools ask the owner the first time they are used; search finds them.${keptAs}`
}
