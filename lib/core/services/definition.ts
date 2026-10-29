import { isIP } from "node:net"

import { z } from "zod"

import { sha256Hex } from "../crypto"
import { invalid } from "../errors"
import { canonicalJson } from "../permission-rules"
import {
  MAX_ENV_DESCRIPTION_CHARS,
  MAX_ENV_VALUE_CHARS,
  MAX_IMAGE_CHARS,
  MAX_PATH_CHARS,
  MAX_SERVICE_ARG_CHARS,
  MAX_SERVICE_ARGS,
  MAX_SERVICE_DEFINITION_BYTES,
  MAX_SERVICE_ENV,
  MAX_SERVICE_PORTS,
  MAX_SERVICE_VOLUMES,
} from "./limits"

/**
 * What a service is (the definition its instances share) and where one runs
 * (the instance's own part), checked field by field. Every value that ends
 * up in an engine command passes one of the patterns here first, and is
 * then quoted (services/shell.ts): an image reference, a port, a variable's
 * name, a volume's name and path, an argument.
 *
 * - The image is pinned by digest (`repo@sha256:…`): what the owner approved
 *   is what runs. `source` is the tag an update resolves to a new digest.
 * - Volumes are named volumes only, named after the container
 *   (`pcp-<name>-<volume>`): never a path on the host, so a definition can
 *   neither read nor write the host's files.
 * - Environment variables are names here; their values are the owner's
 *   secrets, bound per instance, or a fixed value that is no secret. Values
 *   reach the host over standard input only.
 * - `registers` is what PCP adds for it in the same step: an API endpoint
 *   from the schema it serves, an MCP server, an exit (a VPN container's
 *   proxy, lib/core/exits/), or nothing.
 * - An exit's container is the one kind that may be given more than a
 *   container gets by default, and only from two allow-lists: the
 *   capability NET_ADMIN (`cap_add`) and the device /dev/net/tun
 *   (`devices`), what a VPN client needs for its tunnel. Its ports are
 *   published on the SSH server's loopback only (parsePublish), where PCP
 *   reaches its proxy through the SSH connection, never the network.
 */

// ---- Patterns ---------------------------------------------------------------

const DOMAIN_PART = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?"
const DOMAIN = `${DOMAIN_PART}(?:\\.${DOMAIN_PART})*(?::[0-9]{1,5})?`
const PATH_PART = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*"
const NAME = `(?:${DOMAIN}/)?${PATH_PART}(?:/${PATH_PART})*`

/** `repository@sha256:<64 hex>`, as Docker and Podman both take it. */
export const IMAGE_BY_DIGEST = new RegExp(`^${NAME}@sha256:[a-f0-9]{64}$`)
/** `repository:tag` (or a bare repository, meaning latest). */
export const IMAGE_BY_TAG = new RegExp(
  `^${NAME}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$`,
)
/** A variable's name, as POSIX shells and env files take one. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** A volume's own name; on the host it is `<container>-<name>`. */
export const VOLUME_NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/
/** An absolute path in the container: no `..`, no `:` or `,` (they split -v). */
const CONTAINER_PATH = /^\/(?:[A-Za-z0-9._@+-]+\/?)*$/
/** A path on the service's HTTP side, without a query. */
const HTTP_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/
/** A header's name, as HTTP allows one. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/
/** The repository part of an image reference, before its tag or digest. */
export function imageRepository(reference: string): string {
  const at = reference.indexOf("@")
  const base = at === -1 ? reference : reference.slice(0, at)
  const slash = base.lastIndexOf("/")
  const colon = base.lastIndexOf(":")
  return colon > slash ? base.slice(0, colon) : base
}

// ---- The definition ---------------------------------------------------------

const port = z.number().int().min(1).max(65535)
const httpPath = z
  .string()
  .max(MAX_PATH_CHARS)
  .regex(HTTP_PATH, { message: "A path starting with /, without a query." })
