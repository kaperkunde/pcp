import YAML from "yaml"
import { z } from "zod"

import { checkSyntax } from "../code/quickjs"
import { SECRET_PLACEHOLDER } from "../constants"
import { generateEndpointTools } from "../endpoints"
import { invalid, isPcpError, PcpError } from "../errors"
import { hiddenCharacter, withoutPresentation } from "../memories"
import { normalizeAuthorizeParams } from "../oauth-client"
import { MAX_TOOL_DESCRIPTION } from "../openapi/limits"
import { readPatches, type PatchOperation } from "../openapi/patch"
import { validateBaseUrl } from "../openapi/urls"
import { validateSecretName } from "../secrets"
import {
  normalizeNameAndDescription,
  validateServerUrl,
  validateUsername,
} from "../servers"
import {
  checkArrivedSkill,
  parseSkillMd,
  serializeSkillMd,
  type SkillExtra,
  type SkillFile,
} from "../skills"
import { readStrictYaml } from "../strict-yaml"
import {
  splitRef,
  type CallLevels,
  type WrapperAnnotations,
} from "../wrappers/definition"
import {
  MAX_ARGUMENT_POINTER_CHARS,
  MAX_PROGRAM_CHARS,
  MAX_SECRET_TEMPLATE_CHARS,
  MAX_WRAPPER_DESCRIPTION_CHARS,
  MAX_WRAPPER_TOOLS,
} from "../wrappers/limits"

import {
  ENDPOINT_YAML,
  groupRepoFiles,
  itemPath,
  itemRoot,
  checkItemSize,
  programFile,
  SKILL_MD,
  SPEC_JSON,
  SPEC_YAML,
  WRAPPER_YAML,
  type ItemFiles,
  type ItemRef,
  type ItemShape,
  type RepoFiles,
  type RepoProblem,
} from "./layout"
import { MAX_DOCUMENT_DEPTH } from "./limits"

/**
 * Shared items as files in a linked repository, and back: a skill, a
 * wrapper (or a browser flow, which is one), an API endpoint and an MCP
 * server, each in its native format where it has one (an Agent Skill's
 * SKILL.md, a wrapper tool's program as JavaScript, an OpenAPI document as
 * PCP holds it) and in a YAML document of PCP's otherwise. Layout is
 * layout.ts's.
 *
 * Nothing in a document is a secret or the vault's: secrets are named by
 * their names only, an OAuth client by its ID, and no value, token, id of a
 * row or address PCP found out itself is ever written. Every document read
 * is untrusted input: YAML is read plain (strict-yaml.ts: no anchors,
 * aliases or tags), nothing that does not show on screen is taken, and each
 * kind's own checks (skills.ts, wrappers/definition.ts, openapi/) run on
 * what it says before anything is proposed from it.
 *
 * Formats. Every document carries `pcp_format`, the version of its shape
 * (a SKILL.md written elsewhere may leave it out: it reads as 1). A parser
 * reads every format up to PCP_FORMAT, and refuses a newer one in so many
 * words, so an older PCP never half-reads what a newer one wrote. A change to
 * a document's shape stays backward compatible: a field is added with a
 * default (what a document without it has always meant), never repurposed
 * or removed, and PCP_FORMAT goes up by one. A document's own `version`
 * (a skill's version, or the syncVersion of a server row) is something
 * else: it counts changes to the item.
 *
 * Format 2 carries a server's definition only (definitions.ts): what every
 * instance of it shares. Where an instance is (an endpoint's base URL, an
 * MCP server's address), whether it is read-only or limited to public
 * addresses, which of the owner's secrets it signs in with, the user name
 * of a basic login and an OAuth client's ID are each instance's own, so a
 * format-2 document has none of them: its sign-in is the way it signs in
 * (the kind, the headers and their formats, an OAuth scope), never with
 * what. A format-1 document still reads: what it says of its instance is
 * kept apart (`instance`), used only to fill in the first instance when it
 * is added, and never written over a server the vault has.
 */

/** The newest document format this PCP reads and writes. */
export const PCP_FORMAT = 2

// ---- Documents --------------------------------------------------------------

export type SkillDocument = {
  kind: "skill"
  /** The skill's name, which is also its folder's. */
  name: string
  version: number
  description: string
  body: string
  tools: string[]
  extra: SkillExtra
  files: SkillFile[]
}

export type WrapperToolDocument = {
  name: string
  title: string | null
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations: WrapperAnnotations | null
  /** Other tools, as server/tool by the server's short name. */
  calls: string[]
  replaces: string[]
  program: string
}

export type SecretBindingDocument = {
  /** The secret's name, never its value. */
  secret: string
  /** server/tool. */
  tool: string
  /** A JSON Pointer into that tool's arguments. */
  argument: string
  template: string
}

