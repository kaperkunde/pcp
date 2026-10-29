import { invalid } from "../errors"
import { diffLines, type DiffLine } from "../line-merge"
import { hiddenCharacter } from "../memories"
import { canonicalJson } from "../permission-rules"

import {
  refOf,
  serializeItem,
  type EndpointAuthDocument,
  type EndpointDocument,
  type ItemDocument,
  type ServerDocument,
  type ServiceDocument,
  type SkillDocument,
  type WrapperDocument,
} from "./documents"
import {
  ENDPOINT_YAML,
  itemPath,
  itemRoot,
  programFile,
  SKILL_MD,
  SPEC_JSON,
  SPEC_YAML,
  WRAPPER_YAML,
  type ItemRef,
} from "./layout"
/**
 * What an item from a repository would change, for the owner to read before
 * it is applied: every file, line by line, against the item as it is, and
 * each thing it would let an assistant or a document reach further, listed
 * on its own. Sync applies by itself only a change that is text and nothing
 * else (`textOnly`: a skill's description, steps or reference files, from a
 * read-and-write repository the owner trusts); everything else waits for
 * them.
 *
 * A server's item is its definition: an instance's address, sign-in,
 * read-only and public-only switches are its own and never change from a
 * repository (apply.ts), so none of them is flagged on a server the vault
 * has. A new one is flagged for the way it signs in; the owner gives its
 * address and secret when they add it.
 */

export type FlagKind =
  /** A tool's program is new or changed. */
  | "program"
  /** A tool calls a tool it did not. */
  | "calls"
  /** The calls a wrapper lists stop following the token's own levels. */
  | "call_levels"
  /** A secret goes somewhere new, or differently. */
  | "secret_binding"
  /** An endpoint's OpenAPI document, or PCP's edits to it, changed. */
  | "spec"
  /** How a new endpoint signs in: its kind and headers. */
  | "auth"
  /** How a new MCP server signs in: its kind and headers. */
  | "server_auth"
  /** A skill names a tool it did not. */
  | "skill_tools"
  /** A service runs another image, or a new service's image. */
  | "service_image"
  /**
   * A service's ports, variables, volumes, arguments, health check or what
   * it registers are new or change.
   */
  | "service"
  /** A file has a character that does not show on screen. */
  | "hidden_characters"
  /** A file has a character that does not show on screen. */
  | "hidden_characters"

export type ReviewFlag = { kind: FlagKind; path: string; message: string }

export type FileChange = {
  path: string
  change: "added" | "changed" | "removed" | "same"
  /** Against the file as it is; every line added for a new file. */
  diff: DiffLine[] | null
}

export type ItemReview = {
  ref: ItemRef
  /** There is no such item in the vault yet. */
  isNew: boolean
  /** Nothing would change. */
  same: boolean
  files: FileChange[]
  flags: ReviewFlag[]
  /**
   * Only a skill's description, steps or reference files (and with them its
   * version) change, and no flag is raised: what sync may apply from a
   * trusted repository without asking.
   */
  textOnly: boolean
}

export function fileChanges(
  before: Record<string, string>,
  after: Record<string, string>,
): FileChange[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])]

  return paths.sort().map((path) => {
    const old = before[path]
    const now = after[path]

    if (old === undefined) {
      return { path, change: "added", diff: diffLines("", now!) }
    }

    if (now === undefined) {
      return { path, change: "removed", diff: diffLines(old, "") }
    }

    return old === now
      ? { path, change: "same", diff: null }
      : { path, change: "changed", diff: diffLines(old, now) }
  })
}

function listed(values: string[]): string {
  return values.join(", ")
}