const envName = z.string().regex(ENV_NAME, {
  message:
    "A variable's name is letters, digits and underscores, not starting with a digit.",
})

const EnvSchema = z.strictObject({
  name: envName,
  description: z.string().max(MAX_ENV_DESCRIPTION_CHARS).default(""),
  /** Whether the service needs it: a launch refuses to start without it. */
  required: z.boolean().default(false),
  /**
   * The owner types its value per instance (a VPN provider's name, a
   * country): no secret, kept with the instance and shown on its page. A
   * secret bound to the name still overrides it.
   */
  plain: z.boolean().default(false),
  /**
   * A fixed value that is no secret (`LOG_LEVEL=info`), shared with every
   * instance; a secret bound to the name overrides it. For a `plain`
   * variable it is the value when the owner types none.
   */
  value: z
    .string()
    .max(MAX_ENV_VALUE_CHARS)
    .refine((value) => !/[\0\r\n]/.test(value), {
      message: "A fixed value is one line.",
    })
    .optional(),
})

const VolumeSchema = z.strictObject({
  name: z.string().regex(VOLUME_NAME, {
    message:
      "A volume's name is lowercase letters, digits, dots, dashes and underscores.",
  }),
  path: z
    .string()
    .max(MAX_PATH_CHARS)
    .regex(CONTAINER_PATH, {
      message: "Where it is mounted: an absolute path in the container.",
    })
    .refine(
      (value) =>
        !value.split("/").some((part) => part === ".." || part === "."),
      { message: "A mount path cannot go up with .." },
    ),
})

const HealthSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("http"), port, path: httpPath }),
  z.strictObject({ kind: z.literal("none") }),
])

/** An API endpoint's secret header, sent with the secret bound to `env`. */
const RegisterAuthSchema = z.strictObject({
  env: envName,
  header: z.string().regex(HEADER_NAME),
  template: z
    .string()
    .max(200)
    .refine((value) => value.includes("{{secret}}"), {
      message: "The header's value names {{secret}}.",
    }),
})

/**
 * The proxy's login, which PCP makes itself for each instance (a random
 * password, kept as a managed secret): `user_env` and `password_env` are
 * the variables the container reads them from. Neither is one of the
 * definition's own variables, so nobody binds or types them.
 */
const ExitAuthSchema = z.strictObject({
  user_env: envName,
  password_env: envName,
})

/** The capabilities a definition may add: NET_ADMIN only, for a VPN's tunnel. */
export const ALLOWED_CAPABILITIES = ["NET_ADMIN"] as const
/** The devices a definition may pass in: the tunnel device only. */
export const ALLOWED_DEVICES = ["/dev/net/tun"] as const

const RegistersSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("openapi"),
    port,
    /** Where the service serves its OpenAPI schema. */
    specPath: httpPath,
    /** What every operation's path is appended to. */
    basePath: httpPath.default("/"),
    auth: RegisterAuthSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("mcp"), port, path: httpPath }),
  /** A VPN container's proxy, which PCP adds as an exit. */
  z.strictObject({
    kind: z.literal("exit"),
    port,
    protocol: z.enum(["http", "socks5"]),
    auth: ExitAuthSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("none") }),
])

