import { createHash } from "node:crypto"

import { z } from "zod"

import { checkSyntax } from "../code/quickjs"
import type { VaultContext } from "../context"
import { SECRET_PLACEHOLDER } from "../constants"
import { db } from "../db"
import { invalid } from "../errors"
import { hiddenCharacter, withoutPresentation } from "../memories"
import { parsePointer } from "../openapi/patch"
import { canonicalJson } from "../permission-rules"
import { findTextSecretByName, validateSecretName } from "../secrets"
import { normalizeNameAndDescription } from "../servers"
import type { CatalogueTool } from "../catalogue"

import {
  MAX_ARGUMENT_POINTER_CHARS,
  MAX_CALLS_PER_TOOL,
  MAX_PROGRAM_CHARS,
  MAX_SECRET_BINDINGS,
  MAX_SECRET_TEMPLATE_CHARS,
  MAX_WRAPPER_DESCRIPTION_CHARS,
  MAX_WRAPPER_SCHEMA_CHARS,
  MAX_WRAPPER_TOOLS,
} from "./limits"

/**
 * What a wrapper is: its tools, each a program over the vault's other tools
 * with the arguments it takes, the tools it calls and the ones it replaces
 * in search, and the places the owner allowed a secret to go. Stored as
 * JSON in wrapper_spec, by server id (a server added later under the same
 * short name never inherits a secret or a call); shown to people and
 * assistants by short name.
 */

/** A tool of another server, by the server's id. */
export type ToolRef = { serverId: string; tool: string }

export type WrapperAnnotations = {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export type WrapperTool = {
  name: string
  title: string | null
  description: string
  /** JSON Schema of the arguments, an object. */
  inputSchema: Record<string, unknown>
  annotations: WrapperAnnotations | null
  /** The body of an async function; its arguments are `args`. */
  program: string
  /** Every tool the program may call. */
  calls: ToolRef[]
  /** Tools it stands in for: they drop out of search_tools and list_tools. */
  replaces: ToolRef[]
}

/**
 * One place the owner allowed a secret: `secret` (the name the program
 * writes in {"$secret": …}) goes into the argument at `argument` (a JSON
 * Pointer) of one tool, written as `template`, while that tool's server is
 * at `url`. `secretId` is null only in a request whose secret the owner is
 * to type in.
 */
export type SecretBinding = {
  secret: string
  secretId: string | null
  serverId: string
  tool: string
  argument: string
  template: string
  url: string
}

export type WrapperDefinition = {
  version: 1
  tools: WrapperTool[]
  secrets: SecretBinding[]
}

/** A tool as an assistant or the owner sends it: other tools as server/tool. */
export type WrapperToolInput = {
  name: string
  title?: string | null
  description: string
  inputSchema: unknown
  annotations?: WrapperAnnotations | null
  program: string
  calls: string[]
  replaces?: string[]
}

export type SecretBindingInput = {
  secret: string
  tool: string
  argument: string
  template?: string | null
}

export type WrapperInput = {
  name: string
  description?: string
  tools: WrapperToolInput[]
  secrets?: SecretBindingInput[]
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const ANNOTATION_KEYS = new Set([
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
])

const refSchema = z.object({ serverId: z.string(), tool: z.string() })

const storedSchema = z.object({
  version: z.literal(1),
  tools: z.array(
    z.object({
      name: z.string(),
      title: z.string().nullable(),
      description: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
      annotations: z
        .object({
          readOnlyHint: z.boolean().optional(),
          destructiveHint: z.boolean().optional(),
          idempotentHint: z.boolean().optional(),
          openWorldHint: z.boolean().optional(),
        })
        .nullable(),
      program: z.string(),
      calls: z.array(refSchema),
      replaces: z.array(refSchema),
    }),
  ),
  secrets: z.array(
    z.object({
      secret: z.string(),
      secretId: z.string().nullable(),
      serverId: z.string(),
      tool: z.string(),
      argument: z.string(),
      template: z.string(),
      url: z.string(),
    }),
  ),
})

/** A stored definition, checked as it is read. */
export function readDefinition(json: string): WrapperDefinition {
  return storedSchema.parse(JSON.parse(json)) as WrapperDefinition
}

/** What a request was asked against, and what the owner approves. */
export function definitionHash(definition: WrapperDefinition): string {
  return createHash("sha256").update(canonicalJson(definition)).digest("hex")
}

/** What a wrapper's tools are in the catalogue. */
export function catalogueTools(definition: WrapperDefinition): CatalogueTool[] {
  return definition.tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? undefined,
    operation: JSON.stringify({ calls: tool.calls, replaces: tool.replaces }),
  }))
}

