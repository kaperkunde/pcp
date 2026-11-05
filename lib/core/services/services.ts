import type { Duplex } from "node:stream"

import type { CallToolResult } from "@modelcontextprotocol/server"

import type { McpServer, ServiceSpec } from "@/lib/generated/prisma/client"

import { storeTools, type SyncResult } from "../catalogue"
import type { VaultContext } from "../context"
import { db } from "../db"
import {
  definitionForNew,
  ensureDefinition,
  forgetUnusedDefinition,
  shareDescription,
  siblingInstances,
} from "../definition-rows"
import { createEndpoint } from "../endpoints"
import { invalid, isPcpError, notFound, PcpError } from "../errors"
import { forgetExitAnswers } from "../exits/dial"
import { DOH_RESOLVERS } from "../exits/doh"
import { checkNewExit, createServiceExit } from "../exits/exits"
import { httpConnect, socks5Connect, type ProxyAuth } from "../exits/handshake"
import { newId } from "../ids"
import { errorToolResult, jsonToolResult } from "../json-result"
import { argumentsResult, familyError } from "../tools/family"
import { readCapped } from "../openapi/http"
import { makeRedactor } from "../openapi/redact"
import { send, type SendOptions } from "../openapi/transport"
import { markdownLink } from "../owner-link"
import { checkPersonalNote, setPersonalNote } from "../personal-notes"
import { writeManagedSecret } from "../secrets"
import {
  createServer,
  deleteServer,
  getServer,
  normalizeNameAndDescription,
  setServerStatus,
  slugify,
  uniqueSlug,
} from "../servers"
import { parseSshAddress } from "../ssh/hosts"
import {
  checkEnvBindings,
  checkPlainValues,
  EXIT_PUBLISH_ADDRESS,
  parsePublish,
  parseServiceDefinition,
  readEnvBindings,
  readPlainValues,
  readPublish,
  readReach,
  readServiceDefinition,
  serviceDefinitionHash,
  serviceOrigin,
  tunnelAddress,
  volumeOnHost,
  type ServiceDefinition,
  type ServiceEnvBindings,
  type ServicePlainValues,
  type ServicePublish,
  type ServiceReach,
} from "./definition"
import {
  CONTAINER_NAME,
  containerAction,
  containerLogs,
  detectEngine,
  EngineError,
  existingVolumes,
  inspectContainer,
  pullImage,
  removeContainer,
  resolveDigest,
  runContainer,
  type ContainerAction,
  type ContainerState,
  type ServiceEngine,
  type ServiceEnv,
  type ServiceHost,
} from "./engine"
import {
  HEALTH_BODY_BYTES,
  HEALTH_INTERVAL_MS,
  HEALTH_REQUEST_TIMEOUT_MS,
  HEALTH_WAIT_MS,
  SERVICE_RECONCILE_BUDGET_MS,
  SERVICE_RECONCILE_INTERVAL_MS,
  START_ON_DEMAND_WAIT_MS,
} from "./limits"
import { readServiceCall, SERVICE_TOOL_NAMES, serviceTools } from "./tools"

/**
 * Services: containers PCP runs with the owner's own Docker or Podman, on
 * an SSH server PCP already holds, through the engine's command line over
 * SSH exec (services/engine.ts). PCP never installs an engine and never
 * reaches one's socket.
 *
 * A service is a server row of kind "service" (its tools: status, logs,
 * start, stop, restart) with a service_spec beside it: the definition its
 * instances share (image by digest, ports, variable names, volumes, health
 * check, what it registers) and the instance's own part (the SSH server,
 * the engine found there, the container's name, where its ports are
 * published, which secret each variable takes). Launching one starts the
 * container, waits for it to be healthy and registers what it serves, an
 * API endpoint or an MCP server, in the same step; anything that fails
 * takes back what was done.
 *
 * PCP reaches what a service publishes through the SSH connection (`reach`
 * "tunnel"): a direct-tcpip channel to the address its ports are bound to
 * on the SSH server, its loopback unless the owner chose its network, for
 * calls and health checks alike (serviceDial), so it works when PCP runs
 * in a container on that same machine. A service launched before reaches
 * it directly ("direct") until it is updated or made again.
 *
 * What the owner asked of it last is kept (`intendedState`): stopping it,
 * by the owner or an assistant's stop, is "stopped"; starting, restarting,
 * launching or making it again is "running". While it is "running", a
 * call to what it serves that finds its container stopped starts it in the
 * same request and tries once more (startOnDemand), and the reconcile pass
 * after a request brings it back up (reconcileServicesWith): never on a
 * timer, and never with a key kept between requests.
 *
 * Only the owner launches, changes and removes one. Nothing here reads a
 * secret: upstream.ts builds the ServiceAccess (a way to run commands on the
 * SSH server, and the variables' values) and hands it in. Status is read
 * only inside a request: the service's page, a call, check_server.
 */

export const SERVICE_URL = "pcp:service"

/** What upstream.ts hands in: the SSH server to run commands on, the values. */
export type ServiceAccess = {
  host: ServiceHost
  env: ServiceEnv
  /**
   * A connection to a port on the SSH server's own loopback, through the
   * SSH connection: how PCP reaches an exit's proxy, which is published
   * there and nowhere else.
   */
  loopback?: (port: number, signal?: AbortSignal) => Promise<Duplex>
  /**
   * A direct-tcpip channel through the SSH connection to an address and
   * port as the SSH server reaches them: how PCP reaches what a service
   * publishes, its port checked first (serviceDial).
   */
  forward?: ServiceForward
  /**
   * An exit's proxy login (registers.auth), which PCP made: handed to the
   * container among the variables, and used here for its health check.
   */
  proxyAuth?: ProxyAuth
  /** Waiting for health; tests shorten it. */
  timing?: { waitMs: number; intervalMs: number }
}

/** A channel through the SSH connection, as the SSH server reaches the address. */
export type ServiceForward = (
  address: string,
  port: number,
  signal?: AbortSignal,
) => Promise<Duplex>

/** What the owner asked of a service last. */
export type ServiceIntent = "running" | "stopped"

/** The user name of an exit's proxy; its password is random, per instance. */
export const EXIT_PROXY_USER = "pcp"

/** The managed secret that keeps an exit service's proxy password. */
export function proxySecretName(serviceId: string): string {
  return `proxy/${serviceId}`
}

export type LoadedService = {
  server: McpServer
  spec: ServiceSpec
  definition: ServiceDefinition
  publish: ServicePublish
  env: ServiceEnvBindings
  /** What the owner typed for its plain variables. */
  values: ServicePlainValues
  engine: ServiceEngine
  /** How PCP reaches what it publishes. */
  reach: ServiceReach
  /** What the owner asked of it last. */
  intent: ServiceIntent
  /** The SSH server it runs on; null once that was deleted. */
  host: McpServer | null
}

function engineOf(value: string): ServiceEngine {
  return value === "podman" ? "podman" : "docker"
}

/** A service of this vault, with its spec read. */
export async function loadService(
  ctx: VaultContext,
  id: string,
): Promise<LoadedService> {
  const server = await db().mcpServer.findFirst({
    where: { id, vaultId: ctx.vaultId, kind: "service" },
    include: { serviceSpec: { include: { host: true } } },
  })

  if (!server?.serviceSpec) {
    throw notFound("That service")
  }

  const { serviceSpec: spec, ...row } = server
  const { host, ...bare } = spec

  return {
    server: row,
    spec: bare,
    definition: readServiceDefinition(spec.definition),
    publish: readPublish(spec.publish),
    env: readEnvBindings(spec.env),
    values: readPlainValues(spec.plainValues),
    engine: engineOf(spec.engine),
    reach: readReach(spec.reach),
    intent: spec.intendedState === "stopped" ? "stopped" : "running",
    host: host && host.vaultId === ctx.vaultId ? host : null,
  }
}