export const ServiceDefinitionSchema = z
  .strictObject({
    image: z.string().max(MAX_IMAGE_CHARS).regex(IMAGE_BY_DIGEST, {
      message:
        "The image, pinned by digest: repository@sha256:<64 hex digits>.",
    }),
    /** The tag an update resolves to a new digest; none: updates by hand. */
    source: z
      .string()
      .max(MAX_IMAGE_CHARS)
      .regex(IMAGE_BY_TAG, {
        message: "The image to update from, like ghcr.io/org/app:latest.",
      })
      .optional(),
    ports: z
      .array(z.strictObject({ container: port }))
      .max(MAX_SERVICE_PORTS)
      .default([]),
    env: z.array(EnvSchema).max(MAX_SERVICE_ENV).default([]),
    volumes: z.array(VolumeSchema).max(MAX_SERVICE_VOLUMES).default([]),
    /** Arguments after the image: the container's command. */
    args: z
      .array(
        z
          .string()
          .max(MAX_SERVICE_ARG_CHARS)
          .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
            message: "An argument has no control characters.",
          }),
      )
      .max(MAX_SERVICE_ARGS)
      .default([]),
    /** Capabilities the container gets on top of the engine's default. */
    cap_add: z
      .array(
        z.enum(ALLOWED_CAPABILITIES, {
          message: "A service can be given NET_ADMIN only, for an exit.",
        }),
      )
      .max(ALLOWED_CAPABILITIES.length)
      .default([]),
    /** Devices of the SSH server passed into the container. */
    devices: z
      .array(
        z.enum(ALLOWED_DEVICES, {
          message: "A service can be given /dev/net/tun only, for an exit.",
        }),
      )
      .max(ALLOWED_DEVICES.length)
      .default([]),
    health: HealthSchema.default({ kind: "none" }),
    registers: RegistersSchema.default({ kind: "none" }),
  })
  .superRefine((definition, issue) => {
    const ports = definition.ports.map((entry) => entry.container)
    const names = definition.env.map((entry) => entry.name)
    const volumes = definition.volumes.map((entry) => entry.name)
    const paths = definition.volumes.map((entry) => entry.path)

    const lists: Array<[Array<string | number>, string]> = [
      [ports, "port"],
      [names, "variable"],
      [volumes, "volume"],
      [paths, "mount path"],
      [definition.cap_add, "capability"],
      [definition.devices, "device"],
    ]

    for (const [list, what] of lists) {
      const twice = list.find((value, at) => list.indexOf(value) !== at)
      if (twice !== undefined) {
        issue.addIssue({
          code: "custom",
          message: `The ${what} ${twice} is named twice.`,
        })
      }
    }

    const needsPort = (what: string, value: number) => {
      if (!ports.includes(value)) {
        issue.addIssue({
          code: "custom",
          message: `${what} uses port ${value}, which the service does not publish.`,
        })
      }
    }

    if (definition.health.kind === "http") {
      needsPort("The health check", definition.health.port)
    }

    if (definition.registers.kind !== "none") {
      needsPort("What it registers", definition.registers.port)
    }

    if (
      definition.registers.kind !== "exit" &&
      (definition.cap_add.length > 0 || definition.devices.length > 0)
    ) {
      issue.addIssue({
        code: "custom",
        message:
          "Only an exit's container (registers kind exit) is given a capability or a device.",
      })
    }

    if (definition.registers.kind === "exit" && definition.registers.auth) {
      const { user_env, password_env } = definition.registers.auth

      if (user_env === password_env) {
        issue.addIssue({
          code: "custom",
          message: "The proxy's user and password are two variables.",
        })
      }

      for (const name of [user_env, password_env]) {
        if (names.includes(name)) {
          issue.addIssue({
            code: "custom",
            message: `${name} carries the proxy's login, which PCP makes itself: it is not one of the service's variables.`,
          })
        }
      }
    }

    if (
      definition.registers.kind === "openapi" &&
      definition.registers.auth &&
      !names.includes(definition.registers.auth.env)
    ) {
      issue.addIssue({
        code: "custom",
        message: `The endpoint's secret comes from ${definition.registers.auth.env}, which is not one of the service's variables.`,
      })
    }
  })

export type ServiceDefinition = z.output<typeof ServiceDefinitionSchema>
export type ServiceDefinitionInput = z.input<typeof ServiceDefinitionSchema>
export type ServiceRegisters = ServiceDefinition["registers"]

function problems(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join(" ")
}

/** A definition as the owner (or a linked repository) gives it, checked. */
export function parseServiceDefinition(value: unknown): ServiceDefinition {
  const parsed = ServiceDefinitionSchema.safeParse(value)

  if (!parsed.success) {
    throw invalid(`The service's definition: ${problems(parsed.error)}`)
  }

  if (
    Buffer.byteLength(JSON.stringify(parsed.data)) >
    MAX_SERVICE_DEFINITION_BYTES
  ) {
    throw invalid(
      `A service's definition is at most ${MAX_SERVICE_DEFINITION_BYTES / 1024} KB.`,
    )
  }

  return parsed.data
}

