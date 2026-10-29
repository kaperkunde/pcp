import type { ExecResult } from "../ssh/client"
import { makeRedactor } from "../openapi/redact"
import {
  ALLOWED_CAPABILITIES,
  ALLOWED_DEVICES,
  ENV_NAME,
  IMAGE_BY_DIGEST,
  IMAGE_BY_TAG,
  imageRepository,
  volumeOnHost,
  type ServiceDefinition,
  type ServicePublish,
} from "./definition"
import {
  ENGINE_COMMAND_TIMEOUT_MS,
  ENGINE_OUTPUT_BYTES,
  ENGINE_PULL_TIMEOUT_MS,
  MAX_ENV_SECRET_BYTES,
  MAX_LOG_BYTES,
  STOP_GRACE_SECONDS,
} from "./limits"
import { commandLine, shellQuote, shScript } from "./shell"

/**
 * The Docker or Podman command line on an SSH server, run over SSH `exec`:
 * PCP never reaches an engine's socket, it runs the engine's own program as
 * the owner's login would. Each command here is words built from checked
 * fields (services/definition.ts) and quoted (services/shell.ts); the
 * variables' values are written to the engine over standard input, into a
 * file only the login can read that the same command deletes, never on the
 * command line, where `ps` would show them.
 *
 * Nothing here reads a secret: the caller (upstream.ts) hands in a
 * `ServiceHost` that runs commands on the SSH server, and a `ServiceEnv`.
 */

export type ServiceEngine = "docker" | "podman"

/** Runs one command on the SSH server: what upstream.ts hands this module. */
export type ServiceHost = {
  /** The SSH server's name, for messages. */
  name: string
  /** Its address, which PCP reaches a published port at. */
  address: string
  exec: (
    command: string,
    options: { stdin?: Buffer; timeoutMs: number; maxOutputBytes: number },
  ) => Promise<ExecResult>
}

/**
 * The variables' values, from the owner's secrets and the definition's
 * fixed values. `redact` is every secret value, taken out of anything the
 * engine answers (its logs, its errors) before PCP shows it.
 */
export type ServiceEnv = { values: Record<string, string>; redact: string[] }

/** Something the engine refused, in its own words with the secrets taken out. */
export class EngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EngineError"
  }
}

/** The engine's program: only these two names ever start a command. */
function program(engine: ServiceEngine): string {
  if (engine !== "docker" && engine !== "podman") {
    throw new EngineError("PCP runs services with Docker or Podman only.")
  }

  return engine
}

function text(buffer: Buffer): string {
  return buffer.toString("utf8")
}

/** The engine's error, short, with secrets out. */
function said(result: ExecResult, redact: string[]): string {
  const scrub = makeRedactor(redact)
  const words = (text(result.stderr).trim() || text(result.stdout).trim())
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ")
    .slice(-600)
  return scrub.text(words) || `it ended with code ${result.exitCode ?? "?"}`
}