function wrapperFlags(
  current: WrapperDocument | null,
  incoming: WrapperDocument,
  ref: ItemRef,
): ReviewFlag[] {
  const flags: ReviewFlag[] = []
  const yamlPath = itemPath(ref, WRAPPER_YAML)

  for (const tool of incoming.tools) {
    const before = current?.tools.find((entry) => entry.name === tool.name)
    const path = itemPath(ref, programFile(tool.name))

    if (!before) {
      flags.push({
        kind: "program",
        path,
        message: `The tool ${tool.name} is new: its program runs with what it calls.`,
      })
    } else if (before.program !== tool.program) {
      flags.push({
        kind: "program",
        path,
        message: `The program of ${tool.name} changes.`,
      })
    }

    const added = tool.calls.filter((call) => !before?.calls.includes(call))

    if (added.length > 0) {
      flags.push({
        kind: "calls",
        path: yamlPath,
        message: `${tool.name} would call ${listed(added)}.`,
      })
    }
  }

  if (
    incoming.callLevels === "approved" &&
    (current?.callLevels ?? "token") !== "approved"
  ) {
    flags.push({
      kind: "call_levels",
      path: yamlPath,
      message:
        "The calls its tools list would run on your approval of the wrapper, not at each token's own levels.",
    })
  }

  const known = new Set(
    (current?.secrets ?? []).map((binding) => canonicalJson(binding)),
  )

  for (const binding of incoming.secrets) {
    if (!known.has(canonicalJson(binding))) {
      flags.push({
        kind: "secret_binding",
        path: yamlPath,
        message: `The secret "${binding.secret}" would go into ${binding.tool} at ${binding.argument}, as ${binding.template}.`,
      })
    }
  }

  return flags
}

function authLine(auth: EndpointAuthDocument): string {
  switch (auth.kind) {
    case "none":
      return "no credential"
    case "header":
      return `a secret in ${[auth.header, ...auth.headers.map((header) => header.header)].join(", ")}`
    case "basic":
      return "a user name and password"
    case "oauth":
      return `OAuth${auth.scope ? ` (scope ${auth.scope})` : ""}`
  }
}

/**
 * How a new server would sign in. A server the vault has keeps its own
 * sign-in whatever the repository says (sync never writes an instance's),
 * so that is flagged only for a new one, whose sign-in the owner gives when
 * adding it.
 */
function authFlag(
  current: ItemDocument | null,
  auth: EndpointAuthDocument,
  path: string,
  kind: "auth" | "server_auth",
): ReviewFlag[] {
  return current === null && auth.kind !== "none"
    ? [{ kind, path, message: `It signs in with ${authLine(auth)}.` }]
    : []
}

function endpointFlags(
  current: EndpointDocument | null,
  incoming: EndpointDocument,
  ref: ItemRef,
): ReviewFlag[] {
  const flags: ReviewFlag[] = []
  const yamlPath = itemPath(ref, ENDPOINT_YAML)
  const specPath = itemPath(
    ref,
    incoming.spec.format === "json" ? SPEC_JSON : SPEC_YAML,
  )

  if (
    !current ||
    current.spec.text !== incoming.spec.text ||
    current.spec.format !== incoming.spec.format
  ) {
    flags.push({
      kind: "spec",
      path: specPath,
      message: current
        ? "Its OpenAPI document changes: its tools may do other things."
        : "Its tools are made from this OpenAPI document.",
    })
  }

  if (
    current &&
    canonicalJson(current.patches) !== canonicalJson(incoming.patches)
  ) {
    flags.push({
      kind: "spec",
      path: yamlPath,
      message: "PCP's edits to its OpenAPI document change.",
    })
  }

  flags.push(...authFlag(current, incoming.auth, yamlPath, "auth"))

  return flags
}

function serverFlags(
  current: ServerDocument | null,
  incoming: ServerDocument,
  ref: ItemRef,
): ReviewFlag[] {
  return authFlag(current, incoming.auth, itemRoot(ref), "server_auth")
}
/**
 * What a service would run and reach: its image, then each part of its
 * definition that is new or changes. A new one lists all of it, for the
 * owner to read before they launch it.
 */