/** A stored definition (service_spec.definition), checked again as it is read. */
export function readServiceDefinition(json: string): ServiceDefinition {
  let value: unknown

  try {
    value = JSON.parse(json)
  } catch {
    throw invalid("The service's stored definition is not JSON.")
  }

  return parseServiceDefinition(value)
}

export function serviceDefinitionHash(definition: ServiceDefinition): string {
  return sha256Hex(canonicalJson(definition))
}

// ---- The instance's own part ------------------------------------------------

/** Where an exit's proxy is published: the SSH server's loopback, nothing else. */
export const EXIT_PUBLISH_ADDRESS = "127.0.0.1"

/** Where the container's ports are published on the SSH server. */
export type ServicePublish = {
  /** The host's address the ports are bound to: an IP literal. */
  address: string
  ports: Array<{ container: number; host: number }>
}

/** Which secret (by id) each variable takes. */
export type ServiceEnvBindings = Record<string, string>

/**
 * The publish settings, checked against the definition: one host port for
 * each of its ports, all different, on one IP address of the host.
 */
export function parsePublish(
  value: unknown,
  definition: ServiceDefinition,
): ServicePublish {
  const parsed = z
    .strictObject({
      address: z.string().max(64),
      ports: z.array(z.strictObject({ container: port, host: port })),
    })
    .safeParse(value)

  if (!parsed.success) {
    throw invalid(`Where the service is published: ${problems(parsed.error)}`)
  }

  const address = parsed.data.address.trim().replace(/^\[(.*)\]$/, "$1")

  if (isIP(address) === 0) {
    throw invalid(
      "Publish the service on an IP address of the SSH server: 0.0.0.0 for every address, 127.0.0.1 for that machine alone, or one of its own.",
    )
  }

  // An exit's proxy is reached through the SSH connection, on the SSH
  // server's own loopback: anywhere else, anyone on its network could use
  // it (and the VPN behind it).
  if (
    definition.registers.kind === "exit" &&
    address !== EXIT_PUBLISH_ADDRESS
  ) {
    throw invalid(
      `An exit's proxy is published on ${EXIT_PUBLISH_ADDRESS} only, the SSH server's own loopback: PCP reaches it through the SSH connection.`,
    )
  }

  const ports: ServicePublish["ports"] = []

  for (const { container } of definition.ports) {
    const found = parsed.data.ports.find(
      (entry) => entry.container === container,
    )

    if (!found) {
      throw invalid(
        `Choose the SSH server's port for the service's port ${container}.`,
      )
    }

    if (ports.some((entry) => entry.host === found.host)) {
      throw invalid(`The SSH server's port ${found.host} is chosen twice.`)
    }

    ports.push({ container, host: found.host })
  }

  if (parsed.data.ports.length !== ports.length) {
    throw invalid("Publish only the ports the service has.")
  }

  return { address, ports }
}

export function readPublish(json: string): ServicePublish {
  try {
    const value = JSON.parse(json) as Partial<ServicePublish>

    if (typeof value.address === "string" && Array.isArray(value.ports)) {
      return { address: value.address, ports: value.ports }
    }
  } catch {
    // Read as nothing published.
  }

  return { address: "127.0.0.1", ports: [] }
}

export function readEnvBindings(json: string): ServiceEnvBindings {
  try {
    const value = JSON.parse(json) as unknown

    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] =>
            ENV_NAME.test(entry[0]) && typeof entry[1] === "string",
        ),
      )
    }
  } catch {
    // Read as nothing bound.
  }

  return {}
}

/** The values the owner typed for a service's plain variables, by name. */
export type ServicePlainValues = Record<string, string>