/**
 * How a request reaches what a tunnelled service publishes: a channel
 * through the SSH connection to the address its ports are bound to on the
 * SSH server, for one of its published ports only, whatever the URL's host
 * (the loopback, the published address or the SSH server's own name: what
 * its server was registered with, before or since tunnels). Nothing else on
 * the SSH server is reached this way.
 */
export function serviceDial(
  publish: ServicePublish,
  sshHost: string,
  forward: ServiceForward,
): NonNullable<SendOptions["dial"]> {
  const target = tunnelAddress(publish)
  const names = new Set(
    ["127.0.0.1", "::1", "localhost", publish.address, target, sshHost].map(
      (name) => name.toLowerCase(),
    ),
  )
  const ports = new Set(publish.ports.map((entry) => entry.host))

  return (host, port, signal) => {
    if (!names.has(host.toLowerCase()) || !ports.has(port)) {
      return Promise.reject(
        new Error(
          `PCP reaches only the ports the service publishes on its SSH server, not ${host}:${port}.`,
        ),
      )
    }

    return forward(target, port, signal)
  }
}

/** The service that registered this server, if one did. */
export async function serviceBehind(
  ctx: VaultContext,
  serverId: string,
): Promise<LoadedService | null> {
  const spec = await db().serviceSpec.findFirst({
    where: { registeredId: serverId, server: { vaultId: ctx.vaultId } },
    select: { serverId: true },
  })

  return spec ? loadService(ctx, spec.serverId) : null
}

/** The services whose variables take this secret. */
export async function servicesUsingSecret(
  ctx: VaultContext,
  secretId: string,
): Promise<string[]> {
  const specs = await db().serviceSpec.findMany({
    where: { server: { vaultId: ctx.vaultId }, env: { contains: secretId } },
    select: { serverId: true, env: true },
  })

  return specs
    .filter((spec) =>
      Object.values(readEnvBindings(spec.env)).includes(secretId),
    )
    .map((spec) => spec.serverId)
}

function pageOf(serverId: string, publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/servers/${serverId}`
}

function sshHostOf(host: McpServer): string {
  return parseSshAddress(host.url).host
}

// ---- Launching ---------------------------------------------------------------

export type ServiceLaunchInput = {
  name: string
  description?: string
  /** The SSH server to run it on. */
  hostId: string
  /** The definition, as JSON text or a value; left out with definitionId. */
  definition?: unknown
  /** Another instance of this service definition: its definition is taken. */
  definitionId?: string | null
  publish: unknown
  /** Which secret (by id) each variable takes. */
  env: ServiceEnvBindings
  /** What the owner typed for the definition's plain variables. */
  values?: ServicePlainValues
  /** An exit's service: the exit PCP adds for it, named by the owner. */
  exit?: { name: string; label?: string } | null
  note?: string | null
}

export type PreparedLaunch = {
  name: string
  description: string
  note: string | null
  host: McpServer
  definition: ServiceDefinition
  definitionId: string | null
  publish: ServicePublish
  env: ServiceEnvBindings
  values: ServicePlainValues
  /** The exit PCP adds for an exit's service, checked free. */
  exit: { name: string; label: string } | null
  containerName: string
}

/**
 * Everything about a launch that can be checked before anything connects:
 * the SSH server, the definition, where it is published, the secrets (the
 * vault's own text secrets), and that PCP can reach what it registers.
 */
export async function prepareLaunch(
  ctx: VaultContext,
  input: ServiceLaunchInput,
): Promise<PreparedLaunch> {
  const { name, description } = normalizeNameAndDescription(input)
  const note = checkPersonalNote(input.note)
  const host = await db().mcpServer.findFirst({
    where: { id: input.hostId, vaultId: ctx.vaultId },
  })

  if (!host || host.kind !== "ssh") {
    throw invalid("Choose one of your SSH servers to run the service on.")
  }

  let definitionId: string | null = null
  let definition: ServiceDefinition

  if (input.definitionId) {
    const shared = await serviceOfDefinition(ctx, input.definitionId)
    definitionId = shared.id
    definition = shared.definition
  } else {
    let value = input.definition

    if (typeof value === "string") {
      try {
        value = JSON.parse(value)
      } catch {
        throw invalid("The service's definition is not JSON.")
      }
    }

    definition = parseServiceDefinition(value)
  }

  const publish = parsePublish(input.publish, definition)
  const values = checkPlainValues(input.values ?? {}, definition)
  const env = checkEnvBindings(input.env, definition, values)
  const ids = [...new Set(Object.values(env))]
  const secrets = await db().secret.findMany({
    where: { vaultId: ctx.vaultId, id: { in: ids } },
    select: { id: true, kind: true, name: true },
  })

  for (const id of ids) {
    const secret = secrets.find((row) => row.id === id)

    if (!secret) {
      throw notFound("A secret chosen for the service")
    }

    if (secret.kind !== "text") {
      throw invalid(
        `${secret.name} is not a text secret: a service's variable takes one you typed in.`,
      )
    }
  }

  let exit: PreparedLaunch["exit"] = null

  if (definition.registers.kind === "exit") {
    if (!input.exit?.name?.trim()) {
      throw invalid(
        "Name the exit PCP adds for the service: assistants name it in their calls.",
      )
    }

    exit = await checkNewExit(ctx, input.exit)
  } else if (input.exit) {
    throw invalid("Only a service whose definition registers an exit adds one.")
  }

  return {
    name,
    description,
    note,
    host,
    definition,
    definitionId,
    publish,
    env,
    values,
    exit,
    containerName: await containerNameFor(ctx, host.id, name),
  }
}

/**
 * A service definition of the vault, as another instance of it is launched:
 * its name, description and definition (its oldest instance's, which every
 * instance shares).
 */
export async function serviceOfDefinition(
  ctx: VaultContext,
  definitionId: string,
): Promise<{
  id: string
  name: string
  description: string
  definition: ServiceDefinition
}> {
  const shared = await definitionForNew(ctx, definitionId, "service")
  const source = await db().serviceSpec.findFirst({
    where: { server: { definitionId: shared.id, vaultId: ctx.vaultId } },
    orderBy: { createdAt: "asc" },
  })

  if (!source) {
    throw notFound("That service definition")
  }

  return {
    id: shared.id,
    name: shared.name,
    description: shared.description,
    definition: readServiceDefinition(source.definition),
  }
}