export type WrapperDocument = {
  kind: "wrapper" | "flow"
  /** The wrapper's short name (its slug), which is also its folder's. */
  name: string
  version: number
  /** What people see it called. */
  displayName: string
  description: string
  callLevels: CallLevels
  tools: WrapperToolDocument[]
  secrets: SecretBindingDocument[]
}

/** A header a secret goes in; `secret` null: none chosen yet. */
export type HeaderDocument = {
  header: string
  template: string
  secret: string | null
}

export type HeaderAuthDocument = { kind: "header" } & HeaderDocument & {
    /** Further headers, sent with the first. */
    headers: HeaderDocument[]
  }

export type OAuthDocument = {
  kind: "oauth"
  /** A client the owner made with the provider; null: PCP registers. */
  clientId: string | null
  /** The name of the secret holding that client's secret. */
  clientSecret: string | null
  scope: string | null
  authorizeParams: string | null
}

export type EndpointAuthDocument =
  | { kind: "none" }
  | HeaderAuthDocument
  /** username null: the instance's own (format 2 names none). */
  | { kind: "basic"; username: string | null; secret: string | null }
  | OAuthDocument

export type ServerAuthDocument =
  { kind: "none" } | HeaderAuthDocument | OAuthDocument

/**
 * What a format-1 document said of the server it was written from: its
 * address and switches. Format 2 leaves them out (each instance has its
 * own); PCP takes them only as what the first instance starts with when the
 * owner adds the item, never onto a server the vault has.
 */
export type InstanceHint = {
  /** An endpoint's base URL, an MCP server's address. */
  url: string
  /** An endpoint's; undefined for an MCP server. */
  readOnly?: boolean
  publicOnly: boolean
}

export type EndpointDocument = {
  kind: "endpoint"
  name: string
  version: number
  displayName: string
  description: string
  /** Only from a format-1 document: see InstanceHint. Never written. */
  instance: InstanceHint | null
  /** The OpenAPI document as PCP holds it, in the format it came in. */
  spec: { format: "json" | "yaml"; text: string }
  patches: PatchOperation[]
  /** The owner's wording of a tool's description, by tool. */
  toolDescriptions: Record<string, string>
  auth: EndpointAuthDocument
}

export type ServerDocument = {
  kind: "server"
  name: string
  version: number
  displayName: string
  description: string
  /** Only from a format-1 document: see InstanceHint. Never written. */
  instance: InstanceHint | null
  auth: ServerAuthDocument
}

export type ItemDocument =
  SkillDocument | WrapperDocument | EndpointDocument | ServerDocument

export function refOf(document: ItemDocument): ItemRef {
  return { kind: document.kind, name: document.name }
}

export function shapeOf(document: ItemDocument): ItemShape {
  switch (document.kind) {
    case "skill":
      return {
        kind: "skill",
        name: document.name,
        files: document.files.map((file) => file.path),
      }
    case "wrapper":
    case "flow":
      return {
        kind: document.kind,
        name: document.name,
        tools: document.tools.map((tool) => tool.name),
      }
    case "endpoint":
      return {
        kind: "endpoint",
        name: document.name,
        spec: document.spec.format,
      }
    case "server":
      return { kind: "server", name: document.name }
  }
}

/** Whether an OpenAPI document's text is JSON (else YAML). */
export function specFormat(text: string): "json" | "yaml" {
  return text.replace(/^﻿/, "").trim().startsWith("{") ? "json" : "yaml"
}

// ---- Writing ----------------------------------------------------------------

function yaml(value: unknown): string {
  return YAML.stringify(value, {
    version: "1.2",
    lineWidth: 0,
    aliasDuplicateObjects: false,
  })
}

/** The line above a tool's program in its file. */
export function programHeader(wrapper: string, tool: string): string {
  return `${headerStart(tool)}${wrapper}${HEADER_END}`
}

function headerStart(tool: string): string {
  return `// ${tool}: a tool of the PCP wrapper `
}

const HEADER_END =
  ". This is the body of an async function; its arguments are in `args`."

function headerYaml(header: HeaderDocument) {
  return { header: header.header, template: header.template }
}

/**
 * How a server signs in, as format 2 writes it: the way, never with what.
 * The secrets' names, a basic login's user name and an OAuth client are the
 * instance's own.
 */
function authYaml(auth: EndpointAuthDocument) {
  switch (auth.kind) {
    case "none":
      return { kind: "none" }
    case "header":
      return {
        kind: "header",
        ...headerYaml(auth),
        ...(auth.headers.length > 0
          ? { headers: auth.headers.map(headerYaml) }
          : {}),
      }
    case "basic":
      return { kind: "basic" }
    case "oauth":
      return {
        kind: "oauth",
        ...(auth.scope !== null ? { scope: auth.scope } : {}),
        ...(auth.authorizeParams !== null
          ? { authorizeParams: auth.authorizeParams }
          : {}),
      }
  }
}