export function readPlainValues(json: string): ServicePlainValues {
  return readEnvBindings(json)
}

/**
 * The values typed for plain variables, checked against the definition:
 * only its plain variables, each one line within bounds, no character that
 * does not show. The empty ones are left out.
 */
export function checkPlainValues(
  values: ServicePlainValues,
  definition: ServiceDefinition,
): ServicePlainValues {
  const known = new Map(definition.env.map((entry) => [entry.name, entry]))
  const checked: ServicePlainValues = {}

  for (const [name, raw] of Object.entries(values)) {
    const value = typeof raw === "string" ? raw.trim() : ""

    if (!value) {
      continue
    }

    const entry = known.get(name)

    if (!entry) {
      throw invalid(`The service has no variable called ${name}.`)
    }

    if (!entry.plain) {
      throw invalid(`${name} takes a secret of yours, not a value typed here.`)
    }

    if (value.length > MAX_ENV_VALUE_CHARS) {
      throw invalid(
        `The value for ${name} is at most ${MAX_ENV_VALUE_CHARS} characters.`,
      )
    }

    if (
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(
        value,
      )
    ) {
      throw invalid(`The value for ${name} is one line of plain text.`)
    }

    checked[name] = value
  }

  return checked
}

/**
 * The bindings, checked against the definition: only its variables, and
 * every required one either bound, given a typed value (`values`, its plain
 * ones) or a fixed value.
 */
export function checkEnvBindings(
  bindings: ServiceEnvBindings,
  definition: ServiceDefinition,
  values: ServicePlainValues = {},
): ServiceEnvBindings {
  const known = new Map(definition.env.map((entry) => [entry.name, entry]))
  const checked: ServiceEnvBindings = {}

  for (const [name, secretId] of Object.entries(bindings)) {
    if (!secretId) {
      continue
    }

    if (!known.has(name)) {
      throw invalid(`The service has no variable called ${name}.`)
    }

    checked[name] = secretId
  }

  for (const entry of definition.env) {
    if (
      entry.required &&
      !checked[entry.name] &&
      !values[entry.name] &&
      entry.value === undefined
    ) {
      throw invalid(
        entry.plain
          ? `Type the value for ${entry.name}: the service needs it.`
          : `Choose the secret for ${entry.name}: the service needs it.`,
      )
    }
  }

  const auth =
    definition.registers.kind === "openapi" ? definition.registers.auth : null

  if (auth && !checked[auth.env]) {
    throw invalid(
      `Choose the secret for ${auth.env}: the endpoint sends it in ${auth.header}.`,
    )
  }

  return checked
}

/** Loopback addresses: the SSH server's own machine only. */
export function isLoopback(address: string): boolean {
  return address === "::1" || /^127\./.test(address) || address === "localhost"
}

function isWildcard(address: string): boolean {
  return address === "0.0.0.0" || address === "::"
}

/**
 * The host name PCP reaches a published port at: the SSH server's address
 * when the port is bound to every address, the bound address otherwise.
 * Null when the port is on the SSH server's loopback and PCP is not on that
 * machine (until it can reach it through the SSH connection).
 */
export function reachHost(
  publish: ServicePublish,
  sshHost: string,
): string | null {
  if (isWildcard(publish.address)) {
    return sshHost
  }

  if (isLoopback(publish.address) && !isLoopback(sshHost)) {
    return null
  }

  return publish.address
}

/** `http://host:port`, for a container port PCP can reach; null otherwise. */
export function reachUrl(
  publish: ServicePublish,
  sshHost: string,
  containerPort: number,
): string | null {
  const host = reachHost(publish, sshHost)
  const published = publish.ports.find(
    (entry) => entry.container === containerPort,
  )

  if (!host || !published) {
    return null
  }

  return `http://${host.includes(":") ? `[${host}]` : host}:${published.host}`
}

/** The volume's name on the host. */
export function volumeOnHost(containerName: string, volume: string): string {
  return `${containerName}-${volume}`
}