async function run(
  host: ServiceHost,
  script: string,
  {
    stdin,
    timeoutMs = ENGINE_COMMAND_TIMEOUT_MS,
    maxOutputBytes = ENGINE_OUTPUT_BYTES,
  }: { stdin?: Buffer; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<ExecResult> {
  return host.exec(shScript(script), { stdin, timeoutMs, maxOutputBytes })
}

function failed(result: ExecResult): boolean {
  return result.exitCode !== 0 || result.timedOut
}

// ---- Finding the engine -----------------------------------------------------

export type EngineFound = { engine: ServiceEngine; version: string }

const DETECT = [
  "if command -v docker >/dev/null 2>&1; then",
  "  echo docker; docker version --format '{{.Server.Version}}'",
  "elif command -v podman >/dev/null 2>&1; then",
  "  echo podman; podman version --format '{{.Version}}'",
  "else",
  "  echo none",
  "fi",
].join("\n")

/**
 * Which engine the SSH server's login can use, and its version: Docker
 * first, then Podman. A Docker whose daemon the login may not reach is said
 * so, with the engine's words.
 */
export async function detectEngine(host: ServiceHost): Promise<EngineFound> {
  const result = await run(host, DETECT)
  const [first, second] = text(result.stdout).trim().split(/\r?\n/)

  if (first === "none") {
    throw new EngineError(
      `Neither Docker nor Podman is installed for the login PCP uses on ${host.name}. Install one there; PCP only uses an engine that is already running.`,
    )
  }

  if ((first !== "docker" && first !== "podman") || failed(result)) {
    throw new EngineError(
      `${host.name}'s ${first === "podman" ? "Podman" : "Docker"} did not answer: ${said(result, [])}${/permission denied/i.test(text(result.stderr)) ? " The login PCP uses may need to be in the docker group." : ""}`,
    )
  }

  const version = (second ?? "").trim()

  return {
    engine: first,
    version: /^[0-9A-Za-z.+~-]{1,40}$/.test(version) ? version : "",
  }
}

// ---- Images -----------------------------------------------------------------

/** Pulls an image by digest; what an update or a launch starts with. */
export async function pullImage(
  host: ServiceHost,
  engine: ServiceEngine,
  image: string,
): Promise<void> {
  if (!IMAGE_BY_DIGEST.test(image)) {
    throw new EngineError("An image is pulled by digest.")
  }

  const result = await run(
    host,
    commandLine([program(engine), "pull", "--quiet", image]),
    { timeoutMs: ENGINE_PULL_TIMEOUT_MS },
  )

  if (failed(result)) {
    throw new EngineError(
      `${host.name} could not pull ${image}: ${result.timedOut ? "it took too long" : said(result, [])}`,
    )
  }
}

/**
 * Pulls `source` (repository:tag) on the SSH server and answers the digest
 * it has now, as `repository@sha256:…`: what an update pins.
 */
export async function resolveDigest(
  host: ServiceHost,
  engine: ServiceEngine,
  source: string,
): Promise<string> {
  if (!IMAGE_BY_TAG.test(source)) {
    throw new EngineError("Name the image as repository:tag.")
  }

  const exe = program(engine)
  const result = await run(
    host,
    `${commandLine([exe, "pull", "--quiet", source])} >/dev/null && ${commandLine(
      [exe, "image", "inspect", "--format", "{{json .RepoDigests}}", source],
    )}`,
    { timeoutMs: ENGINE_PULL_TIMEOUT_MS },
  )

  if (failed(result)) {
    throw new EngineError(
      `${host.name} could not pull ${source}: ${result.timedOut ? "it took too long" : said(result, [])}`,
    )
  }

  return pickDigest(text(result.stdout), source)
}

/** The digest of `source`'s repository among an image's RepoDigests. */
export function pickDigest(output: string, source: string): string {
  let digests: unknown

  try {
    digests = JSON.parse(output.trim())
  } catch {
    digests = null
  }

  const repository = imageRepository(source)
  const short = repository.replace(/^(docker\.io\/)?(library\/)?/, "")
  const found = (Array.isArray(digests) ? digests : []).find(
    (entry): entry is string =>
      typeof entry === "string" &&
      IMAGE_BY_DIGEST.test(entry) &&
      [
        repository,
        short,
        `docker.io/${short}`,
        `docker.io/library/${short}`,
      ].includes(imageRepository(entry)),
  )

  if (!found) {
    throw new EngineError(
      `The engine named no digest for ${source}; pin the image by digest yourself.`,
    )
  }

  return `${repository}@${found.slice(found.indexOf("@") + 1)}`
}

// ---- The container ----------------------------------------------------------

export type ContainerSpec = {
  /** The service's server id, put on the container as pcp.service. */
  serviceId: string
  containerName: string
  definition: ServiceDefinition
  publish: ServicePublish
}

/** A container name PCP gives one: pcp-<name>. */
export const CONTAINER_NAME = /^pcp-[a-z0-9][a-z0-9-]{0,60}$/

function checkName(name: string): string {
  if (!CONTAINER_NAME.test(name)) {
    throw new EngineError("A service's container is named pcp-<name>.")
  }

  return name
}

/** The variables as an env file: NAME=value, one a line. */
export function envFile(env: ServiceEnv): Buffer {
  const lines: string[] = []

  for (const [name, value] of Object.entries(env.values)) {
    if (!ENV_NAME.test(name)) {
      throw new EngineError(`${name} is not a variable's name.`)
    }

    // An env file has no quoting: a value is the rest of its line.
    if (/[\0\r\n]/.test(value)) {
      throw new EngineError(
        `The value for ${name} has a line break, which an engine's env file cannot carry. Keep it on one line.`,
      )
    }

    if (Buffer.byteLength(value) > MAX_ENV_SECRET_BYTES) {
      throw new EngineError(
        `The value for ${name} is longer than ${MAX_ENV_SECRET_BYTES / 1024} KB.`,
      )
    }

    lines.push(`${name}=${value}`)
  }

  return Buffer.from(lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8")
}

/**
 * The words of `run -d`: the label, restart policy, ports, named volumes,
 * an exit's capability and device, the env file at "$f" (the script's own temporary file), the image and its
 * arguments. "$f" is the one word left for the shell to expand.
 */
export function runWords(engine: ServiceEngine, spec: ContainerSpec): string[] {
  const name = checkName(spec.containerName)
  const { definition, publish } = spec
  const words = [
    program(engine),
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    `pcp.service=${spec.serviceId}`,
    "--restart",
    "unless-stopped",
  ]
  const address = publish.address.includes(":")
    ? `[${publish.address}]`
    : publish.address

  for (const { container } of definition.ports) {
    const published = publish.ports.find(
      (entry) => entry.container === container,
    )

    if (!published) {
      throw new EngineError(`The service's port ${container} has no host port.`)
    }

    words.push("--publish", `${address}:${published.host}:${container}`)
  }

  for (const volume of definition.volumes) {
    words.push("--volume", `${volumeOnHost(name, volume.name)}:${volume.path}`)
  }

  // An exit's VPN client: from the two allow-lists only, checked again here
  // whatever the definition went through.
  for (const capability of definition.cap_add) {
    if (!(ALLOWED_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new EngineError(`PCP does not give a container ${capability}.`)
    }

    words.push("--cap-add", capability)
  }

  for (const device of definition.devices) {
    if (!(ALLOWED_DEVICES as readonly string[]).includes(device)) {
      throw new EngineError(`PCP does not pass ${device} into a container.`)
    }

    words.push("--device", device)
  }

  if (!IMAGE_BY_DIGEST.test(definition.image)) {
    throw new EngineError("A service's image is pinned by digest.")
  }

  // The image's arguments follow it: nothing after it is the engine's.
  words.push("--env-file", "\0ENVFILE\0", definition.image, ...definition.args)
  return words
}

/** The script that writes the env file, runs `run -d`, and deletes the file. */
export function runScript(engine: ServiceEngine, spec: ContainerSpec): string {
  const line = runWords(engine, spec)
    .map((word) => (word === "\0ENVFILE\0" ? '"$f"' : shellQuote(word)))
    .join(" ")

  return [
    "umask 077",
    "f=$(mktemp) || exit 1",
    "trap 'rm -f \"$f\"' EXIT",
    'cat > "$f" || exit 1',
    line,
  ].join("\n")
}

/**
 * Creates and starts the container, with the variables over standard
 * input. Refused when one by that name is there already.
 */
export async function runContainer(
  host: ServiceHost,
  engine: ServiceEngine,
  spec: ContainerSpec,
  env: ServiceEnv,
): Promise<void> {
  const result = await run(host, runScript(engine, spec), {
    stdin: envFile(env),
    timeoutMs: ENGINE_PULL_TIMEOUT_MS,
  })

  if (failed(result)) {
    throw new EngineError(
      `${host.name} did not start ${spec.containerName}: ${said(result, env.redact)}`,
    )
  }
}

/** Removes the container (never its volumes, but when asked to). */
export async function removeContainer(
  host: ServiceHost,
  engine: ServiceEngine,
  containerName: string,
  { volumes = [] }: { volumes?: string[] } = {},
): Promise<void> {
  const exe = program(engine)
  const name = checkName(containerName)
  const parts = [`${commandLine([exe, "rm", "--force", name])} >/dev/null 2>&1`]

  if (volumes.length > 0) {
    parts.push(
      `${commandLine([exe, "volume", "rm", ...volumes.map((volume) => volumeOnHost(name, volume))])} >/dev/null 2>&1`,
    )
  }

  // Gone already is what was asked for.
  await run(host, `${parts.join("; ")}; true`)
}

export type ContainerAction = "start" | "stop" | "restart"

export async function containerAction(
  host: ServiceHost,
  engine: ServiceEngine,
  containerName: string,
  action: ContainerAction,
): Promise<void> {
  const exe = program(engine)
  const name = checkName(containerName)
  const words =
    action === "stop"
      ? [exe, "stop", "--time", String(STOP_GRACE_SECONDS), name]
      : action === "restart"
        ? [exe, "restart", "--time", String(STOP_GRACE_SECONDS), name]
        : [exe, "start", name]
  const result = await run(host, `${commandLine(words)} >/dev/null`, {
    timeoutMs: ENGINE_COMMAND_TIMEOUT_MS + STOP_GRACE_SECONDS * 1000,
  })

  if (failed(result)) {
    throw new EngineError(
      `${host.name} did not ${action} ${name}: ${said(result, [])}`,
    )
  }
}

// ---- Reading it -------------------------------------------------------------

export type ContainerState = {
  /** running | exited | created | paused | restarting | dead | missing */
  state: string
  /** healthy | unhealthy | starting, from the image's own check; null without one. */
  engineHealth: string | null
  startedAt: string | null
  exitCode: number | null
  /** What the engine said went wrong last, if anything. */
  error: string | null
  /** The image it was created from, as PCP named it (by digest). */
  image: string | null
  /** pcp.service on it: the service it belongs to. */
  serviceLabel: string | null
}

const INSPECT_FORMAT =
  "[{{json .State}},{{json .Config.Image}},{{json .Config.Labels}}]"

/**
 * The container's state, image and label, through a narrow format: never
 * its whole inspect, which carries the environment.
 */
export async function inspectContainer(
  host: ServiceHost,
  engine: ServiceEngine,
  containerName: string,
  redact: string[],
): Promise<ContainerState> {
  const result = await run(
    host,
    commandLine([
      program(engine),
      "inspect",
      "--type",
      "container",
      "--format",
      INSPECT_FORMAT,
      checkName(containerName),
    ]),
  )

  if (failed(result)) {
    if (/no such (container|object)|not found/i.test(text(result.stderr))) {
      return missingState()
    }

    throw new EngineError(
      `${host.name} could not read ${containerName}: ${said(result, redact)}`,
    )
  }

  return parseInspect(text(result.stdout), redact)
}

export function missingState(): ContainerState {
  return {
    state: "missing",
    engineHealth: null,
    startedAt: null,
    exitCode: null,
    error: null,
    image: null,
    serviceLabel: null,
  }
}

function short(value: unknown, max = 200): string | null {
  return typeof value === "string" && value
    ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, max)
    : null
}

/** What `inspect` with INSPECT_FORMAT wrote. */
export function parseInspect(output: string, redact: string[]): ContainerState {
  let parsed: unknown

  try {
    parsed = JSON.parse(output.trim().split(/\r?\n/)[0] ?? "")
  } catch {
    throw new EngineError(
      "The engine's answer about the container did not read.",
    )
  }

  const [state, image, labels] = Array.isArray(parsed) ? parsed : []
  const s = (state ?? {}) as Record<string, unknown>
  const health = (s.Health ?? s.Healthcheck) as
    Record<string, unknown> | undefined
  const scrub = makeRedactor(redact)
  const error = short(s.Error)

  return {
    state: short(s.Status, 40) ?? "unknown",
    engineHealth: short(health?.Status, 40),
    startedAt: short(s.StartedAt, 40),
    exitCode: typeof s.ExitCode === "number" ? s.ExitCode : null,
    error: error ? scrub.text(error) : null,
    image: short(image, 400),
    serviceLabel: short(
      (labels as Record<string, unknown> | null)?.["pcp.service"],
      100,
    ),
  }
}

export type LogsRequest = { lines: number; sinceMinutes?: number }

/**
 * The container's last lines, standard output and error together, with
 * times, bounded, the secrets taken out.
 */
export async function containerLogs(
  host: ServiceHost,
  engine: ServiceEngine,
  containerName: string,
  request: LogsRequest,
  redact: string[],
): Promise<{ text: string; truncated: boolean }> {
  const words = [
    program(engine),
    "logs",
    "--timestamps",
    "--tail",
    String(Math.trunc(request.lines)),
  ]

  if (request.sinceMinutes !== undefined) {
    words.push("--since", `${Math.trunc(request.sinceMinutes)}m`)
  }

  words.push(checkName(containerName))
  const result = await run(host, `${commandLine(words)} 2>&1`, {
    maxOutputBytes: MAX_LOG_BYTES,
  })

  if (result.exitCode !== 0 && !result.truncated) {
    throw new EngineError(
      `${host.name} could not read ${containerName}'s logs: ${said(result, redact)}`,
    )
  }

  return {
    text: makeRedactor(redact).text(text(result.stdout), {
      truncated: result.truncated,
    }),
    truncated: result.truncated,
  }
}
