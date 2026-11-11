import type { ExecResult } from "../ssh/client"
import { makeRedactor } from "../openapi/redact"
import {
  ALLOWED_CAPABILITIES,
  ALLOWED_DEVICES,
  ENV_NAME,
  IMAGE_BY_DIGEST,
  IMAGE_BY_TAG,
  imageRepository,
  LOCAL_IMAGE,
  volumeOnHost,
  type ServiceBuild,
  type ServiceDefinition,
  type ServiceFiles,
  type ServicePublish,
} from "./definition"
import {
  fileName,
  filesFolder,
  fileTar,
  firstTarEntry,
  TarError,
  type TarEntryType,
} from "./files"
import {
  BUILD_LOG_TAIL_BYTES,
  BUILD_TIMEOUT_MS,
  ENGINE_COMMAND_TIMEOUT_MS,
  ENGINE_OUTPUT_BYTES,
  ENGINE_PULL_TIMEOUT_MS,
  FILE_COPY_TIMEOUT_MS,
  FILE_PROBE_BYTES,
  FILE_TAR_OVERHEAD_BYTES,
  MAX_BUILD_SOURCE_BYTES,
  MAX_BUILT_IMAGE_BYTES,
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

  if (LOCAL_IMAGE.test(image)) {
    throw new EngineError(
      `${image} was built on the SSH server from a repository: it is never pulled.`,
    )
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

// ---- Building from a repository ----------------------------------------------

/** What the engine runs an image as: a built one by its id, `sha256:<id>`. */
export function runReference(image: string): string {
  return LOCAL_IMAGE.test(image) ? image.slice(image.indexOf("@") + 1) : image
}

/** The name a build's image is tagged with: localhost/pcp-<repository's name>. */
export function builtImageName(
  build: Pick<ServiceBuild, "repository">,
): string {
  const name =
    (build.repository.split("/")[1] ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "build"

  return `localhost/pcp-${name}`
}

/** Where the repository's tarball at the commit is, on GitHub: no redirect. */
export function buildSourceUrl(
  build: Pick<ServiceBuild, "repository" | "commit">,
): string {
  return `https://codeload.github.com/${build.repository}/tar.gz/${build.commit}`
}

/**
 * The script that builds: in a folder of its own (mktemp -d, removed on
 * exit however it ends) it downloads the repository at the commit with
 * curl or wget (whichever the login has; HTTPS only, bounded in time and
 * size), unpacks it, checks that the Containerfile and the build's folder
 * are inside it (not reached through a link out), builds with the engine
 * and writes the image id. Every word from the definition is quoted; the
 * only words left to the shell are its own variables.
 */
export function buildScript(
  engine: ServiceEngine,
  build: ServiceBuild,
): string {
  const exe = program(engine)
  const url = buildSourceUrl(build)
  const parts = build.containerfile.split("/")
  const base = parts.pop()!
  const fileDir = ["src", ...parts].join("/")
  const contextDir = build.context === "." ? "src" : `src/${build.context}`
  const limit = String(MAX_BUILD_SOURCE_BYTES)
  const refuse = (message: string, code: number) =>
    `{ echo ${shellQuote(message)} >&2; exit ${code}; }`
  const args = build.args.flatMap((arg) => [
    "--build-arg",
    `${arg.name}=${arg.value}`,
  ])

  return [
    "umask 022",
    "d=$(mktemp -d) || exit 1",
    `trap 'rm -rf "$d"' EXIT`,
    "trap 'exit 129' HUP INT TERM",
    'cd "$d" || exit 1',
    "if command -v curl >/dev/null 2>&1; then",
    `  ${commandLine(["curl", "-fsS", "--proto", "=https", "--max-time", "600", "--max-filesize", limit, "-o", "src.tar.gz", url])} || ${refuse(`PCP could not download ${build.repository} at ${build.commit} from GitHub (a public repository and a commit it has).`, 3)}`,
    "elif command -v wget >/dev/null 2>&1; then",
    `  ${commandLine(["wget", "-q", "-T", "60", "-O", "src.tar.gz", url])} || ${refuse(`PCP could not download ${build.repository} at ${build.commit} from GitHub (a public repository and a commit it has).`, 3)}`,
    "else",
    `  ${refuse("Neither curl nor wget is installed for the login PCP uses: PCP downloads the repository with one of them.", 4)}`,
    "fi",
    `command -v tar >/dev/null 2>&1 || ${refuse("tar is not installed for the login PCP uses: PCP unpacks the repository with it.", 4)}`,
    `[ "$(wc -c < src.tar.gz)" -le ${limit} ] || ${refuse(`The repository at that commit is larger than the ${MAX_BUILD_SOURCE_BYTES / 1024 / 1024} MB PCP builds.`, 5)}`,
    `mkdir src && tar -xzf src.tar.gz -C src --strip-components=1 --no-same-owner || ${refuse("The repository's download did not unpack.", 6)}`,
    "rm -f src.tar.gz",
    "s=$(cd src && pwd -P) || exit 6",
    `c=$(cd ${shellQuote(contextDir)} 2>/dev/null && pwd -P) || ${refuse(`There is no folder ${build.context} in the repository at that commit.`, 7)}`,
    `case "$c/" in "$s"/*) ;; *) ${refuse(`The build's folder ${build.context} leads out of the repository.`, 7)} ;; esac`,
    `f=$(cd ${shellQuote(fileDir)} 2>/dev/null && pwd -P) || ${refuse(`There is no ${build.containerfile} in the repository at that commit.`, 7)}`,
    `case "$f/" in "$s"/*) ;; *) ${refuse(`${build.containerfile} leads out of the repository.`, 7)} ;; esac`,
    `[ -f "$f"/${shellQuote(base)} ] && [ ! -L "$f"/${shellQuote(base)} ] || ${refuse(`There is no ${build.containerfile} in the repository at that commit.`, 7)}`,
    `${commandLine([exe, "build", "--file"])} "$f"/${shellQuote(base)} --iidfile "$d/iid" ${commandLine(["--tag", `${builtImageName(build)}:${build.commit.slice(0, 12)}`, ...args])} "$c" >"$d/log" 2>&1 || { tail -c ${BUILD_LOG_TAIL_BYTES} "$d/log" >&2; exit 8; }`,
    'cat "$d/iid"',
  ].join("\n")
}

/**
 * Builds the definition's repository at its commit on the SSH server and
 * answers the image it made, as `localhost/pcp-<name>@sha256:<id>`: what
 * the definition pins and a container runs by id. An image past
 * MAX_BUILT_IMAGE_BYTES is removed again and refused.
 */
export async function buildImage(
  host: ServiceHost,
  engine: ServiceEngine,
  build: ServiceBuild,
): Promise<string> {
  const result = await run(host, buildScript(engine, build), {
    timeoutMs: BUILD_TIMEOUT_MS,
  })

  if (failed(result)) {
    throw new EngineError(
      `${host.name} could not build ${build.repository} at ${build.commit.slice(0, 12)}: ${result.timedOut ? `it took longer than ${BUILD_TIMEOUT_MS / 60_000} minutes` : said(result, [])}`,
    )
  }

  const found = /^(?:sha256:)?([a-f0-9]{64})\s*$/.exec(
    text(result.stdout).trim(),
  )

  if (!found) {
    throw new EngineError(
      `${host.name}'s engine built ${build.repository} but named no image id.`,
    )
  }

  const id = `sha256:${found[1]}`
  const exe = program(engine)
  const size = await run(
    host,
    commandLine([exe, "image", "inspect", "--format", "{{.Size}}", id]),
  )
  const bytes = Number(text(size.stdout).trim())

  if (failed(size) || !Number.isFinite(bytes)) {
    throw new EngineError(
      `${host.name} could not read the size of the image it built: ${said(size, [])}`,
    )
  }

  if (bytes > MAX_BUILT_IMAGE_BYTES) {
    await run(host, `${commandLine([exe, "rmi", id])} >/dev/null 2>&1; true`)
    throw new EngineError(
      `The image built from ${build.repository} is ${Math.round(bytes / 1024 / 1024)} MB, more than the ${MAX_BUILT_IMAGE_BYTES / 1024 / 1024 / 1024} GB PCP keeps: it was removed again.`,
    )
  }

  return `${builtImageName(build)}@${id}`
}

/** Whether the SSH server still has an image PCP built (by its id). */
export async function imagePresent(
  host: ServiceHost,
  engine: ServiceEngine,
  image: string,
): Promise<boolean> {
  const result = await run(
    host,
    commandLine([
      program(engine),
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      runReference(image),
    ]),
  )

  if (!failed(result)) {
    return true
  }

  if (/no such image|image not known|not found/i.test(text(result.stderr))) {
    return false
  }

  throw new EngineError(
    `${host.name} could not look for the image ${image}: ${said(result, [])}`,
  )
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

  if (!definition.image || !IMAGE_BY_DIGEST.test(definition.image)) {
    throw new EngineError("A service's image is pinned by digest.")
  }

  // The image's arguments follow it: nothing after it is the engine's.
  words.push(
    "--env-file",
    "\0ENVFILE\0",
    runReference(definition.image),
    ...definition.args,
  )
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

/** What an engine says of a container or volume that is not there. */
const GONE =
  /no such (container|volume|object)|no container with name or id|no volume with name|not found/i

/**
 * Removes the container, and the named volumes asked for (never one that
 * was not). One that is gone already is what was asked for; anything else
 * the engine refuses (a volume in use, a daemon that does not answer) is
 * an EngineError naming what is left on the SSH server.
 */
export async function removeContainer(
  host: ServiceHost,
  engine: ServiceEngine,
  containerName: string,
  { volumes = [] }: { volumes?: string[] } = {},
): Promise<void> {
  const exe = program(engine)
  const name = checkName(containerName)
  const removed = await run(
    host,
    `${commandLine([exe, "rm", "--force", name])} >/dev/null`,
  )

  if (failed(removed) && !GONE.test(text(removed.stderr))) {
    throw new EngineError(
      `${host.name} did not remove the container ${name}: ${removed.timedOut ? "it took too long" : said(removed, [])}`,
    )
  }

  const left: string[] = []

  // One at a time: a volume that is gone does not hide another's failure.
  for (const volume of volumes) {
    const onHost = volumeOnHost(name, volume)
    const result = await run(
      host,
      `${commandLine([exe, "volume", "rm", onHost])} >/dev/null`,
    )

    if (failed(result) && !GONE.test(text(result.stderr))) {
      left.push(
        `${onHost} (${result.timedOut ? "it took too long" : said(result, [])})`,
      )
    }
  }

  if (left.length > 0) {
    throw new EngineError(
      `${host.name} removed the container ${name} but not the volume${left.length === 1 ? "" : "s"} ${left.join(", ")}`,
    )
  }
}

/**
 * Which of a container's named volumes are on the SSH server already (a
 * service removed before with its data kept): a launch that fails takes
 * back only the volumes it made itself.
 */
export async function existingVolumes(
  host: ServiceHost,
  engine: ServiceEngine,
  containerName: string,
  volumes: string[],
): Promise<string[]> {
  if (volumes.length === 0) {
    return []
  }

  const exe = program(engine)
  const name = checkName(containerName)
  const script = volumes
    .map(
      (volume, at) =>
        `if ${commandLine([exe, "volume", "inspect", volumeOnHost(name, volume)])} >/dev/null 2>&1; then echo ${at}; fi`,
    )
    .join("\n")
  const result = await run(host, script)

  if (failed(result)) {
    throw new EngineError(
      `${host.name} could not list ${name}'s volumes: ${said(result, [])}`,
    )
  }

  const found = new Set(text(result.stdout).trim().split(/\s+/))
  return volumes.filter((_, at) => found.has(String(at)))
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
  /** The id of that image, as the engine has it: sha256:<64 hex>. */
  imageId: string | null
  /** pcp.service on it: the service it belongs to. */
  serviceLabel: string | null
}

const INSPECT_FORMAT =
  "[{{json .State}},{{json .Config.Image}},{{json .Config.Labels}},{{json .Image}}]"

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
    imageId: null,
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

  const [state, image, labels, imageId] = Array.isArray(parsed) ? parsed : []
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
    imageId: imageIdOf(imageId),
    serviceLabel: short(
      (labels as Record<string, unknown> | null)?.["pcp.service"],
      100,
    ),
  }
}

/** An image id as Docker (sha256:<hex>) or Podman (<hex>) writes it. */
function imageIdOf(value: unknown): string | null {
  const found =
    typeof value === "string"
      ? /^(?:sha256:)?([a-f0-9]{64})$/.exec(value)
      : null
  return found ? `sha256:${found[1]}` : null
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

// ---- Files in its files folder ----------------------------------------------

/**
 * What a container has at a name in its files folder: nothing, a file, a
 * folder, a link or something else. The engine's own `cp` to standard
 * output (a tar stream), of which PCP reads only the start: no program in
 * the container runs, so an image without a shell works too.
 */
export async function probeContainerFile(
  host: ServiceHost,
  engine: ServiceEngine,
  containerName: string,
  files: ServiceFiles,
  name: string,
): Promise<TarEntryType | "none"> {
  const { path } = fileName(files, name)
  const result = await run(
    host,
    `${commandLine([program(engine), "cp", `${checkName(containerName)}:${path}`, "-"])} </dev/null`,
    { maxOutputBytes: FILE_PROBE_BYTES, timeoutMs: ENGINE_COMMAND_TIMEOUT_MS },
  )

  if (result.stdout.length > 0) {
    try {
      return firstTarEntry(result.stdout)?.type ?? "none"
    } catch (error) {
      if (error instanceof TarError) {
        throw new EngineError(
          `${host.name}'s engine answered for ${path} with what is not a tar stream.`,
        )
      }

      throw error
    }
  }

  if (failed(result)) {
    const words = text(result.stderr)

    if (/no such container|no container with name or id/i.test(words)) {
      throw new EngineError(
        `${containerName} is not on ${host.name}: start the service, or the owner makes it again on its page.`,
      )
    }

    if (
      /could not find|could not be found|no such file|does not exist|not exist/i.test(
        words,
      )
    ) {
      return "none"
    }

    throw new EngineError(
      `${host.name} could not look at ${path} in ${containerName}: ${result.timedOut ? "it took too long" : said(result, [])}`,
    )
  }

  return "none"
}

/**
 * Copies one file into the container's files folder with the engine's own
 * `cp -`, a tar stream of that one file on standard input (built here, the
 * name checked again): no shell in the container, no path on the SSH
 * server, the bytes never on a command line. The engine makes the folders
 * above it that are not there and writes it as the container's.
 */
export async function copyIntoContainer(
  host: ServiceHost,
  engine: ServiceEngine,
  containerName: string,
  files: ServiceFiles,
  name: string,
  bytes: Buffer,
): Promise<string> {
  const checked = fileName(files, name)
  const folder = filesFolder(files)
  const result = await run(
    host,
    `${commandLine([program(engine), "cp", "-", `${checkName(containerName)}:${folder}`])} >/dev/null`,
    {
      stdin: fileTar(checked.relative, bytes),
      timeoutMs: FILE_COPY_TIMEOUT_MS,
    },
  )

  if (failed(result)) {
    throw new EngineError(
      `${host.name} did not copy ${checked.path} into ${containerName}: ${result.timedOut ? "it took too long" : said(result, [])}`,
    )
  }

  return checked.path
}

/** A file in the container is larger than PCP reads back. */
export class ContainerFileTooLargeError extends Error {
  constructor(readonly path: string) {
    super(`${path} is larger than PCP keeps of one file.`)
    this.name = "ContainerFileTooLargeError"
  }
}

/**
 * Reads one file out of the container's files folder with the engine's
 * own `cp <container>:<path> -`: a tar stream on standard output, bounded
 * by the largest file PCP keeps plus the stream's own bytes. Only a
 * regular file: a folder, a link (never followed) or anything else is
 * refused.
 */
export async function copyOutOfContainer(
  host: ServiceHost,
  engine: ServiceEngine,
  containerName: string,
  files: ServiceFiles,
  name: string,
  maxBytes: number,
): Promise<{ path: string; name: string; bytes: Buffer } | null> {
  const checked = fileName(files, name)
  const result = await run(
    host,
    `${commandLine([program(engine), "cp", `${checkName(containerName)}:${checked.path}`, "-"])} </dev/null`,
    {
      maxOutputBytes: maxBytes + FILE_TAR_OVERHEAD_BYTES,
      timeoutMs: FILE_COPY_TIMEOUT_MS,
    },
  )

  if (result.truncated) {
    throw new ContainerFileTooLargeError(checked.path)
  }

  if (failed(result)) {
    const words = text(result.stderr)

    if (
      !/no such container|no container with name or id/i.test(words) &&
      /could not find|could not be found|no such file|does not exist|not exist/i.test(
        words,
      )
    ) {
      return null
    }

    throw new EngineError(
      `${host.name} could not copy ${checked.path} out of ${containerName}: ${result.timedOut ? "it took too long" : said(result, [])}`,
    )
  }

  let entry: ReturnType<typeof firstTarEntry>

  try {
    entry = firstTarEntry(result.stdout)
  } catch (error) {
    if (error instanceof TarError) {
      throw new EngineError(
        `${host.name}'s engine answered for ${checked.path} with what is not a tar stream.`,
      )
    }

    throw error
  }

  if (!entry) {
    return null
  }

  if (entry.type !== "file") {
    throw new EngineError(
      `${checked.path} in ${containerName} is ${entry.type === "folder" ? "a folder" : entry.type === "link" ? "a link, which PCP does not follow" : "not a regular file"}: get_file reads one file.`,
    )
  }

  if (entry.size > maxBytes) {
    throw new ContainerFileTooLargeError(checked.path)
  }

  if (!entry.data) {
    throw new EngineError(
      `${host.name}'s engine ended ${checked.path}'s tar stream early.`,
    )
  }

  return {
    path: checked.path,
    name: checked.relative.split("/").pop()!,
    bytes: entry.data,
  }
}
