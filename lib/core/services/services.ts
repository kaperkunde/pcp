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
import { newId } from "../ids"
import { errorToolResult, jsonToolResult } from "../json-result"
import { argumentsResult, familyError } from "../tools/family"
import { makeRedactor } from "../openapi/redact"
import { markdownLink } from "../owner-link"
import { checkPersonalNote, setPersonalNote } from "../personal-notes"
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
  parsePublish,
  parseServiceDefinition,
  reachUrl,
  readEnvBindings,
  readPublish,
  readServiceDefinition,
  serviceDefinitionHash,
  type ServiceDefinition,
  type ServiceEnvBindings,
  type ServicePublish,
} from "./definition"
import {
  CONTAINER_NAME,
  containerAction,
  containerLogs,
  detectEngine,
  EngineError,
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
  HEALTH_INTERVAL_MS,
  HEALTH_REQUEST_TIMEOUT_MS,
  HEALTH_WAIT_MS,
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
  /** Waiting for health; tests shorten it. */
  timing?: { waitMs: number; intervalMs: number }
}

export type LoadedService = {
  server: McpServer
  spec: ServiceSpec
  definition: ServiceDefinition
  publish: ServicePublish
  env: ServiceEnvBindings
  engine: ServiceEngine
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
    engine: engineOf(spec.engine),
    host: host && host.vaultId === ctx.vaultId ? host : null,
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
  const env = checkEnvBindings(input.env, definition)
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

  if (
    definition.registers.kind !== "none" &&
    !reachUrl(publish, sshHostOf(host), definition.registers.port)
  ) {
    throw invalid(
      `PCP reaches what the service serves at the address its port is published on, and ${publish.address} is ${host.name}'s own loopback. Publish it on an address PCP can reach: 0.0.0.0, or one of ${host.name}'s own.`,
    )
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

  await engineCall(() =>
    pullImage(host, found.engine, prepared.definition.image),
  )
  await engineCall(() => runContainer(host, found.engine, spec, env))

  let registeredId: string | null = null
  let made = false

  try {
    const health = await waitHealthy(
      host,
      found.engine,
      prepared.containerName,
      prepared.definition,
      prepared.publish,
      access,
    )

    if (!health.ok) {
      throw new EngineError(
        `${prepared.name} did not become healthy: ${health.detail}${await lastLines(host, found.engine, prepared.containerName, env.redact)}`,
      )
    }

    const slug = await uniqueSlug(
      ctx.vaultId,
      `${slugify(prepared.name) || "service"}-service`,
    )
    const definitionRow = prepared.definitionId
      ? await definitionForNew(ctx, prepared.definitionId, "service")
      : null

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

    const registered = await register(ctx, prepared)
    registeredId = registered?.id ?? null

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
      registeredKind: registered?.kind ?? null,
    }
  } catch (error) {
    const undone = [
      `removed the container ${prepared.containerName}${prepared.definition.volumes.length > 0 ? " and its volumes" : ""} from ${host.name}`,
    ]

    await removeContainer(host, found.engine, prepared.containerName, {
      volumes: prepared.definition.volumes.map((volume) => volume.name),
    }).catch(() => {
      undone[0] = `could not remove the container ${prepared.containerName} from ${host.name}: remove it there by hand`
    })

    if (registeredId) {
      await deleteServer(ctx, registeredId).catch(() => {})
    }

    if (made) {
      await dropServiceRow(id)
      undone.push("took the service out of PCP")
    }

    const reason = makeRedactor(env.redact).text(
      error instanceof Error ? error.message : String(error),
    )

    throw new PcpError(
      isPcpError(error) ? error.code : "upstream",
      `${reason}\nPCP ${undone.join(" and ")}.`.slice(0, 2000),
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

/** The service's own rows, without touching the host. */
async function dropServiceRow(id: string): Promise<void> {
  const row = await db().mcpServer.findUnique({
    where: { id },
    select: { definitionId: true },
  })
  await db().mcpServer.deleteMany({ where: { id } })
  await forgetUnusedDefinition(row?.definitionId ?? null)
}

/** The endpoint or MCP server the service serves, made as the owner's. */
async function register(
  ctx: VaultContext,
  prepared: PreparedLaunch,
): Promise<{ id: string; kind: "openapi" | "mcp" } | null> {
  const registers = prepared.definition.registers

  if (registers.kind === "none") {
    return null
  }

  const origin = reachUrl(
    prepared.publish,
    sshHostOf(prepared.host),
    registers.port,
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

/** One look at the health check's address from PCP: 2xx or 3xx is healthy. */
export async function probeHealth(url: string): Promise<Health> {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      headers: { accept: "*/*" },
    })
    await response.body?.cancel().catch(() => {})

    return response.status >= 200 && response.status < 400
      ? { ok: true }
      : {
          ok: false,
          detail: `its health check answered HTTP ${response.status}`,
        }
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code
    return {
      ok: false,
      detail: `its health check did not answer (${cause ?? (error instanceof Error ? error.name : "no answer")})`,
    }
  }
}

function healthUrl(
  definition: ServiceDefinition,
  publish: ServicePublish,
  sshHost: string,
): string | null {
  if (definition.health.kind !== "http") {
    return null
  }

  const origin = reachUrl(publish, sshHost, definition.health.port)
  return origin ? `${origin}${definition.health.path}` : null
}

/**
 * Health as one word: the check PCP makes itself where it can reach the
 * service, else the image's own (the engine's), else "unchecked".
 */
async function healthOf(
  state: ContainerState,
  definition: ServiceDefinition,
  publish: ServicePublish,
  sshHost: string,
): Promise<{ health: ServiceHealth; detail: string | null }> {
  if (state.state !== "running") {
    return { health: "unchecked", detail: null }
  }

  const url = healthUrl(definition, publish, sshHost)

  if (url) {
    const probe = await probeHealth(url)
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
  definition: ServiceDefinition,
  publish: ServicePublish,
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
      const { health, detail } = await healthOf(
        state,
        definition,
        publish,
        sshHost,
      )

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

async function lastLines(
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
      { lines: 20 },
      redact,
    )
    return text.trim() ? `. Its last lines:\n${text.trim().slice(-2000)}` : ""
  } catch {
    return ""
  }
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
  /** Where PCP reaches it, when it can. */
  url: string | null
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
    : await healthOf(
        state,
        loaded.definition,
        loaded.publish,
        access.host.address,
      )
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
    url:
      port === undefined
        ? null
        : reachUrl(loaded.publish, access.host.address, port),
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

/**
 * Start, stop or restart. Starting one whose container is gone makes it
 * again from the definition (the variables are in `access`); starting and
 * restarting wait for it to be healthy.
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
      loaded.definition,
      loaded.publish,
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
 * are now (after a secret changed, or an update), keeping its volumes.
 */
export async function recreateServiceOn(
  loaded: LoadedService,
  access: ServiceAccess,
): Promise<ServiceStatus> {
  const name = loaded.spec.containerName

  await engineCall(async () => {
    await pullImage(access.host, loaded.engine, loaded.definition.image)
    await removeContainer(access.host, loaded.engine, name)
    await runContainer(
      access.host,
      loaded.engine,
      {
        serviceId: loaded.server.id,
        containerName: name,
        definition: loaded.definition,
        publish: loaded.publish,
      },
      access.env,
    )
  })

  const health = await waitHealthy(
    access.host,
    loaded.engine,
    name,
    loaded.definition,
    loaded.publish,
    access,
  )
  const status = await serviceStatusOn(loaded, access)

  if (!health.ok) {
    throw new PcpError(
      "upstream",
      `${loaded.server.name} was made again but did not become healthy: ${health.detail}${await lastLines(access.host, loaded.engine, name, access.env.redact)}`,
    )
  }

  return status
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
  input: { name: string; description?: string; env: ServiceEnvBindings },
): Promise<{ envChanged: boolean }> {
  const loaded = await loadService(ctx, id)
  const { name, description } = normalizeNameAndDescription(input)
  const env = checkEnvBindings(input.env, loaded.definition)
  const ids = [...new Set(Object.values(env))]
  const found = await db().secret.count({
    where: { vaultId: ctx.vaultId, id: { in: ids }, kind: "text" },
  })

  if (found !== ids.length) {
    throw invalid("Choose text secrets of yours for the service's variables.")
  }

  const envChanged = JSON.stringify(env) !== JSON.stringify(loaded.env)

  await db().$transaction([
    db().mcpServer.update({ where: { id }, data: { name, description } }),
    db().serviceSpec.update({
      where: { serverId: id },
      data: { env: JSON.stringify(env) },
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

  return `${statusWords(loaded.server.name, status)} It runs on ${where}. ${loaded.server.slug}/start starts it, at the owner's level for that tool; the owner can also start it on the service's page:\n${page}`
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
  host: { id: string; name: string } | null
  definition: ServiceDefinition
  publish: ServicePublish
  /** Variable name → the secret's name. */
  env: Array<{
    name: string
    secretId: string | null
    secretName: string | null
  }>
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

  return {
    id,
    definitionId: loaded.server.definitionId,
    name: loaded.server.name,
    containerName: loaded.spec.containerName,
    engine: loaded.engine,
    engineVersion: loaded.spec.engineVersion,
    host: loaded.host ? { id: loaded.host.id, name: loaded.host.name } : null,
    definition: loaded.definition,
    publish: loaded.publish,
    env: loaded.definition.env.map((entry) => {
      const secretId = loaded.env[entry.name] ?? null
      return {
        name: entry.name,
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
