import { invalid } from "../errors"
import { diffLines, type DiffLine } from "../line-merge"
import { hiddenCharacter } from "../memories"
import { canonicalJson } from "../permission-rules"

import {
  refOf,
  serializeItem,
  type EndpointAuthDocument,
  type EndpointDocument,
  type HeaderDocument,
  type ItemDocument,
  type ServerDocument,
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
 * repository the owner trusts); everything else waits for them.
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
  /** An endpoint's requests go to another address. */
  | "base_url"
  /** An endpoint's OpenAPI document, or PCP's edits to it, changed. */
  | "spec"
  /** An endpoint offers more than reading. */
  | "read_only_off"
  /** How an endpoint signs in changed: its kind, header, login or client. */
  | "auth"
  /** A secret named for a credential changed. */
  | "secret_name"
  /** Private and local addresses are no longer refused. */
  | "public_only_off"
  /** An MCP server's address changed. */
  | "server_url"
  /** How an MCP server signs in changed, secrets included. */
  | "server_auth"
  /** A skill names a tool it did not. */
  | "skill_tools"
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

function fileChanges(
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

function secretsOf(auth: EndpointAuthDocument): Array<string | null> {
  switch (auth.kind) {
    case "none":
      return []
    case "header":
      return [auth.secret, ...auth.headers.map((header) => header.secret)]
    case "basic":
      return [auth.secret]
    case "oauth":
      return [auth.clientSecret]
  }
}

/** The auth without its secrets' names: its kind and where things go. */
function shapeOfAuth(auth: EndpointAuthDocument): string {
  const header = ({ header, template }: HeaderDocument) => ({
    header,
    template,
  })

  switch (auth.kind) {
    case "none":
      return canonicalJson({ kind: "none" })
    case "header":
      return canonicalJson({
        kind: "header",
        ...header(auth),
        headers: auth.headers.map(header),
      })
    case "basic":
      return canonicalJson({ kind: "basic", username: auth.username })
    case "oauth":
      return canonicalJson({
        kind: "oauth",
        clientId: auth.clientId,
        scope: auth.scope,
        authorizeParams: auth.authorizeParams,
      })
  }
}

function authLine(auth: EndpointAuthDocument): string {
  switch (auth.kind) {
    case "none":
      return "no credential"
    case "header":
      return `the secret "${auth.secret ?? "(none)"}" in ${auth.header}${auth.headers.map((header) => `, "${header.secret ?? "(none)"}" in ${header.header}`).join("")}`
    case "basic":
      return `${auth.username} with the secret "${auth.secret ?? "(none)"}"`
    case "oauth":
      return `OAuth${auth.clientId ? ` with the client ${auth.clientId}` : ""}`
  }
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

  if (!current || current.baseUrl !== incoming.baseUrl) {
    flags.push({
      kind: "base_url",
      path: yamlPath,
      message: `Its requests would go to ${incoming.baseUrl}${current ? `, not ${current.baseUrl}` : ""}.`,
    })
  }

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

  if (current?.readOnly && !incoming.readOnly) {
    flags.push({
      kind: "read_only_off",
      path: yamlPath,
      message: "It would offer every operation, not only those that read.",
    })
  }

  if (
    (!current && incoming.auth.kind !== "none") ||
    (current && shapeOfAuth(current.auth) !== shapeOfAuth(incoming.auth))
  ) {
    flags.push({
      kind: "auth",
      path: yamlPath,
      message: `It would sign in with ${authLine(incoming.auth)}${current ? `, not ${authLine(current.auth)}` : ""}.`,
    })
  }

  const names = secretsOf(incoming.auth)

  if (
    (!current && names.some((name) => name !== null)) ||
    (current && canonicalJson(secretsOf(current.auth)) !== canonicalJson(names))
  ) {
    flags.push({
      kind: "secret_name",
      path: yamlPath,
      message: `It would send ${listed(names.map((name) => `"${name ?? "(none)"}"`))}.`,
    })
  }

  if (current?.publicOnly && !incoming.publicOnly) {
    flags.push({
      kind: "public_only_off",
      path: yamlPath,
      message:
        "Private, loopback and link-local addresses would no longer be refused.",
    })
  }

  return flags
}

function serverFlags(
  current: ServerDocument | null,
  incoming: ServerDocument,
  ref: ItemRef,
): ReviewFlag[] {
  const flags: ReviewFlag[] = []
  const path = itemRoot(ref)

  if (!current || current.url !== incoming.url) {
    flags.push({
      kind: "server_url",
      path,
      message: `PCP would connect to ${incoming.url}${current ? `, not ${current.url}` : ""}.`,
    })
  }

  if (
    (!current && incoming.auth.kind !== "none") ||
    (current && canonicalJson(current.auth) !== canonicalJson(incoming.auth))
  ) {
    flags.push({
      kind: "server_auth",
      path,
      message: `It would sign in with ${authLine(incoming.auth)}${current ? `, not ${authLine(current.auth)}` : ""}.`,
    })
  }

  if (current?.publicOnly && !incoming.publicOnly) {
    flags.push({
      kind: "public_only_off",
      path,
      message:
        "Private, loopback and link-local addresses would no longer be refused.",
    })
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