/** A wrapper tool's catalogue row's calls and replaced tools. */
export function readWrapperOperation(json: string | null): {
  calls: ToolRef[]
  replaces: ToolRef[]
} {
  try {
    const parsed = z
      .object({ calls: z.array(refSchema), replaces: z.array(refSchema) })
      .parse(JSON.parse(json ?? ""))
    return parsed
  } catch {
    // A row that does not say counts as calling something unknown: blocked.
    return { calls: [{ serverId: "", tool: "" }], replaces: [] }
  }
}

/** "server/tool", split at its first slash. */
export function splitRef(ref: string): { slug: string; tool: string } | null {
  const at = ref.indexOf("/")
  return at > 0 && at < ref.length - 1
    ? { slug: ref.slice(0, at), tool: ref.slice(at + 1) }
    : null
}

/** What may be named: the token's view for an assistant, all for the owner. */
export type Reach = (
  server: { id: string; slug: string },
  tool: string,
) => string | null

type KnownServer = {
  id: string
  slug: string
  name: string
  kind: string
  url: string
}

/**
 * Refuses a character that does not show on screen. Prose (names,
 * descriptions, titles) has lost its emoji presentation selectors before it
 * gets here; anything else that names or runs something (a program, a
 * pointer, a template, a schema) keeps them, and so is refused for them too.
 */
function visible(text: string, what: string, hint = "take it out"): void {
  const hidden = hiddenCharacter(text)

  if (hidden) {
    throw invalid(
      `${what} has a character that does not show on screen (${hidden}); the owner reads it as it is, so ${hint}.`,
    )
  }
}

/**
 * A wrapper as asked for, checked and resolved: every name it uses is a
 * tool PCP has (and, for an assistant, one of its own it is not blocked
 * from), every program compiles, and every secret goes to an argument of a
 * tool its wrapper calls. Throws what is wrong, for the asker to fix.
 * `newSecret` is a secret's name PCP does not hold yet, for the owner to
 * type in (an assistant's request has at most one).
 */