/**
 * An item as files, by path from the repository's root. Deterministic: the
 * same item is always the same text, so a hash of it (hash.ts) changes only
 * when the item does.
 */
export function serializeItem(document: ItemDocument): RepoFiles {
  const ref = refOf(document)
  const files: RepoFiles = {}

  switch (document.kind) {
    case "skill": {
      files[itemPath(ref, SKILL_MD)] = serializeSkillMd(document, {
        format: PCP_FORMAT,
      })

      for (const file of [...document.files].sort((a, b) =>
        a.path.localeCompare(b.path),
      )) {
        files[itemPath(ref, file.path)] = file.text
      }

      break
    }

    case "wrapper":
    case "flow": {
      files[itemPath(ref, WRAPPER_YAML)] = yaml({
        pcp_format: PCP_FORMAT,
        version: document.version,
        name: document.displayName,
        description: document.description,
        callLevels: document.callLevels,
        tools: document.tools.map((tool) => ({
          name: tool.name,
          ...(tool.title !== null ? { title: tool.title } : {}),
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          calls: tool.calls,
          ...(tool.replaces.length > 0 ? { replaces: tool.replaces } : {}),
        })),
        ...(document.secrets.length > 0
          ? {
              secrets: document.secrets.map((binding) => ({
                secret: binding.secret,
                tool: binding.tool,
                argument: binding.argument,
                template: binding.template,
              })),
            }
          : {}),
      })

      for (const tool of document.tools) {
        files[itemPath(ref, programFile(tool.name))] =
          `${programHeader(document.name, tool.name)}\n${tool.program}\n`
      }

      break
    }

    case "endpoint": {
      files[
        itemPath(ref, document.spec.format === "json" ? SPEC_JSON : SPEC_YAML)
      ] = document.spec.text
      files[itemPath(ref, ENDPOINT_YAML)] = yaml({
        pcp_format: PCP_FORMAT,
        version: document.version,
        name: document.displayName,
        description: document.description,
        auth: authYaml(document.auth),
        ...(document.patches.length > 0 ? { patches: document.patches } : {}),
        ...(Object.keys(document.toolDescriptions).length > 0
          ? {
              toolDescriptions: Object.fromEntries(
                Object.entries(document.toolDescriptions).sort(([a], [b]) =>
                  a.localeCompare(b),
                ),
              ),
            }
          : {}),
      })
      break
    }

    case "server": {
      files[itemRoot(ref)] = yaml({
        pcp_format: PCP_FORMAT,
        version: document.version,
        name: document.displayName,
        description: document.description,
        auth: authYaml(document.auth),
      })
      break
    }
  }

  return files
}

// ---- Reading ----------------------------------------------------------------

/** Where in a document a string is prose, whose presentation selectors go. */
type Prose = (path: Array<string | number>) => boolean

/**
 * A PCP document's YAML, read plain and checked all through: nothing that
 * does not show on screen in any key or string (prose loses its emoji
 * presentation selectors first, as text arriving in PCP does), every number
 * finite, nesting bounded.
 */
function readDocument(text: string, what: string, prose: Prose): unknown {
  const value = readStrictYaml(text.replace(/\r\n?/g, "\n"), what)

  const walk = (node: unknown, path: Array<string | number>): unknown => {
    if (path.length > MAX_DOCUMENT_DEPTH) {
      throw invalid(`${what} nests deeper than ${MAX_DOCUMENT_DEPTH} levels.`)
    }

    const at = path.length ? ` at ${path.join(".")}` : ""

    if (typeof node === "string") {
      const plain = prose(path) ? withoutPresentation(node) : node
      const hidden = hiddenCharacter(plain)

      if (hidden) {
        throw invalid(
          `${what} has a character that does not show on screen${at} (${hidden}). Take it out: the owner reads it as it is.`,
        )
      }

      return plain
    }

    if (typeof node === "number" && !Number.isFinite(node)) {
      throw invalid(`${what} has a number PCP does not keep${at}.`)
    }

    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, [...path, index]))
    }

    if (node !== null && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([key, item]) => {
          const hidden = hiddenCharacter(key)

          if (hidden) {
            throw invalid(
              `${what} has a key with a character that does not show on screen${at} (${hidden}).`,
            )
          }

          return [key, walk(item, [...path, key])]
        }),
      )
    }

    return node
  }

  return walk(value, [])
}