function serviceFlags(
  current: ServiceDocument | null,
  incoming: ServiceDocument,
  ref: ItemRef,
): ReviewFlag[] {
  const path = itemRoot(ref)
  const before = current?.definition ?? null
  const after = incoming.definition
  const flags: ReviewFlag[] = []
  const flag = (kind: FlagKind, message: string) =>
    flags.push({ kind, path, message })
  const changed = (pick: (definition: typeof after) => unknown) =>
    before === null ||
    canonicalJson(pick(before)) !== canonicalJson(pick(after))

  if (changed((definition) => definition.image)) {
    flag(
      "service_image",
      before
        ? `It runs another image: ${after.image} (was ${before.image}).`
        : `It runs the image ${after.image}.`,
    )
  }

  if (changed((definition) => definition.source ?? null)) {
    flag(
      "service_image",
      after.source
        ? `An update pulls ${after.source}.`
        : "It is updated by hand only: it names no image to update from.",
    )
  }

  if (changed((definition) => definition.ports)) {
    flag(
      "service",
      after.ports.length > 0
        ? `It listens on port ${listed(after.ports.map((port) => String(port.container)))}.`
        : "It publishes no port.",
    )
  }

  if (changed((definition) => definition.env)) {
    flag(
      "service",
      after.env.length > 0
        ? `Its variables: ${listed(after.env.map((entry) => (entry.value !== undefined ? `${entry.name}=${entry.value}` : `${entry.name}${entry.required ? " (needed)" : ""}`)))}.`
        : "It takes no variables.",
    )
  }

  if (changed((definition) => definition.volumes)) {
    flag(
      "service",
      after.volumes.length > 0
        ? `It keeps data in named volumes: ${listed(after.volumes.map((volume) => `${volume.name} at ${volume.path}`))}.`
        : "It keeps no volumes.",
    )
  }

  if (changed((definition) => definition.args)) {
    flag(
      "service",
      after.args.length > 0
        ? `It runs with the arguments ${listed(after.args)}.`
        : "It runs the image's own command.",
    )
  }

  if (changed((definition) => definition.health)) {
    flag(
      "service",
      after.health.kind === "http"
        ? `Its health check is GET ${after.health.path} on port ${after.health.port}.`
        : "It has no health check.",
    )
  }

  if (changed((definition) => definition.registers)) {
    const registers = after.registers
    flag(
      "service",
      registers.kind === "openapi"
        ? `PCP adds an API endpoint from ${registers.specPath} on port ${registers.port}${registers.auth ? `, sending ${registers.auth.env}'s secret in ${registers.auth.header}` : ""}.`
        : registers.kind === "mcp"
          ? `PCP adds an MCP server at ${registers.path} on port ${registers.port}.`
          : "PCP adds nothing for it.",
    )
  }

  return flags
}

function skillFlags(
  current: SkillDocument | null,
  incoming: SkillDocument,
  ref: ItemRef,
): ReviewFlag[] {
  const added = incoming.tools.filter((tool) => !current?.tools.includes(tool))

  return added.length > 0
    ? [
        {
          kind: "skill_tools",
          path: itemPath(ref, SKILL_MD),
          message: `The skill would name ${listed(added)}.`,
        },
      ]
    : []
}

function sameFamily(a: ItemDocument, b: ItemDocument): boolean {
  const family = (kind: ItemDocument["kind"]) =>
    kind === "flow" ? "wrapper" : kind
  return family(a.kind) === family(b.kind)
}

/**
 * The incoming item against the vault's (null: it has none), file by file,
 * with what it would let reach further. Pure: no database.
 */
export function reviewItem(
  current: ItemDocument | null,
  incoming: ItemDocument,
): ItemReview {
  if (current && !sameFamily(current, incoming)) {
    throw invalid(
      `${itemRoot(refOf(incoming))} is a ${incoming.kind}, and the item it would replace is a ${current.kind}.`,
    )
  }

  const ref = refOf(incoming)
  const before = current ? serializeItem(current) : {}
  const after = serializeItem(incoming)
  const files = fileChanges(before, after)
  const flags: ReviewFlag[] = []

  switch (incoming.kind) {
    case "skill":
      flags.push(...skillFlags(current as SkillDocument | null, incoming, ref))
      break
    case "wrapper":
    case "flow":
      flags.push(
        ...wrapperFlags(current as WrapperDocument | null, incoming, ref),
      )
      break
    case "endpoint":
      flags.push(
        ...endpointFlags(current as EndpointDocument | null, incoming, ref),
      )
      break
    case "server":
      flags.push(
        ...serverFlags(current as ServerDocument | null, incoming, ref),
      )
      break
    case "service":
      flags.push(
        ...serviceFlags(current as ServiceDocument | null, incoming, ref),
      )
      break
  }

  for (const [path, text] of Object.entries(after)) {
    const hidden = hiddenCharacter(text.replace(/\r\n?/g, "\n"))

    if (hidden) {
      flags.push({
        kind: "hidden_characters",
        path,
        message: `${path} has a character that does not show on screen (${hidden}).`,
      })
    }
  }

  const same = files.every((file) => file.change === "same")
  const textOnly =
    current !== null &&
    current.kind === "skill" &&
    incoming.kind === "skill" &&
    flags.length === 0 &&
    current.name === incoming.name &&
    canonicalJson(current.tools) === canonicalJson(incoming.tools) &&
    canonicalJson(current.extra) === canonicalJson(incoming.extra)

  return { ref, isNew: current === null, same, files, flags, textOnly }
}