export async function resolveDefinition(
  ctx: VaultContext,
  input: WrapperInput,
  {
    reach,
    allowNewSecret,
    exceptServerId,
  }: {
    /** For an assistant: whether it may name this tool. */
    reach?: Reach
    /** An assistant may name one secret PCP does not hold; the owner none. */
    allowNewSecret: boolean
    /** The wrapper being changed, which may not call itself. */
    exceptServerId?: string
  },
): Promise<{
  name: string
  description: string
  definition: WrapperDefinition
  newSecret: string | null
}> {
  const { name, description } = normalizeNameAndDescription({
    name: withoutPresentation(String(input.name ?? "")),
    description: withoutPresentation(String(input.description ?? "")),
  })
  visible(name, "The name")
  visible(description, "The description")

  if (!Array.isArray(input.tools) || input.tools.length === 0) {
    throw invalid("A wrapper has at least one tool.")
  }

  if (input.tools.length > MAX_WRAPPER_TOOLS) {
    throw invalid(`A wrapper has at most ${MAX_WRAPPER_TOOLS} tools.`)
  }

  const secretsIn = input.secrets ?? []

  if (secretsIn.length > MAX_SECRET_BINDINGS) {
    throw invalid(
      `A wrapper puts a secret in at most ${MAX_SECRET_BINDINGS} places.`,
    )
  }

  // Every server/tool named anywhere, looked up at once.
  const refs = new Set<string>()
  for (const tool of input.tools) {
    for (const ref of [...(tool.calls ?? []), ...(tool.replaces ?? [])]) {
      refs.add(String(ref))
    }
  }
  for (const binding of secretsIn) {
    refs.add(String(binding.tool))
  }

  const slugs = new Set<string>()
  for (const ref of refs) {
    const split = splitRef(ref)

    if (!split) {
      throw invalid(
        `Name other tools as server/tool, like "github/list_issues", not "${ref.slice(0, 100)}".`,
      )
    }

    slugs.add(split.slug)
  }

  const servers: KnownServer[] = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId, slug: { in: [...slugs] } },
    select: { id: true, slug: true, name: true, kind: true, url: true },
  })
  const bySlug = new Map(servers.map((server) => [server.slug, server]))
  const tools = await db().mcpTool.findMany({
    where: { serverId: { in: servers.map((server) => server.id) } },
    select: { serverId: true, name: true, inputSchema: true },
  })
  const toolKey = (serverId: string, tool: string) => `${serverId}\n${tool}`
  const schemas = new Map(
    tools.map((tool) => [toolKey(tool.serverId, tool.name), tool.inputSchema]),
  )

  const resolve = (
    ref: string,
    what: string,
  ): ToolRef & { server: KnownServer } => {
    const split = splitRef(ref)!
    const server = bySlug.get(split.slug)

    if (!server) {
      throw invalid(`${what}: there is no server called ${split.slug}.`)
    }

    if (server.kind === "wrapper" || server.id === exceptServerId) {
      throw invalid(
        `${what}: ${ref} is a wrapper's tool, and a wrapper calls other servers' tools, never a wrapper's.`,
      )
    }

    if (!schemas.has(toolKey(server.id, split.tool))) {
      throw invalid(`${what}: ${split.slug} has no tool called ${split.tool}.`)
    }

    const refused = reach?.(server, split.tool)

    if (refused) {
      throw invalid(`${what}: ${refused}`)
    }

    return { serverId: server.id, tool: split.tool, server }
  }

  const names = new Set<string>()
  const resolvedTools: WrapperTool[] = []

  for (const tool of input.tools) {
    const toolName = String(tool.name ?? "")

    if (!TOOL_NAME.test(toolName)) {
      throw invalid(
        `A tool's name is 1 to 64 letters, digits, dots, dashes or underscores, not "${toolName.slice(0, 100)}".`,
      )
    }

    if (names.has(toolName)) {
      throw invalid(`Two tools are called ${toolName}.`)
    }
    names.add(toolName)

    const what = `The tool ${toolName}`
    const title =
      tool.title === undefined || tool.title === null
        ? null
        : withoutPresentation(String(tool.title)).trim().slice(0, 200) || null
    const toolDescription = withoutPresentation(
      String(tool.description ?? ""),
    ).trim()

    if (!toolDescription) {
      throw invalid(`${what} needs a description, for assistants to find it.`)
    }

    if (toolDescription.length > MAX_WRAPPER_DESCRIPTION_CHARS) {
      throw invalid(
        `${what}'s description is longer than ${MAX_WRAPPER_DESCRIPTION_CHARS.toLocaleString("en")} characters.`,
      )
    }

    visible(toolDescription, `${what}'s description`)

    if (title) {
      visible(title, `${what}'s title`)
    }

    const schema = tool.inputSchema

    if (
      schema === null ||
      typeof schema !== "object" ||
      Array.isArray(schema) ||
      (schema as { type?: unknown }).type !== "object"
    ) {
      throw invalid(
        `${what}'s inputSchema is a JSON Schema for an object: {"type": "object", "properties": {…}}.`,
      )
    }

    const schemaText = JSON.stringify(schema)

    if (schemaText.length > MAX_WRAPPER_SCHEMA_CHARS) {
      throw invalid(
        `${what}'s inputSchema is longer than ${MAX_WRAPPER_SCHEMA_CHARS.toLocaleString("en")} characters of JSON.`,
      )
    }

    visible(schemaText, `${what}'s inputSchema`)

    let annotations: WrapperAnnotations | null = null

    if (tool.annotations) {
      if (
        typeof tool.annotations !== "object" ||
        Array.isArray(tool.annotations)
      ) {
        throw invalid(`${what}'s annotations are an object of hints.`)
      }

      annotations = {}

      for (const [key, value] of Object.entries(tool.annotations)) {
        if (!ANNOTATION_KEYS.has(key) || typeof value !== "boolean") {
          throw invalid(
            `${what}'s annotations take readOnlyHint, destructiveHint, idempotentHint and openWorldHint, each true or false.`,
          )
        }

        annotations[key as keyof WrapperAnnotations] = value
      }
    }

    const program = String(tool.program ?? "").replace(/\r\n?/g, "\n")

    if (!program.trim()) {
      throw invalid(`${what} needs a program.`)
    }

    if (program.length > MAX_PROGRAM_CHARS) {
      throw invalid(
        `${what}'s program is ${program.length.toLocaleString("en")} characters; a wrapper's tool has ${MAX_PROGRAM_CHARS.toLocaleString("en")} at most, for the owner to read.`,
      )
    }

    visible(
      program,
      `${what}'s program`,
      "take it out, or write it in a string as an escape (\\u200D)",
    )

    const problem = await checkSyntax(program)

    if (problem) {
      throw invalid(`${what}'s program does not compile: ${problem}`)
    }

    const callRefs = [...new Set((tool.calls ?? []).map(String))]

    if (callRefs.length === 0) {
      throw invalid(
        `${what} names the tools its program calls, in calls: ["server/tool", …].`,
      )
    }

    if (callRefs.length > MAX_CALLS_PER_TOOL) {
      throw invalid(`${what} calls at most ${MAX_CALLS_PER_TOOL} tools.`)
    }

    const calls = callRefs.map((ref) => {
      const { serverId, tool: name } = resolve(ref, what)
      return { serverId, tool: name }
    })
    const replaces = [...new Set((tool.replaces ?? []).map(String))].map(
      (ref) => {
        const { serverId, tool: name } = resolve(ref, what)

        if (
          !calls.some(
            (call) => call.serverId === serverId && call.tool === name,
          )
        ) {
          throw invalid(
            `${what} replaces ${ref}, which it does not call: a tool stands in only for what it calls.`,
          )
        }

        return { serverId, tool: name }
      },
    )

    resolvedTools.push({
      name: toolName,
      title,
      description: toolDescription,
      inputSchema: schema as Record<string, unknown>,
      annotations,
      program,
      calls,
      replaces,
    })
  }

  let newSecret: string | null = null
  const places = new Set<string>()
  const secrets: SecretBinding[] = []

  for (const binding of secretsIn) {
    const secretName = String(binding.secret ?? "").trim()
    const nameProblem = validateSecretName(secretName)

    if (nameProblem) {
      throw invalid(`A secret's name: ${nameProblem}`)
    }

    const { serverId, tool, server } = resolve(
      String(binding.tool),
      `The secret "${secretName}"`,
    )

    if (server.kind === "browser") {
      throw invalid(
        `A secret cannot go to the browser: what is typed stays on the page.`,
      )
    }

    if (
      !resolvedTools.some((entry) =>
        entry.calls.some(
          (call) => call.serverId === serverId && call.tool === tool,
        ),
      )
    ) {
      throw invalid(
        `The secret "${secretName}" goes to ${binding.tool}, which none of the wrapper's tools calls.`,
      )
    }

    const argument = String(binding.argument ?? "")

    if (
      !argument.startsWith("/") ||
      argument === "/" ||
      argument.length > MAX_ARGUMENT_POINTER_CHARS
    ) {
      throw invalid(
        `The secret "${secretName}" goes into one argument, named by a JSON Pointer like "/api_key" or "/auth/token".`,
      )
    }

    visible(argument, `Where the secret "${secretName}" goes`)

    const tokens = parsePointer(argument)
    checkArgumentInSchema(schemas.get(toolKey(serverId, tool)), tokens, {
      secret: secretName,
      ref: String(binding.tool),
    })

    const place = `${serverId}\n${tool}\n${argument}`

    if (places.has(place)) {
      throw invalid(`Two secrets go to ${binding.tool} at ${argument}.`)
    }
    places.add(place)

    const template =
      binding.template === undefined || binding.template === null
        ? SECRET_PLACEHOLDER
        : String(binding.template)

    if (
      !template.includes(SECRET_PLACEHOLDER) ||
      template.length > MAX_SECRET_TEMPLATE_CHARS
    ) {
      throw invalid(
        `How the secret "${secretName}" is written has ${SECRET_PLACEHOLDER} where the value goes, like "Bearer ${SECRET_PLACEHOLDER}".`,
      )
    }

    visible(template, `How the secret "${secretName}" is written`)

    const existing = await findTextSecretByName(ctx, secretName)

    if (!existing) {
      if (!allowNewSecret) {
        throw invalid(`There is no secret called "${secretName}".`)
      }

      if (newSecret !== null && newSecret !== secretName) {
        throw invalid(
          `PCP does not hold the secrets "${newSecret}" and "${secretName}": the owner types in one new secret with a request. Ask them to add the other under Secrets first, or ask for it in a later change.`,
        )
      }

      newSecret = secretName
    }

    secrets.push({
      secret: secretName,
      secretId: existing?.id ?? null,
      serverId,
      tool,
      argument,
      template,
      url: server.url,
    })
  }

  return {
    name,
    description,
    definition: { version: 1, tools: resolvedTools, secrets },
    newSecret,
  }
}

/**
 * A secret's argument as the tool's own schema describes it, where it says:
 * the first step has to be one of its properties when it takes no others.
 */
function checkArgumentInSchema(
  schemaText: string | undefined,
  tokens: string[],
  { secret, ref }: { secret: string; ref: string },
): void {
  let schema: unknown

  try {
    schema = JSON.parse(schemaText ?? "")
  } catch {
    return
  }

  if (schema === null || typeof schema !== "object") {
    return
  }

  const { properties, additionalProperties } = schema as {
    properties?: Record<string, unknown>
    additionalProperties?: unknown
  }

  if (
    properties &&
    typeof properties === "object" &&
    additionalProperties === false &&
    !Object.hasOwn(properties, tokens[0]!)
  ) {
    throw invalid(
      `The secret "${secret}" goes to ${ref}'s argument "${tokens[0]}", which it does not take. Its arguments: ${Object.keys(properties).slice(0, 30).join(", ")}.`,
    )
  }
}