/** pcp_format, read before anything else: a newer one is refused as such. */
function checkFormat(value: unknown, what: string, required: boolean): number {
  if (value === undefined || value === null) {
    if (required) {
      throw invalid(
        `${what} has no pcp_format: PCP's documents start with "pcp_format: ${PCP_FORMAT}".`,
      )
    }

    return 1
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalid(`${what}'s pcp_format is a whole number, like 1.`)
  }

  if (value > PCP_FORMAT) {
    throw new PcpError(
      "validation",
      `${what} is in format ${value}, written by a newer PCP; this one reads format ${PCP_FORMAT} and older. Update PCP to read it.`,
    )
  }

  return value
}

function formatOf(document: unknown, what: string): number {
  const value =
    document !== null &&
    typeof document === "object" &&
    !Array.isArray(document)
      ? (document as Record<string, unknown>).pcp_format
      : undefined

  return checkFormat(value, what, true)
}

function zodProblem(error: z.ZodError, what: string): PcpError {
  const issue = error.issues[0]!
  const at = issue.path.length ? ` at ${issue.path.join(".")}` : ""
  return invalid(`${what}${at}: ${issue.message}`)
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value)

  if (!result.success) {
    throw zodProblem(result.error, what)
  }

  return result.data
}

const version = z.number().int().min(1).default(1)
const text = z.string()
const plainObject = z.record(z.string(), z.unknown())

const headerSchema = z.strictObject({
  header: text,
  template: text.default(SECRET_PLACEHOLDER),
  secret: text.nullable().default(null),
})

const noneAuth = z.strictObject({ kind: z.literal("none") })
const headerAuth = z.strictObject({
  kind: z.literal("header"),
  header: text,
  template: text.default(SECRET_PLACEHOLDER),
  secret: text.nullable().default(null),
  headers: z.array(headerSchema).default([]),
})
const basicAuth = z.strictObject({
  kind: z.literal("basic"),
  username: text.nullable().default(null),
  secret: text.nullable().default(null),
})
const oauthAuth = z.strictObject({
  kind: z.literal("oauth"),
  clientId: text.nullable().default(null),
  clientSecret: text.nullable().default(null),
  scope: text.nullable().default(null),
  authorizeParams: text.nullable().default(null),
})

const wrapperSchema = z.strictObject({
  pcp_format: z.number(),
  version,
  name: text,
  description: text.default(""),
  // A document that does not say follows the calling token's levels: the
  // narrower of the two.
  callLevels: z.enum(["approved", "token"]).default("token"),
  tools: z
    .array(
      z.strictObject({
        name: text,
        title: text.nullable().default(null),
        description: text,
        inputSchema: plainObject,
        outputSchema: plainObject.optional(),
        annotations: z
          .strictObject({
            readOnlyHint: z.boolean().optional(),
            destructiveHint: z.boolean().optional(),
            idempotentHint: z.boolean().optional(),
            openWorldHint: z.boolean().optional(),
          })
          .nullable()
          .default(null),
        calls: z.array(text),
        replaces: z.array(text).default([]),
      }),
    )
    .min(1)
    .max(MAX_WRAPPER_TOOLS),
  secrets: z
    .array(
      z.strictObject({
        secret: text,
        tool: text,
        argument: text,
        template: text.default(SECRET_PLACEHOLDER),
      }),
    )
    .default([]),
})

const endpointSchema = z.strictObject({
  pcp_format: z.number(),
  version,
  name: text,
  description: text.default(""),
  // Format 1 only: the instance it was written from.
  baseUrl: text.optional(),
  readOnly: z.boolean().optional(),
  publicOnly: z.boolean().optional(),
  auth: z.discriminatedUnion("kind", [
    noneAuth,
    headerAuth,
    basicAuth,
    oauthAuth,
  ]),
  patches: z.array(z.unknown()).default([]),
  toolDescriptions: z.record(z.string(), text).default({}),
})

const serverSchema = z.strictObject({
  pcp_format: z.number(),
  version,
  name: text,
  description: text.default(""),
  // Format 1 only: the instance it was written from.
  url: text.optional(),
  publicOnly: z.boolean().optional(),
  auth: z.discriminatedUnion("kind", [noneAuth, headerAuth, oauthAuth]),
})

/** The display name and description, as a server's are checked. */
function nameAndDescription(
  input: { name: string; description: string },
  what: string,
): { displayName: string; description: string } {
  try {
    const { name, description } = normalizeNameAndDescription(input)

    if (input.description.trim().length > description.length) {
      throw invalid("Keep the description under 1,000 characters.")
    }

    return { displayName: name, description }
  } catch (error) {
    throw withWhere(error, what)
  }
}

function withWhere(error: unknown, what: string): unknown {
  if (isPcpError(error) && !error.message.startsWith(what)) {
    return new PcpError(error.code, `${what}: ${error.message}`)
  }

  return error
}