/** pcp-<name>, not taken by another of the vault's services on that host. */
async function containerNameFor(
  ctx: VaultContext,
  hostId: string,
  name: string,
): Promise<string> {
  const base = `pcp-${(slugify(name) || "service").slice(0, 50)}`
  const taken = new Set(
    (
      await db().serviceSpec.findMany({
        where: { hostId, server: { vaultId: ctx.vaultId } },
        select: { containerName: true },
      })
    ).map((spec) => spec.containerName),
  )

  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`

    if (!taken.has(candidate) && CONTAINER_NAME.test(candidate)) {
      return candidate
    }
  }
}

export type LaunchResult = {
  id: string
  /** The API endpoint or MCP server it registered. */
  registeredId: string | null
  registeredKind: "openapi" | "mcp" | null
  /** The exit it added, for an exit's service. */
  exitId?: string | null
}

/**
 * Starts the service and registers what it serves, in one step: finds the
 * engine, pulls the image, runs the container with the variables over
 * standard input, waits for it to be healthy, then makes the service's own
 * server and the endpoint or MCP server. A failure past the container's
 * start removes the container, its volumes and anything made, and says so.
 */
export async function launchServiceOn(
  ctx: VaultContext,
  prepared: PreparedLaunch,
  access: ServiceAccess,
): Promise<LaunchResult> {
  const { host, env } = access
  const found = await engineCall(() => detectEngine(host))
  const id = newId()
  const spec = {
    serviceId: id,
    containerName: prepared.containerName,
    definition: prepared.definition,
    publish: prepared.publish,
  }

  // Nothing is on the SSH server yet that a failure here would leave.
  await engineCall(() =>
    pullImage(host, found.engine, prepared.definition.image),
  )

  // Volumes there already (a service removed before, its data kept) stay
  // whatever happens; only the ones this launch makes are taken back.
  const volumeNames = prepared.definition.volumes.map((volume) => volume.name)
  const kept = await engineCall(() =>
    existingVolumes(host, found.engine, prepared.containerName, volumeNames),
  )
  const madeVolumes = volumeNames.filter((volume) => !kept.includes(volume))

  let registeredId: string | null = null
  let made = false
  let credentialId: string | null = null
  // Whether the error already quotes the container's lines.
  let quoted = false

  try {
    // `run --detach` makes the container and then starts it: when the
    // start fails (a port in use), the container and its volumes are
    // there, and are taken back below with everything else.
    await engineCall(() => runContainer(host, found.engine, spec, env))

    const health = await waitHealthy(
      host,
      found.engine,
      prepared.containerName,
      { ...prepared, reach: "tunnel" },
      access,
    )

    if (!health.ok) {
      quoted = true
      throw new EngineError(
        `${prepared.name} did not become healthy: ${health.detail}${await logExcerpt(host, found.engine, prepared.containerName, env.redact)}`,
      )
    }

    const slug = await uniqueSlug(
      ctx.vaultId,
      `${slugify(prepared.name) || "service"}-service`,
    )
    const definitionRow = prepared.definitionId
      ? await definitionForNew(ctx, prepared.definitionId, "service")
      : null

    // An exit's proxy password, which upstream.ts made for this container:
    // kept as the service's own managed secret, for the exit to sign in.
    if (access.proxyAuth) {
      credentialId = (
        await writeManagedSecret(ctx, {
          name: proxySecretName(id),
          description: `The password PCP made for ${prepared.name}'s proxy (an exit).`,
          value: access.proxyAuth.password,
          kind: "proxy_password",
        })
      ).id
    }

    await db().$transaction([
      db().mcpServer.create({
        data: {
          id,
          vaultId: ctx.vaultId,
          kind: "service",
          name: `${prepared.name} service`,
          slug,
          description: definitionRow?.description ?? prepared.description,
          url: SERVICE_URL,
          authType: "none",
          authSecretId: credentialId,
          definitionId: definitionRow?.id ?? null,
        },
      }),
      db().serviceSpec.create({
        data: {
          serverId: id,
          definition: JSON.stringify(prepared.definition),
          hash: serviceDefinitionHash(prepared.definition),
          hostId: prepared.host.id,
          engine: found.engine,
          engineVersion: found.version,
          containerName: prepared.containerName,
          publish: JSON.stringify(prepared.publish),
          env: JSON.stringify(prepared.env),
          plainValues: JSON.stringify(prepared.values),
          reach: "tunnel",
          intendedState: "running",
        },
      }),
    ])
    made = true
    await ensureDefinition(id)
    await storeTools(
      id,
      serviceTools({ service: prepared.name, host: prepared.host.name }),
    )

    if (prepared.note) {
      await setPersonalNote(ctx, "server", id, prepared.note)
    }

    const registered = await register(ctx, prepared, id, access)
    const exitId = registered?.kind === "exit" ? registered.id : null
    registeredId =
      registered && registered.kind !== "exit" ? registered.id : null

    if (registeredId) {
      await db().serviceSpec.update({
        where: { serverId: id },
        data: { registeredId },
      })
    }

    await setServerStatus(id, "ok", "", { lastSyncedAt: new Date() })

    return {
      id,
      registeredId,
      registeredKind:
        registered && registered.kind !== "exit" ? registered.kind : null,
      exitId,
    }
  } catch (error) {
    // Read before the container goes: what it wrote is why, often.
    const lines = quoted
      ? ""
      : await logExcerpt(host, found.engine, prepared.containerName, env.redact)
    const undone: string[] = []
    const name = prepared.containerName
    const volumesWord = (list: string[]) =>
      `the volume${list.length === 1 ? "" : "s"} ${list.map((volume) => volumeOnHost(name, volume)).join(", ")}`

    try {
      await removeContainer(host, found.engine, name, { volumes: madeVolumes })
      undone.push(
        `removed the container ${name}${madeVolumes.length > 0 ? ` and ${volumesWord(madeVolumes)} it made` : ""} from ${host.name}`,
      )
    } catch (removal) {
      undone.push(
        `could not take everything back on ${host.name} (${removal instanceof Error ? removal.message : String(removal)}): remove the container ${name}${madeVolumes.length > 0 ? ` and ${volumesWord(madeVolumes)}` : ""} there by hand`,
      )
    }

    if (kept.length > 0) {
      undone.push(
        `kept ${volumesWord(kept)}, which ${kept.length === 1 ? "was" : "were"} there before`,
      )
    }

    if (registeredId) {
      await deleteServer(ctx, registeredId).catch(() => {})
    }

    if (made) {
      await dropServiceRow(id)
      undone.push("took the service out of PCP")
    } else if (credentialId) {
      await db()
        .secret.deleteMany({
          where: { id: credentialId, kind: "proxy_password" },
        })
        .catch(() => {})
    }

    const reason = makeRedactor(env.redact).text(
      `${error instanceof Error ? error.message : String(error)}${lines}`,
    )

    throw new PcpError(
      isPcpError(error) ? error.code : "upstream",
      `${reason}\nPCP ${undone.join(" and ")}.`.slice(0, 4000),
    )
  }
}

/** Engine failures as PcpErrors the owner's page and the gateway show. */
async function engineCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (isPcpError(error)) {
      throw error
    }

    throw new PcpError(
      "upstream",
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * The service's own rows, without touching the host: its exit goes with it
 * (a cascade), and every level set for that exit, and its proxy password.
 */
async function dropServiceRow(id: string): Promise<void> {
  const row = await db().mcpServer.findUnique({
    where: { id },
    select: { definitionId: true, authSecretId: true, vaultId: true },
  })
  const exits = await db().exit.findMany({
    where: { serviceId: id },
    select: { id: true },
  })

  if (row && exits.length > 0) {
    await db().webFetchRule.deleteMany({
      where: {
        vaultId: row.vaultId,
        kind: "exit",
        key: { in: exits.map((exit) => exit.id) },
      },
    })
  }

  await db().mcpServer.deleteMany({ where: { id } })
  exits.forEach((exit) => forgetExitAnswers(exit.id))

  if (row?.authSecretId) {
    await db().secret.deleteMany({
      where: { id: row.authSecretId, kind: "proxy_password" },
    })
  }

  await forgetUnusedDefinition(row?.definitionId ?? null)
}

/** The endpoint, MCP server or exit the service serves, made as the owner's. */
async function register(
  ctx: VaultContext,
  prepared: PreparedLaunch,
  serviceId: string,
  access: ServiceAccess,
): Promise<{ id: string; kind: "openapi" | "mcp" | "exit" } | null> {
  const registers = prepared.definition.registers

  if (registers.kind === "none") {
    return null
  }

  if (registers.kind === "exit") {
    const { id } = await createServiceExit(ctx, {
      serverId: prepared.host.id,
      serviceId,
      name: prepared.exit!.name,
      label: prepared.exit!.label,
    })

    return { id, kind: "exit" }
  }

  // On the SSH server's side: PCP reaches it through the SSH connection
  // (upstream.ts serviceTunnel), whatever address it is published on.
  const sshHost = sshHostOf(prepared.host)
  const origin = serviceOrigin(
    prepared.publish,
    sshHost,
    registers.port,
    "tunnel",
  )!

  if (registers.kind === "mcp") {
    const { id } = await createServer(ctx, {
      name: prepared.name,
      description: prepared.description,
      url: `${origin}${registers.path}`,
      authType: "none",
      // The owner's own machine: a private address is what it is.
      publicOnly: false,
    })

    return { id, kind: "mcp" }
  }

  const auth = registers.auth
  const { id, sync } = await createEndpoint(ctx, {
    name: prepared.name,
    description: prepared.description,
    specSource: "url",
    specUrl: `${origin}${registers.specPath}`,
    baseUrl: `${origin}${registers.basePath === "/" ? "" : registers.basePath}`,
    readOnly: false,
    publicOnly: false,
    reach: { dial: serviceDial(prepared.publish, sshHost, forwardOf(access)) },
    ...(auth
      ? {
          authType: "header" as const,
          authHeaderName: auth.header,
          authValueTemplate: auth.template,
          authSecretId: prepared.env[auth.env],
        }
      : { authType: "none" as const }),
  })

  if (sync.status !== "ok") {
    await deleteServer(ctx, id).catch(() => {})
    throw new PcpError(
      "upstream",
      `PCP could not read the API schema the service serves: ${sync.message}`,
    )
  }

  return { id, kind: "openapi" }
}

// ---- Health and status -------------------------------------------------------

type Health = { ok: true } | { ok: false; detail: string }

/** The way through the SSH connection; upstream.ts always hands one in. */
function forwardOf(access: Pick<ServiceAccess, "forward">): ServiceForward {
  if (!access.forward) {
    throw new PcpError(
      "state",
      "PCP has no connection to the service's SSH server to reach it through.",
    )
  }

  return access.forward
}

/**
 * One look at the health check's address: 2xx or 3xx is healthy. With
 * `dial`, through the SSH connection (a tunnelled service), else from PCP.
 */
export async function probeHealth(
  url: string,
  dial?: SendOptions["dial"],
): Promise<Health> {
  try {
    const response = await send(
      url,
      {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
        headers: { accept: "*/*" },
      },
      dial ? { dial } : {},
    )
    // Read to its end (a health answer is short), not cancelled: a body
    // cancelled under node:http (send's) can still be written to.
    await readCapped(response, HEALTH_BODY_BYTES).catch(() => {})

    return response.status >= 200 && response.status < 400
      ? { ok: true }
      : {
          ok: false,
          detail: `its health check answered HTTP ${response.status}`,
        }
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code
    const why = dial
      ? error instanceof Error
        ? error.message.slice(0, 300)
        : "no answer"
      : (cause ?? (error instanceof Error ? error.name : "no answer"))
    return {
      ok: false,
      detail: `its health check did not answer (${why})`,
    }
  }
}

/** Where a service is, as its health check and status read it. */
type Reached = {
  definition: ServiceDefinition
  publish: ServicePublish
  reach: ServiceReach
}

/**
 * One look at an exit's proxy, through the SSH connection to the SSH
 * server's loopback where it is published: healthy when it opens a
 * connection to the first DNS-over-HTTPS resolver (exits/doh.ts), the
 * first thing an exit does. A VPN that is down fails here, as a call would.
 */
export async function probeExitProxy(
  definition: ServiceDefinition,
  publish: ServicePublish,
  access: Pick<ServiceAccess, "loopback" | "proxyAuth">,
): Promise<Health> {
  const registers = definition.registers

  if (registers.kind !== "exit" || !access.loopback) {
    return { ok: false, detail: "PCP cannot reach its proxy" }
  }

  const port = publish.ports.find(
    (entry) => entry.container === registers.port,
  )?.host

  if (port === undefined || publish.address !== EXIT_PUBLISH_ADDRESS) {
    return {
      ok: false,
      detail: `its proxy is not published on ${EXIT_PUBLISH_ADDRESS}`,
    }
  }

  const resolver = DOH_RESOLVERS[0]!
  const signal = AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS)
  let socket: Duplex | null = null

  try {
    socket = await access.loopback(port, signal)
    const options = { auth: access.proxyAuth, signal }

    if (registers.protocol === "socks5") {
      await socks5Connect(socket, resolver.address, 443, options)
    } else {
      await httpConnect(socket, resolver.address, 443, options)
    }

    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      detail: `its proxy did not connect out (${(error instanceof Error ? error.message : String(error)).slice(0, 200)})`,
    }
  } finally {
    socket?.destroy()
  }
}

/**
 * The health check's address and how to reach it: through the SSH
 * connection for a tunnelled service (none without one), from PCP's machine
 * for one reached directly. Null when PCP cannot make the check itself.
 */
function healthCheck(
  service: Reached,
  sshHost: string,
  access?: Pick<ServiceAccess, "forward">,
): { url: string; dial?: SendOptions["dial"] } | null {
  const { definition, publish, reach } = service

  if (definition.health.kind !== "http") {
    return null
  }

  if (reach === "tunnel" && !access?.forward) {
    return null
  }

  const origin = serviceOrigin(publish, sshHost, definition.health.port, reach)

  if (!origin) {
    return null
  }

  return {
    url: `${origin}${definition.health.path}`,
    ...(reach === "tunnel"
      ? { dial: serviceDial(publish, sshHost, access!.forward!) }
      : {}),
  }
}

/**
 * Health as one word: the check PCP makes itself where it can reach the
 * service, else the image's own (the engine's), else "unchecked".
 */
async function healthOf(
  state: ContainerState,
  service: Reached,
  sshHost: string,
  access?: Pick<ServiceAccess, "loopback" | "proxyAuth" | "forward">,
): Promise<{ health: ServiceHealth; detail: string | null }> {
  const { definition, publish } = service

  if (state.state !== "running") {
    return { health: "unchecked", detail: null }
  }

  // An exit: the image's own check while it starts or fails, then its proxy
  // through the SSH connection, which is what a call goes through.
  if (definition.registers.kind === "exit" && access?.loopback) {
    if (
      state.engineHealth === "starting" ||
      state.engineHealth === "unhealthy"
    ) {
      return { health: state.engineHealth, detail: null }
    }

    const probe = await probeExitProxy(definition, publish, access)
    return probe.ok
      ? { health: "healthy", detail: null }
      : { health: "unhealthy", detail: probe.detail }
  }

  const check = healthCheck(service, sshHost, access)

  if (check) {
    const probe = await probeHealth(check.url, check.dial)
    return probe.ok
      ? { health: "healthy", detail: null }
      : { health: "unhealthy", detail: probe.detail }
  }

  if (
    state.engineHealth === "healthy" ||
    state.engineHealth === "unhealthy" ||
    state.engineHealth === "starting"
  ) {
    return { health: state.engineHealth, detail: null }
  }

  return { health: "unchecked", detail: null }
}