function checkSecretName(name: string, what: string): string {
  const problem = validateSecretName(name.trim())

  if (problem) {
    throw invalid(`${what}: a secret's name: ${problem}`)
  }

  return name.trim()
}

function checkHeader(header: HeaderDocument, what: string): HeaderDocument {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(header.header)) {
    throw invalid(`${what}: header names use letters, digits and dashes only.`)
  }

  if (
    !header.template.includes(SECRET_PLACEHOLDER) ||
    /[\r\n]/.test(header.template) ||
    header.template.length > MAX_SECRET_TEMPLATE_CHARS
  ) {
    throw invalid(
      `${what}: the ${header.header} header's value has ${SECRET_PLACEHOLDER} where the secret goes, on one line, like "Bearer ${SECRET_PLACEHOLDER}".`,
    )
  }

  return {
    header: header.header,
    template: header.template,
    secret:
      header.secret === null ? null : checkSecretName(header.secret, what),
  }
}

function checkAuth(
  auth: z.output<typeof endpointSchema>["auth"],
  what: string,
): EndpointAuthDocument {
  switch (auth.kind) {
    case "none":
      return { kind: "none" }
    case "header": {
      const first = checkHeader(auth, what)
      const headers = auth.headers.map((header) => checkHeader(header, what))
      const names = new Set<string>()

      for (const header of [first, ...headers]) {
        if (names.has(header.header.toLowerCase())) {
          throw invalid(`${what}: the ${header.header} header is named twice.`)
        }
        names.add(header.header.toLowerCase())
      }

      return { kind: "header", ...first, headers }
    }
    case "basic": {
      let username: string | null = null

      try {
        if (auth.username !== null) {
          username = validateUsername(auth.username)
        }
      } catch (error) {
        throw withWhere(error, what)
      }

      return {
        kind: "basic",
        username,
        secret:
          auth.secret === null ? null : checkSecretName(auth.secret, what),
      }
    }
    case "oauth": {
      const clientId = auth.clientId?.trim() || null

      if (clientId && clientId.length > 500) {
        throw invalid(`${what}: that client ID is too long.`)
      }

      const scope = auth.scope?.trim() || null

      if (scope && (scope.length > 4000 || /[\r\n]/.test(scope))) {
        throw invalid(`${what}: the scope is too long, or spans lines.`)
      }

      if (auth.clientSecret !== null && !clientId) {
        throw invalid(`${what}: a client secret needs a client ID with it.`)
      }

      let authorizeParams: string | null

      try {
        authorizeParams = normalizeAuthorizeParams(auth.authorizeParams)
      } catch (error) {
        throw withWhere(error, what)
      }

      return {
        kind: "oauth",
        clientId,
        clientSecret:
          auth.clientSecret === null
            ? null
            : checkSecretName(auth.clientSecret, what),
        scope,
        authorizeParams,
      }
    }
  }
}

/**
 * What a sign-in names that is an instance's own: its secrets, a basic
 * login's user name, an OAuth client. A format-2 document names none.
 */
function instanceNames(auth: EndpointAuthDocument): string[] {
  switch (auth.kind) {
    case "none":
      return []
    case "header":
      return [auth, ...auth.headers].flatMap((header) =>
        header.secret !== null ? [`the secret of ${header.header}`] : [],
      )
    case "basic":
      return [
        ...(auth.username !== null ? ["a user name"] : []),
        ...(auth.secret !== null ? ["a secret"] : []),
      ]
    case "oauth":
      return [
        ...(auth.clientId !== null ? ["an OAuth client ID"] : []),
        ...(auth.clientSecret !== null ? ["an OAuth client secret"] : []),
      ]
  }
}

/**
 * A format-2 document carries the definition alone: an address, a switch or
 * a name of the instance in it is refused, as a newer PCP would never write
 * one. A format-1 document must say where its server is, as it always did.
 */
function checkInstanceFields(
  format: number,
  parsed: {
    baseUrl?: string
    url?: string
    readOnly?: boolean
    publicOnly?: boolean
  },
  auth: EndpointAuthDocument,
  what: string,
  address: "baseUrl" | "url",
): void {
  if (format >= 2) {
    const named = [
      ...(["baseUrl", "url", "readOnly", "publicOnly"] as const).filter(
        (key) => parsed[key] !== undefined,
      ),
      ...instanceNames(auth),
    ]

    if (named.length > 0) {
      throw invalid(
        `${what} is in format ${format}, which leaves out what each server has of its own (${named.join(", ")}): take it out, or write it as format 1.`,
      )
    }

    return
  }

  if (parsed[address] === undefined) {
    throw invalid(`${what}: a format-1 document says its ${address}.`)
  }
}

/** The header names a credential goes in, which no argument may set. */
export function authHeaders(auth: EndpointAuthDocument): string[] {
  switch (auth.kind) {
    case "none":
      return []
    case "header":
      return [auth.header, ...auth.headers.map((header) => header.header)]
    case "basic":
    case "oauth":
      return ["Authorization"]
  }
}

function onlyFiles(item: ItemFiles, expected: string[], what: string): void {
  for (const name of expected) {
    if (item.files[name] === undefined) {
      throw invalid(`${what} has no ${name}.`)
    }
  }

  const extra = Object.keys(item.files).filter(
    (name) => !expected.includes(name),
  )

  if (extra.length > 0) {
    throw invalid(
      `${what} has ${extra.map((name) => itemPath(item.ref, name)).join(", ")}, which is none of its files.`,
    )
  }
}

async function parseSkill(item: ItemFiles): Promise<SkillDocument> {
  const what = itemPath(item.ref, SKILL_MD)
  const md = item.files[SKILL_MD]

  if (md === undefined) {
    throw invalid(`${itemRoot(item.ref)} has no ${SKILL_MD}.`)
  }

  let parsed: ReturnType<typeof parseSkillMd>

  try {
    parsed = parseSkillMd(md)
  } catch (error) {
    throw withWhere(error, what)
  }

  checkFormat(parsed.format, what, false)
  const name = parsed.name.trim() || item.ref.name

  if (name !== item.ref.name) {
    throw invalid(
      `${what} names the skill ${name.slice(0, 64)}, but its folder is ${item.ref.name}: make them the same.`,
    )
  }

  const files = Object.entries(item.files)
    .filter(([path]) => path !== SKILL_MD)
    .map(([path, text]) => ({ path, text }))
    .sort((a, b) => a.path.localeCompare(b.path))

  let skill: ReturnType<typeof checkArrivedSkill>

  try {
    skill = checkArrivedSkill({
      name,
      description: parsed.description,
      body: parsed.body,
      tools: parsed.tools,
      files,
      extra: parsed.extra,
    })
  } catch (error) {
    throw withWhere(error, itemRoot(item.ref))
  }

  return {
    kind: "skill",
    name: skill.name,
    version: parsed.version ?? 1,
    description: skill.description,
    body: skill.body,
    tools: skill.tools,
    extra: skill.extra,
    files: skill.files,
  }
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

/** A program file's text without the header PCP wrote above it. */
function programOf(fileText: string, tool: string): string {
  let program = fileText.replace(/\r\n?/g, "\n")
  const newline = program.indexOf("\n")
  const first = newline < 0 ? program : program.slice(0, newline)

  // The header PCP writes, for this tool, whatever the wrapper's name was
  // when it was written: a renamed folder does not change its programs.
  if (first.startsWith(headerStart(tool)) && first.endsWith(HEADER_END)) {
    program = newline < 0 ? "" : program.slice(newline + 1)
  }

  return program.endsWith("\n") ? program.slice(0, -1) : program
}

async function parseWrapper(item: ItemFiles): Promise<WrapperDocument> {
  const kind = item.ref.kind as "wrapper" | "flow"
  const what = itemPath(item.ref, WRAPPER_YAML)
  const source = item.files[WRAPPER_YAML]

  if (source === undefined) {
    throw invalid(`${itemRoot(item.ref)} has no ${WRAPPER_YAML}.`)
  }

  const raw = readDocument(
    source,
    what,
    (path) =>
      (path.length === 1 &&
        (path[0] === "name" || path[0] === "description")) ||
      (path.length === 3 &&
        path[0] === "tools" &&
        (path[2] === "title" || path[2] === "description")),
  )
  formatOf(raw, what)
  const parsed = parseWith(wrapperSchema, raw, what)
  const { displayName, description } = nameAndDescription(parsed, what)
  const names = new Set<string>()
  const files = [WRAPPER_YAML]
  const tools: WrapperToolDocument[] = []

  for (const tool of parsed.tools) {
    if (!TOOL_NAME.test(tool.name)) {
      throw invalid(
        `${what}: a tool's name is 1 to 64 letters, digits, dots, dashes or underscores, not "${tool.name.slice(0, 64)}".`,
      )
    }

    const file = programFile(tool.name)

    if (names.has(file.toLowerCase())) {
      throw invalid(`${what}: two tools are called ${tool.name}.`)
    }

    names.add(file.toLowerCase())
    files.push(file)
    const fileText = item.files[file]

    if (fileText === undefined) {
      throw invalid(
        `${what} has the tool ${tool.name}, whose program is not in ${itemPath(item.ref, file)}.`,
      )
    }

    const program = programOf(fileText, tool.name)
    const where = itemPath(item.ref, file)

    if (!program.trim()) {
      throw invalid(`${where} has no program.`)
    }

    if (program.length > MAX_PROGRAM_CHARS) {
      throw invalid(
        `${where} is ${program.length.toLocaleString("en")} characters; a wrapper's tool has ${MAX_PROGRAM_CHARS.toLocaleString("en")} at most, for the owner to read.`,
      )
    }

    const hidden = hiddenCharacter(program)

    if (hidden) {
      throw invalid(
        `${where} has a character that does not show on screen (${hidden}); write it in a string as an escape (\\u200D) instead.`,
      )
    }

    const problem = await checkSyntax(program)

    if (problem) {
      throw invalid(`${where} does not compile: ${problem}`)
    }

    for (const ref of [...tool.calls, ...tool.replaces]) {
      if (!splitRef(ref)) {
        throw invalid(
          `${what}: name other tools as server/tool, like "github/list_issues", not "${ref.slice(0, 100)}".`,
        )
      }
    }

    if (tool.calls.length === 0) {
      throw invalid(`${what}: the tool ${tool.name} names the tools it calls.`)
    }

    const title = tool.title?.trim() || null
    const toolDescription = tool.description.trim()

    if (title && title.length > 200) {
      throw invalid(
        `${what}: the title of ${tool.name} is at most 200 characters.`,
      )
    }

    if (!toolDescription) {
      throw invalid(`${what}: the tool ${tool.name} needs a description.`)
    }

    if (toolDescription.length > MAX_WRAPPER_DESCRIPTION_CHARS) {
      throw invalid(
        `${what}: the description of ${tool.name} is longer than ${MAX_WRAPPER_DESCRIPTION_CHARS.toLocaleString("en")} characters.`,
      )
    }

    tools.push({
      name: tool.name,
      title,
      description: toolDescription,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      annotations:
        tool.annotations && Object.keys(tool.annotations).length > 0
          ? tool.annotations
          : null,
      calls: [...new Set(tool.calls)],
      replaces: [...new Set(tool.replaces)],
      program,
    })
  }

  onlyFiles(item, files, itemRoot(item.ref))

  const secrets = parsed.secrets.map((binding) => {
    if (!splitRef(binding.tool)) {
      throw invalid(
        `${what}: the secret "${binding.secret}" goes to a tool named as server/tool.`,
      )
    }

    if (
      !binding.argument.startsWith("/") ||
      binding.argument === "/" ||
      binding.argument.length > MAX_ARGUMENT_POINTER_CHARS
    ) {
      throw invalid(
        `${what}: the secret "${binding.secret}" goes into one argument, named by a JSON Pointer like "/api_key".`,
      )
    }

    if (
      !binding.template.includes(SECRET_PLACEHOLDER) ||
      binding.template.length > MAX_SECRET_TEMPLATE_CHARS
    ) {
      throw invalid(
        `${what}: how the secret "${binding.secret}" is written has ${SECRET_PLACEHOLDER} where the value goes.`,
      )
    }

    return {
      secret: checkSecretName(binding.secret, what),
      tool: binding.tool,
      argument: binding.argument,
      template: binding.template,
    }
  })

  return {
    kind,
    name: item.ref.name,
    version: parsed.version,
    displayName,
    description,
    callLevels: parsed.callLevels,
    tools,
    secrets,
  }
}

async function parseEndpoint(item: ItemFiles): Promise<EndpointDocument> {
  const what = itemPath(item.ref, ENDPOINT_YAML)
  const source = item.files[ENDPOINT_YAML]

  if (source === undefined) {
    throw invalid(`${itemRoot(item.ref)} has no ${ENDPOINT_YAML}.`)
  }

  const hasJson = item.files[SPEC_JSON] !== undefined
  const hasYaml = item.files[SPEC_YAML] !== undefined

  if (hasJson === hasYaml) {
    throw invalid(
      `${itemRoot(item.ref)} has its OpenAPI document in one file, ${SPEC_JSON} or ${SPEC_YAML}.`,
    )
  }

  const specFile = hasJson ? SPEC_JSON : SPEC_YAML
  const specText = item.files[specFile]!
  onlyFiles(item, [specFile, ENDPOINT_YAML], itemRoot(item.ref))

  if (specFormat(specText) !== (hasJson ? "json" : "yaml")) {
    throw invalid(
      `${itemPath(item.ref, specFile)} holds ${hasJson ? "YAML" : "JSON"}: name it ${hasJson ? SPEC_YAML : SPEC_JSON}.`,
    )
  }

  const raw = readDocument(
    source,
    what,
    (path) =>
      (path.length === 1 &&
        (path[0] === "name" || path[0] === "description")) ||
      (path.length === 2 && path[0] === "toolDescriptions"),
  )
  const format = formatOf(raw, what)
  const parsed = parseWith(endpointSchema, raw, what)
  const { displayName, description } = nameAndDescription(parsed, what)
  const auth = checkAuth(parsed.auth, what)
  checkInstanceFields(format, parsed, auth, what, "baseUrl")
  let instance: InstanceHint | null = null
  let patches: PatchOperation[]

  try {
    if (parsed.baseUrl !== undefined) {
      instance = {
        url: validateBaseUrl(parsed.baseUrl),
        readOnly: parsed.readOnly ?? false,
        publicOnly: parsed.publicOnly ?? false,
      }
    }
    patches = readPatches(parsed.patches)
  } catch (error) {
    throw withWhere(error, what)
  }

  // The schema, read and its tools made as creating the endpoint would:
  // what cannot be used is refused before anyone is asked about it.
  let generated: ReturnType<typeof generateEndpointTools>

  try {
    // Every operation, read-only or not: which an instance offers is its own.
    generated = generateEndpointTools(specText, {
      readOnly: false,
      authHeaderNames: authHeaders(auth),
      patches,
    })
  } catch (error) {
    throw withWhere(error, itemPath(item.ref, specFile))
  }

  if (auth.kind === "oauth" && !generated.oauth.flow) {
    throw invalid(
      `${what}: ${generated.oauth.problem ?? "the schema declares no OAuth sign-in (an oauth2 security scheme with an authorizationCode flow)."}`,
    )
  }

  const toolNames = new Set(generated.tools.map((tool) => tool.name))
  const toolDescriptions: Record<string, string> = {}

  for (const [tool, wording] of Object.entries(parsed.toolDescriptions)) {
    if (!toolNames.has(tool)) {
      throw invalid(
        `${what}: toolDescriptions names ${tool.slice(0, 100)}, which is not one of the endpoint's tools.`,
      )
    }

    const trimmed = wording.trim()

    if (!trimmed || trimmed.length > MAX_TOOL_DESCRIPTION) {
      throw invalid(
        `${what}: the description of ${tool} is 1 to ${MAX_TOOL_DESCRIPTION} characters.`,
      )
    }

    toolDescriptions[tool] = trimmed
  }

  return {
    kind: "endpoint",
    name: item.ref.name,
    version: parsed.version,
    displayName,
    description,
    instance,
    spec: { format: hasJson ? "json" : "yaml", text: specText },
    patches,
    toolDescriptions,
    auth,
  }
}

function parseServer(item: ItemFiles): ServerDocument {
  const what = itemRoot(item.ref)
  const [file, ...others] = Object.keys(item.files)

  if (!file || others.length > 0) {
    throw invalid(`${what} is one file.`)
  }

  const raw = readDocument(
    item.files[file]!,
    what,
    (path) =>
      path.length === 1 && (path[0] === "name" || path[0] === "description"),
  )
  const format = formatOf(raw, what)
  const parsed = parseWith(serverSchema, raw, what)
  const { displayName, description } = nameAndDescription(parsed, what)
  const auth = checkAuth(parsed.auth, what) as ServerAuthDocument
  checkInstanceFields(format, parsed, auth, what, "url")
  let instance: InstanceHint | null = null

  try {
    if (parsed.url !== undefined) {
      instance = {
        url: validateServerUrl(parsed.url),
        publicOnly: parsed.publicOnly ?? false,
      }
    }
  } catch (error) {
    throw withWhere(error, what)
  }

  return {
    kind: "server",
    name: item.ref.name,
    version: parsed.version,
    displayName,
    description,
    instance,
    auth,
  }
}

/**
 * One item's files read into what they propose, checked as far as can be
 * without the vault (apply.ts resolveItem does the rest: which servers,
 * tools and secrets the names are). Throws what is wrong, naming the file.
 */
export async function parseItem(item: ItemFiles): Promise<ItemDocument> {
  checkItemSize(item)

  switch (item.ref.kind) {
    case "skill":
      return parseSkill(item)
    case "wrapper":
    case "flow":
      return parseWrapper(item)
    case "endpoint":
      return parseEndpoint(item)
    case "server":
      return parseServer(item)
  }
}

/**
 * A repository's files read into items: each one that parses, and what is
 * wrong with each that does not. Throws, reading nothing, when the
 * repository as a whole is refused (layout.ts groupRepoFiles).
 */
export async function readRepo(files: RepoFiles): Promise<{
  items: ItemDocument[]
  problems: RepoProblem[]
}> {
  const grouped = groupRepoFiles(files)
  const items: ItemDocument[] = []
  const problems = [...grouped.problems]

  for (const item of grouped.items) {
    try {
      items.push(await parseItem(item))
    } catch (error) {
      if (!isPcpError(error)) {
        throw error
      }

      problems.push({ path: itemRoot(item.ref), message: error.message })
    }
  }

  return { items, problems }
}