/**
 * Waits, bounded, for a container just started to be running and healthy;
 * gives up at once on one that exited.
 */
async function waitHealthy(
  host: ServiceHost,
  engine: ServiceEngine,
  containerName: string,
  service: Reached,
  access: ServiceAccess,
): Promise<Health> {
  const { waitMs, intervalMs } = access.timing ?? {
    waitMs: HEALTH_WAIT_MS,
    intervalMs: HEALTH_INTERVAL_MS,
  }
  const deadline = Date.now() + waitMs
  const sshHost = host.address
  let last = "it did not start"

  for (;;) {
    const state = await inspectContainer(
      host,
      engine,
      containerName,
      access.env.redact,
    )

    if (state.state === "exited" || state.state === "dead") {
      return {
        ok: false,
        detail: `it exited${state.exitCode !== null ? ` with code ${state.exitCode}` : ""}${state.error ? ` (${state.error})` : ""}`,
      }
    }

    if (state.state === "missing") {
      return { ok: false, detail: "its container is gone" }
    }

    if (state.state === "running") {
      const { health, detail } = await healthOf(state, service, sshHost, access)

      if (health === "healthy" || health === "unchecked") {
        return { ok: true }
      }

      last = detail ?? `the engine says it is ${health}`
    }

    if (Date.now() + intervalMs > deadline) {
      return {
        ok: false,
        detail: `${last}, after ${Math.round(waitMs / 1000)} seconds`,
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * What the container wrote, for a message about why it failed: its first
 * and last lines (scrubbed), or nothing when it wrote none or cannot be
 * read. A container that was made and never started has none.
 */
async function logExcerpt(
  host: ServiceHost,
  engine: ServiceEngine,
  containerName: string,
  redact: string[],
): Promise<string> {
  try {
    const { text } = await containerLogs(
      host,
      engine,
      containerName,
      { lines: EXCERPT_READ_LINES },
      redact,
    )
    return excerptOf(text)
  } catch {
    return ""
  }
}

/** Lines read for an excerpt, and how many of each end it shows. */
const EXCERPT_READ_LINES = 200
const EXCERPT_LINES = 10

/** The first and last lines of what a container wrote, bounded. */
export function excerptOf(text: string): string {
  const lines = text.trim() ? text.trim().split(/\r?\n/) : []

  if (lines.length === 0) {
    return ""
  }

  if (lines.length <= EXCERPT_LINES * 2) {
    return `. Its lines:\n${lines.join("\n").slice(-3000)}`
  }

  return `. Its first lines:\n${lines.slice(0, EXCERPT_LINES).join("\n").slice(0, 1500)}\n…\nIts last lines:\n${lines.slice(-EXCERPT_LINES).join("\n").slice(-1500)}`
}

export type ServiceHealth = "healthy" | "unhealthy" | "starting" | "unchecked"

export type ServiceStatus = {
  /** running | exited | created | paused | restarting | dead | missing */
  state: string
  health: ServiceHealth
  /** Why it is not healthy, or what the engine said went wrong. */
  detail: string | null
  startedAt: string | null
  exitCode: number | null
  /** The image the container runs, by digest. */
  image: string | null
  /** The image its definition names. */
  definitionImage: string
  /** It runs the image its definition names. */
  upToDate: boolean
  /** The container by that name is not this service's (its pcp.service label). */
  foreign: boolean
  engine: ServiceEngine
  engineVersion: string
  /** Where PCP reaches it, when it can (as the SSH server does, for a tunnel). */
  url: string | null
  /** Through the SSH connection, or directly from PCP's machine. */
  reach: ServiceReach
}

/** The service's state on its SSH server now, read through the engine. */
export async function serviceStatusOn(
  loaded: LoadedService,
  access: ServiceAccess,
): Promise<ServiceStatus> {
  const state = await engineCall(() =>
    inspectContainer(
      access.host,
      loaded.engine,
      loaded.spec.containerName,
      access.env.redact,
    ),
  )
  const foreign =
    state.state !== "missing" && state.serviceLabel !== loaded.server.id
  const { health, detail } = foreign
    ? { health: "unchecked" as const, detail: null }
    : await healthOf(state, loaded, access.host.address, access)
  const port =
    loaded.definition.registers.kind !== "none"
      ? loaded.definition.registers.port
      : loaded.definition.ports[0]?.container

  const status: ServiceStatus = {
    state: state.state,
    health,
    detail: detail ?? state.error,
    startedAt: state.startedAt,
    exitCode: state.exitCode,
    image: state.image,
    definitionImage: loaded.definition.image,
    upToDate: state.image === loaded.definition.image,
    foreign,
    engine: loaded.engine,
    engineVersion: loaded.spec.engineVersion,
    // An exit's proxy is no address of PCP's to show: it is reached
    // through the SSH connection only. A tunnelled service's is as the SSH
    // server reaches it.
    url:
      port === undefined || loaded.definition.registers.kind === "exit"
        ? null
        : serviceOrigin(
            loaded.publish,
            access.host.address,
            port,
            loaded.reach,
          ),
    reach: loaded.reach,
  }

  await recordStatus(loaded, status)
  return status
}

/** The status in words, for the server's row and an assistant. */
export function statusWords(name: string, status: ServiceStatus): string {
  if (status.foreign) {
    return `The container named for ${name} on its SSH server is not the one PCP started.`
  }

  if (status.state === "missing") {
    return `${name}'s container is gone from its SSH server.`
  }

  if (status.state !== "running") {
    return `${name} is ${status.state === "exited" ? "stopped" : status.state}${status.exitCode !== null && status.state === "exited" ? ` (it exited with code ${status.exitCode})` : ""}.`
  }

  if (status.health === "unhealthy") {
    return `${name} is running but unhealthy: ${status.detail ?? "its health check fails"}.`
  }

  return `${name} is running${status.health === "healthy" ? " and healthy" : ""}.`
}

/** What was read is what the service's row shows until the next look. */
async function recordStatus(
  loaded: LoadedService,
  status: ServiceStatus,
): Promise<void> {
  const fine =
    !status.foreign &&
    status.state === "running" &&
    status.health !== "unhealthy"

  await setServerStatus(
    loaded.server.id,
    fine ? "ok" : "error",
    fine ? "" : statusWords(loaded.server.name, status),
    { lastSyncedAt: new Date() },
  )
}

// ---- Running it --------------------------------------------------------------

/** Keeps what the owner (or an assistant's start or stop) asked of it last. */
async function recordIntent(
  loaded: LoadedService,
  intent: ServiceIntent,
): Promise<void> {
  if (loaded.intent !== intent) {
    await db().serviceSpec.update({
      where: { serverId: loaded.server.id },
      data: { intendedState: intent },
    })
    loaded.intent = intent
  }
}

/**
 * Start, stop or restart. Starting one whose container is gone makes it
 * again from the definition (the variables are in `access`); starting and
 * restarting wait for it to be healthy. What was asked is kept: a service
 * stopped here is not started again by a call or the reconcile pass.
 */
export async function serviceActionOn(
  loaded: LoadedService,
  action: ContainerAction,
  access: ServiceAccess,
): Promise<ServiceStatus> {
  const before = await serviceStatusOn(loaded, access)

  if (before.foreign) {
    throw new PcpError(
      "state",
      statusWords(loaded.server.name, before) +
        " PCP leaves it alone: remove or rename it on the SSH server, then start the service again.",
    )
  }

  await recordIntent(loaded, action === "stop" ? "stopped" : "running")

  if (action === "start" && before.state === "missing") {
    return recreateServiceOn(loaded, access)
  }

  if (!(action === "start" && before.state === "running")) {
    await engineCall(() =>
      containerAction(
        access.host,
        loaded.engine,
        loaded.spec.containerName,
        action,
      ),
    )
  }

  if (action !== "stop") {
    const health = await waitHealthy(
      access.host,
      loaded.engine,
      loaded.spec.containerName,
      loaded,
      access,
    )

    if (!health.ok) {
      const status = await serviceStatusOn(loaded, access)
      throw new PcpError(
        "upstream",
        `${loaded.server.name} did not become healthy: ${health.detail}.`.concat(
          status.state === "running"
            ? ""
            : ` ${statusWords(loaded.server.name, status)}`,
        ),
      )
    }
  }

  return serviceStatusOn(loaded, access)
}

/**
 * Makes the container again from the definition and the variables as they
 * are now (after a secret changed, or an update), keeping its volumes. A
 * service reached directly until now is reached through the SSH connection
 * from here on, once it is healthy that way.
 */
export async function recreateServiceOn(
  loaded: LoadedService,
  access: ServiceAccess,
): Promise<ServiceStatus> {
  const name = loaded.spec.containerName
  const reach: ServiceReach = access.forward ? "tunnel" : loaded.reach

  // The image first: when it cannot be had, the container runs on as it was.
  await engineCall(() =>
    pullImage(access.host, loaded.engine, loaded.definition.image),
  )
  await engineCall(() => removeContainer(access.host, loaded.engine, name))
  await recordIntent(loaded, "running")

  try {
    await engineCall(() =>
      runContainer(
        access.host,
        loaded.engine,
        {
          serviceId: loaded.server.id,
          containerName: name,
          definition: loaded.definition,
          publish: loaded.publish,
        },
        access.env,
      ),
    )
  } catch (error) {
    throw await failedRecreate(loaded, access, error)
  }

  const health = await waitHealthy(
    access.host,
    loaded.engine,
    name,
    { ...loaded, reach },
    access,
  )

  if (health.ok && reach !== loaded.reach) {
    await db().serviceSpec.update({
      where: { serverId: loaded.server.id },
      data: { reach },
    })
    loaded.reach = reach
  }

  const status = await serviceStatusOn(loaded, access)

  if (!health.ok) {
    throw new PcpError(
      "upstream",
      `${loaded.server.name} was made again but did not become healthy: ${health.detail}${await logExcerpt(access.host, loaded.engine, name, access.env.redact)}`,
    )
  }

  return status
}

/**
 * The old container is gone and the new one did not start (a port taken
 * since, an engine that refused): the one made is taken out again (its
 * volumes, the service's data, stay), the service is marked failed on its
 * row, and the error says so and how to make it again.
 */
async function failedRecreate(
  loaded: LoadedService,
  access: ServiceAccess,
  error: unknown,
): Promise<PcpError> {
  const name = loaded.spec.containerName
  const lines = await logExcerpt(
    access.host,
    loaded.engine,
    name,
    access.env.redact,
  )
  const left = await removeContainer(access.host, loaded.engine, name).then(
    () => "",
    (removal: unknown) =>
      ` PCP could not take out the container it made (${removal instanceof Error ? removal.message : String(removal)}): remove ${name} on ${access.host.name} by hand first.`,
  )
  const reason = makeRedactor(access.env.redact).text(
    `${error instanceof Error ? error.message : String(error)}${lines}`,
  )
  const message =
    `${loaded.server.name} could not be made again: ${reason}\nIts old container is gone; its volumes and settings stay.${left} Once what stopped it is fixed (a port in use on ${access.host.name}, say), Start on its page or its start tool makes it again.`.slice(
      0,
      4000,
    )

  // The row says it first, within what a status line keeps.
  const said = makeRedactor(access.env.redact).text(
    error instanceof Error ? error.message : String(error),
  )
  await setServerStatus(
    loaded.server.id,
    "error",
    `${loaded.server.name} could not be made again and has no container now: Start makes it again once what stopped it is fixed. ${said}`,
    { lastSyncedAt: new Date() },
  ).catch(() => {})

  return new PcpError(isPcpError(error) ? error.code : "upstream", message)
}

/**
 * Pulls the newest image of the definition's `source` tag, pins its digest
 * on the definition (every instance's), and makes this instance's container
 * again from it. Without a source, makes it again from the pinned image.
 */
export async function updateServiceOn(
  loaded: LoadedService,
  access: ServiceAccess,
): Promise<{ status: ServiceStatus; image: string; changed: boolean }> {
  let image = loaded.definition.image

  if (loaded.definition.source) {
    const source = loaded.definition.source
    image = await engineCall(() =>
      resolveDigest(access.host, loaded.engine, source),
    )
  }

  const changed = image !== loaded.definition.image

  if (changed) {
    await writeServiceDefinition(loaded.server.id, {
      ...loaded.definition,
      image,
    })
  }

  const status = await recreateServiceOn(
    { ...loaded, definition: { ...loaded.definition, image } },
    access,
  )

  return { status, image, changed }
}

/**
 * Writes a service's definition and gives every other instance of it the
 * same: what a service is, is its definition's. The instances' containers
 * run the old one until each is updated.
 */
export async function writeServiceDefinition(
  id: string,
  definition: ServiceDefinition,
): Promise<void> {
  const checked = parseServiceDefinition(definition)
  const json = JSON.stringify(checked)
  const hash = serviceDefinitionHash(checked)

  await db().serviceSpec.update({
    where: { serverId: id },
    data: { definition: json, hash },
  })

  for (const sibling of await siblingInstances(id)) {
    if (sibling.kind === "service") {
      await db().serviceSpec.updateMany({
        where: { serverId: sibling.id, hash: { not: hash } },
        data: { definition: json, hash },
      })
    }
  }
}

/**
 * The owner's own save on the service's page: its name, description and
 * which secret each variable takes. A change of secrets is made on the
 * container by `recreate` (the caller's, through upstream.ts).
 */
export async function saveServiceSettings(
  ctx: VaultContext,
  id: string,
  input: {
    name: string
    description?: string
    env: ServiceEnvBindings
    /** Left out: the values typed for its plain variables stay. */
    values?: ServicePlainValues
  },
): Promise<{ envChanged: boolean }> {
  const loaded = await loadService(ctx, id)
  const { name, description } = normalizeNameAndDescription(input)
  const values = input.values
    ? checkPlainValues(input.values, loaded.definition)
    : loaded.values
  const env = checkEnvBindings(input.env, loaded.definition, values)
  const ids = [...new Set(Object.values(env))]
  const found = await db().secret.count({
    where: { vaultId: ctx.vaultId, id: { in: ids }, kind: "text" },
  })

  if (found !== ids.length) {
    throw invalid("Choose text secrets of yours for the service's variables.")
  }

  const envChanged =
    JSON.stringify(env) !== JSON.stringify(loaded.env) ||
    JSON.stringify(values) !== JSON.stringify(loaded.values)

  await db().$transaction([
    db().mcpServer.update({ where: { id }, data: { name, description } }),
    db().serviceSpec.update({
      where: { serverId: id },
      data: { env: JSON.stringify(env), plainValues: JSON.stringify(values) },
    }),
  ])
  await shareDescription(id)

  return { envChanged }
}

/**
 * Removes the service: its container from the SSH server (its volumes too
 * when asked), the service's own server, and, when asked, the server it
 * registered. A service whose SSH server is gone leaves its container
 * there, which the answer says.
 */
export async function removeServiceOn(
  ctx: VaultContext,
  loaded: LoadedService,
  access: ServiceAccess | null,
  {
    volumes = false,
    registered = true,
  }: { volumes?: boolean; registered?: boolean } = {},
): Promise<string> {
  const said: string[] = []

  if (access) {
    await engineCall(() =>
      removeContainer(access.host, loaded.engine, loaded.spec.containerName, {
        volumes: volumes
          ? loaded.definition.volumes.map((volume) => volume.name)
          : [],
      }),
    )
    said.push(
      `Removed the container ${loaded.spec.containerName}${volumes && loaded.definition.volumes.length > 0 ? " and its volumes" : ""}.`,
    )
  } else {
    said.push(
      `Its SSH server is no longer in PCP, so the container ${loaded.spec.containerName} stays there: remove it by hand.`,
    )
  }

  if (registered && loaded.spec.registeredId) {
    await deleteServer(ctx, loaded.spec.registeredId).catch(() => {})
    said.push("Removed the server it served.")
  }

  await dropServiceRow(loaded.server.id)
  return said.join(" ")
}

// ---- The gateway's side ------------------------------------------------------

/**
 * Stores the service's tools and, for the owner, reads its status. The
 * gateway's own re-read (byOwner false) connects to nothing.
 */
export async function syncServiceTools(
  loaded: LoadedService,
  access: ServiceAccess | null,
  { byOwner }: { byOwner: boolean },
): Promise<SyncResult> {
  const toolCount = await storeTools(
    loaded.server.id,
    serviceTools({
      service: loaded.server.name.replace(/ service$/, ""),
      host: loaded.host?.name ?? "its SSH server",
    }),
  )

  if (!byOwner || !access) {
    return {
      status: loaded.server.status === "ok" ? "ok" : "error",
      message: loaded.server.statusMessage,
      toolCount,
    }
  }

  try {
    const status = await serviceStatusOn(loaded, access)
    const fine = status.state === "running" && status.health !== "unhealthy"
    return {
      status: fine ? "ok" : "error",
      message: fine ? "" : statusWords(loaded.server.name, status),
      toolCount,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await setServerStatus(loaded.server.id, "error", message)
    return { status: "error", message, toolCount }
  }
}

/** One call to a service's tool, its arguments checked before anything connects. */
export async function callServiceTool(
  loaded: LoadedService,
  toolName: string,
  args: Record<string, unknown>,
  access: ServiceAccess,
  { publicUrl }: { publicUrl: string },
): Promise<CallToolResult> {
  const read = readServiceCall(toolName, args)

  if (!read.fits) {
    return "unknown" in read
      ? familyError(
          `A service has no tool called ${toolName}; it has ${SERVICE_TOOL_NAMES.join(", ")}.`,
          "not_found",
        )
      : argumentsResult(`${loaded.server.slug}/${toolName}`, read.problems, {
          notes: read.notes,
        })
  }

  const { call } = read
  const redact = access.env.redact

  try {
    if (call.tool === "logs") {
      const logs = await engineCall(() =>
        containerLogs(
          access.host,
          loaded.engine,
          loaded.spec.containerName,
          { lines: call.lines, sinceMinutes: call.sinceMinutes },
          redact,
        ),
      )

      return jsonToolResult(
        {
          logs: logs.text,
          ...(logs.truncated
            ? {
                truncated:
                  "The lines were longer than PCP keeps: these are the first.",
              }
            : {}),
        },
        { redact },
      )
    }

    const status =
      call.tool === "status"
        ? await serviceStatusOn(loaded, access)
        : await serviceActionOn(loaded, call.tool, access)

    return jsonToolResult(await statusAnswer(loaded, status, publicUrl), {
      redact,
    })
  } catch (error) {
    if (isPcpError(error) && error.code !== "upstream") {
      throw error
    }

    return errorToolResult(
      `${error instanceof Error ? error.message : String(error)}\nThe service's page: ${markdownLink(`Open ${loaded.server.name}'s page in PCP`, pageOf(loaded.server.id, publicUrl))}`,
      { redact },
    )
  }
}

async function statusAnswer(
  loaded: LoadedService,
  status: ServiceStatus,
  publicUrl: string,
) {
  const registered = loaded.spec.registeredId
    ? await db().mcpServer.findUnique({
        where: { id: loaded.spec.registeredId },
        select: { slug: true, kind: true },
      })
    : null

  return {
    summary: statusWords(loaded.server.name, status),
    state: status.state,
    health: status.health,
    ...(status.detail ? { detail: status.detail } : {}),
    started_at: status.startedAt,
    image: status.image,
    ...(status.upToDate ? {} : { definition_image: status.definitionImage }),
    engine: `${status.engine}${status.engineVersion ? ` ${status.engineVersion}` : ""}`,
    host: loaded.host?.name ?? null,
    ...(registered
      ? {
          serves: registered.slug,
          serves_kind:
            registered.kind === "openapi" ? "API endpoint" : "MCP server",
        }
      : {}),
    page: pageOf(loaded.server.id, publicUrl),
  }
}

/**
 * Why a call to a server a service registered failed, when the service is
 * the reason: it is stopped, gone or unhealthy. Null when it looks fine
 * (the failure is the server's own) or cannot be read.
 */
export async function stoppedServiceMessage(
  loaded: LoadedService,
  access: ServiceAccess | null,
  { publicUrl }: { publicUrl: string },
): Promise<string | null> {
  const where = loaded.host?.name ?? "its SSH server"
  const page = markdownLink(
    `Open ${loaded.server.name}'s page in PCP`,
    pageOf(loaded.server.id, publicUrl),
  )

  if (!access) {
    return `${loaded.server.name} runs on ${where}, which PCP cannot reach now. The owner sees it on the service's page:\n${page}`
  }

  let status: ServiceStatus

  try {
    status = await serviceStatusOn(loaded, access)
  } catch {
    return null
  }

  if (
    !status.foreign &&
    status.state === "running" &&
    status.health !== "unhealthy"
  ) {
    return null
  }

  const onPurpose =
    loaded.intent === "stopped"
      ? " It was stopped through PCP, so PCP does not start it by itself."
      : ""

  return `${statusWords(loaded.server.name, status)}${onPurpose} It runs on ${where}. ${loaded.server.slug}/start starts it, at the owner's level for that tool; the owner can also start it on the service's page:\n${page}`
}

/** States a call or the reconcile pass starts a container from. */
const STARTABLE = new Set(["exited", "created"])

export type StartOnDemand =
  { started: true; note: string } | { started: false; reason: string | null }

/** Starts under way, by service: a second call waits for the first's. */
const waking = new Map<string, Promise<StartOnDemand>>()

/**
 * After a call to what the service serves failed: when the owner left it
 * running and its container is stopped (exited, or made and never
 * started), starts it and waits, bounded, for it to be healthy, so the
 * caller can try once more. Nothing when it was stopped through PCP, is
 * running (the failure is the server's own), is gone or is another's.
 * `reason` says why a start it tried did not work.
 */
export function startOnDemand(
  loaded: LoadedService,
  access: ServiceAccess,
): Promise<StartOnDemand> {
  const under = waking.get(loaded.server.id)

  if (under) {
    return under
  }

  const run = wake(loaded, access).finally(() =>
    waking.delete(loaded.server.id),
  )
  waking.set(loaded.server.id, run)
  return run
}

async function wake(
  loaded: LoadedService,
  access: ServiceAccess,
): Promise<StartOnDemand> {
  if (loaded.intent === "stopped") {
    return { started: false, reason: null }
  }

  let before: ServiceStatus

  try {
    before = await serviceStatusOn(loaded, access)
  } catch {
    return { started: false, reason: null }
  }

  if (before.foreign || !STARTABLE.has(before.state)) {
    return { started: false, reason: null }
  }

  const was = before.state === "exited" ? "stopped" : before.state

  try {
    await serviceActionOn(loaded, "start", {
      ...access,
      timing: access.timing ?? {
        waitMs: START_ON_DEMAND_WAIT_MS,
        intervalMs: HEALTH_INTERVAL_MS,
      },
    })
  } catch (error) {
    return {
      started: false,
      reason: `${loaded.server.name} was ${was}, and PCP could not start it: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`,
    }
  }

  return {
    started: true,
    note: `PCP started the service ${loaded.server.name} (${loaded.server.slug}), which was ${was}, for this call.`,
  }
}

export type ReconcileRun = {
  /** The services it started. */
  started: string[]
  skipped?: "busy" | "recent"
}

const reconciling = new Set<string>()
const lastReconcile = new Map<string, number>()

/**
 * Brings the vault's services the owner left running back up when their
 * container stopped (the SSH server restarted, and Podman without its
 * restart unit does not start them): after a request that holds the
 * vault's key was answered (app/mcp/route.ts, the owner's pages, through
 * Next's after()), at most once in SERVICE_RECONCILE_INTERVAL_MS, within a
 * budget. Never on a timer, never with a key kept between requests. Never
 * throws: what it finds is each service's status.
 */
export async function reconcileServicesWith(
  ctx: VaultContext,
  accessFor: (loaded: LoadedService) => Promise<ServiceAccess | null>,
  {
    now = Date.now(),
    budgetMs = SERVICE_RECONCILE_BUDGET_MS,
  }: { now?: number; budgetMs?: number } = {},
): Promise<ReconcileRun> {
  if (reconciling.has(ctx.vaultId)) {
    return { started: [], skipped: "busy" }
  }

  if (
    now - (lastReconcile.get(ctx.vaultId) ?? -Infinity) <
    SERVICE_RECONCILE_INTERVAL_MS
  ) {
    return { started: [], skipped: "recent" }
  }

  reconciling.add(ctx.vaultId)
  lastReconcile.set(ctx.vaultId, now)
  const began = Date.now()
  const started: string[] = []

  try {
    const specs = await db()
      .serviceSpec.findMany({
        where: {
          intendedState: "running",
          hostId: { not: null },
          server: { vaultId: ctx.vaultId, enabled: true },
        },
        select: { serverId: true },
        orderBy: { createdAt: "asc" },
      })
      .catch(() => [])

    for (const { serverId } of specs) {
      if (Date.now() - began > budgetMs) {
        break
      }

      try {
        const loaded = await loadService(ctx, serverId)
        const access = await accessFor(loaded)

        if (!access) {
          continue
        }

        const outcome = await startOnDemand(loaded, access)

        if (outcome.started) {
          started.push(serverId)
        } else if (outcome.reason) {
          await setServerStatus(serverId, "error", outcome.reason)
        }
      } catch {
        // One service that cannot be read leaves the others to go on.
      }
    }
  } finally {
    reconciling.delete(ctx.vaultId)
  }

  return { started }
}

/** For the server page: the services' rows of the vault, by SSH server. */
export async function servicesOnHost(
  ctx: VaultContext,
  hostId: string,
): Promise<Array<{ id: string; name: string; containerName: string }>> {
  const specs = await db().serviceSpec.findMany({
    where: { hostId, server: { vaultId: ctx.vaultId } },
    select: {
      containerName: true,
      server: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  })

  return specs.map((spec) => ({
    id: spec.server.id,
    name: spec.server.name,
    containerName: spec.containerName,
  }))
}

/** What the service's page shows of it that is not live: nothing secret. */
export type ServiceView = {
  id: string
  /** The definition its instances share: another is launched on it. */
  definitionId: string | null
  name: string
  containerName: string
  engine: ServiceEngine
  engineVersion: string
  /** The SSH server, and the login PCP runs the engine as there. */
  host: { id: string; name: string; username: string } | null
  definition: ServiceDefinition
  publish: ServicePublish
  /** Through the SSH connection, or directly from PCP's machine. */
  reach: ServiceReach
  /** Whether it was last started or stopped through PCP. */
  intent: ServiceIntent
  /** Variable name → the secret's name, or the value typed for a plain one. */
  env: Array<{
    name: string
    plain: boolean
    value: string | null
    secretId: string | null
    secretName: string | null
  }>
  /** The exit it added, for an exit's service. */
  exit: { id: string; name: string; label: string } | null
  registered: { id: string; name: string; slug: string; kind: string } | null
}

export async function serviceView(
  ctx: VaultContext,
  id: string,
): Promise<ServiceView> {
  const loaded = await loadService(ctx, id)
  const ids = Object.values(loaded.env)
  const secrets = await db().secret.findMany({
    where: { vaultId: ctx.vaultId, id: { in: ids } },
    select: { id: true, name: true },
  })
  const registered = loaded.spec.registeredId
    ? await getServer(ctx, loaded.spec.registeredId).catch(() => null)
    : null
  const exit = await db().exit.findFirst({
    where: { serviceId: id, vaultId: ctx.vaultId },
    select: { id: true, name: true, label: true },
  })

  return {
    id,
    exit,
    definitionId: loaded.server.definitionId,
    name: loaded.server.name,
    containerName: loaded.spec.containerName,
    engine: loaded.engine,
    engineVersion: loaded.spec.engineVersion,
    host: loaded.host
      ? {
          id: loaded.host.id,
          name: loaded.host.name,
          username: loaded.host.authUsername ?? "",
        }
      : null,
    definition: loaded.definition,
    publish: loaded.publish,
    reach: loaded.reach,
    intent: loaded.intent,
    env: loaded.definition.env.map((entry) => {
      const secretId = loaded.env[entry.name] ?? null
      return {
        name: entry.name,
        plain: entry.plain,
        value: loaded.values[entry.name] ?? null,
        secretId,
        secretName:
          secrets.find((secret) => secret.id === secretId)?.name ?? null,
      }
    }),
    registered: registered
      ? {
          id: registered.id,
          name: registered.name,
          slug: registered.slug,
          kind: registered.kind,
        }
      : null,
  }
}

/**
 * The vault's service definitions that add an exit (VPN containers), for
 * Add a VPN exit: another of each is launched on its definition.
 */
export async function exitServiceDefinitions(
  ctx: VaultContext,
): Promise<Array<{ definitionId: string; name: string; image: string }>> {
  const specs = await db().serviceSpec.findMany({
    where: { server: { vaultId: ctx.vaultId, definitionId: { not: null } } },
    select: {
      definition: true,
      server: { select: { definitionId: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  })
  const found = new Map<string, { name: string; image: string }>()

  for (const spec of specs) {
    const id = spec.server.definitionId!

    if (found.has(id)) {
      continue
    }

    try {
      const definition = readServiceDefinition(spec.definition)

      if (definition.registers.kind === "exit") {
        found.set(id, {
          name: spec.server.name.replace(/ service$/i, ""),
          image: definition.image,
        })
      }
    } catch {
      // A stored definition that no longer reads is not offered.
    }
  }

  return [...found].map(([definitionId, entry]) => ({
    definitionId,
    ...entry,
  }))
}
