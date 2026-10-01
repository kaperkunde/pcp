import { invalid } from "../errors"
import { isBlockedHeader } from "./headers"
import { entries, isObject, own, ownString, type JsonObject } from "./json"
import {
  MAX_HEADER_VALUE,
  MAX_NAME_LENGTH,
  MAX_OPERATIONS,
  MAX_PARAMETERS,
  MAX_PATH_LENGTH,
  MAX_SERVER_URL_LENGTH,
  MAX_TOOL_DESCRIPTION,
  MAX_TOOL_SCHEMA_CHARS,
  MAX_TOTAL_REF_NODES,
  MAX_TOTAL_TOOL_CHARS,
  REF_MAX_CHARS,
  REF_MAX_NODES,
} from "./limits"
import { readOAuth, type OAuthReading } from "./oauth"
import { outlineAnswer } from "./outline"
import type { OpenApiDocument } from "./parse"
import type { BodyPlan, CallPlan, ParamPlan } from "./plan"
import {
  derefShallow,
  inlineRefs,
  UnsupportedRef,
  type RefBudget,
} from "./refs"
import { toJsonSchema } from "./schema"
import { validateBaseUrl } from "./urls"

/**
 * An OpenAPI document as the tools an assistant sees: one per operation,
 * each with a JSON Schema for its arguments and the call plan PCP follows
 * to make the request.
 *
 * What PCP cannot send is handled one way throughout: an optional feature
 * is dropped, a required one skips the operation, with the reason listed
 * for the owner (a file upload, a cookie, a reference into another
 * document).
 */

const METHODS = ["get", "put", "post", "delete", "patch"] as const
type Method = (typeof METHODS)[number]

export type ToolAnnotations = {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export type GeneratedTool = {
  name: string
  title: string | null
  description: string
  inputSchema: JsonObject
  annotations: ToolAnnotations
  operation: CallPlan
  /** What a successful call answers, in outline (outline.ts), or null. */
  output: string | null
}

export type Generated = {
  /** servers[0].url with variables filled in; may be relative. */
  serverUrl: string | null
  /** Why serverUrl could not be worked out, when it could not. */
  serverUrlProblem: string | null
  /** info.title and info.description, for a description fallback. */
  title: string
  description: string
  /** What the schema says requests need, in words, or null. */
  security: string | null
  /** The OAuth sign-in it declares, for the operations offered (oauth.ts). */
  oauth: OAuthReading
  tools: GeneratedTool[]
  skipped: Array<{ operation: string; reason: string }>
}

class Skip extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

/**
 * The literal parts of a path template (outside {placeholders}) come from the
 * schema, which an assistant may have written. Dot segments, encoded dots,
 * slashes and semicolons, backslashes and the characters that end a path
 * would make the request mean something other than the path says, on a
 * server that reads them differently from PCP.
 */
function unsafePathReason(path: string): string | null {
  const literal = path.replace(/\{[^}]*\}/g, "x")

  if (/[\\?#;\u0000-\u001f\u007f]/.test(literal)) {
    return "its path has a character PCP will not send (a backslash, ?, #, ; or a control character)"
  }

  if (/%(2e|2f|5c|3b|00)/i.test(literal)) {
    return "its path has an encoded dot, slash, backslash or semicolon"
  }

  if (
    literal.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return "its path has a dot segment"
  }

  return null
}

/**
 * Text read from a schema is cut to what PCP would use before anything else
 * touches it: a schema is untrusted, and a 4 MB summary repeated across a
 * thousand operations is four gigabytes of copying.
 */
function shorten(value: string | undefined, max: number): string {
  return value === undefined ? "" : value.slice(0, max).trim()
}

/** A media type that is safe to send as a header and show to an assistant. */
const SAFE_MEDIA_TYPE = /^[\x21-\x7e][\x20-\x7e]{0,199}$/

function sanitizeName(raw: string): string {
  return raw
    .slice(0, MAX_NAME_LENGTH)
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 64)
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base

  for (let n = 2; used.has(name); n++) {
    const suffix = `_${n}`
    name = `${base.slice(0, 64 - suffix.length)}${suffix}`
  }

  used.add(name)
  return name
}

function toolName(method: Method, path: string, operationId?: string) {
  const fromId = operationId ? sanitizeName(operationId) : ""

  if (fromId) {
    return fromId
  }

  const fromPath = sanitizeName(
    `${method}_${path.replace(/\{([^}]*)\}/g, "by_$1")}`,
  )

  return fromPath === method ? `${method}_root` : fromPath
}

function isJsonMediaType(type: string): boolean {
  const mime = type.split(";")[0]!.trim().toLowerCase()
  return /^application\/([\w.+-]+\+)?json$/.test(mime) || mime === "*/*"
}

/** servers[0].url with every {variable} replaced by its default. */
function serverUrlOf(doc: OpenApiDocument): {
  url: string | null
  problem: string | null
} {
  const servers = own(doc, "servers")

  // No servers means "/" relative to wherever the document came from.
  if (!Array.isArray(servers) || servers.length === 0) {
    return { url: "/", problem: null }
  }

  const first = servers[0]
  const template = ownString(first, "url")

  if (!template) {
    return { url: null, problem: null }
  }

  if (template.length > MAX_SERVER_URL_LENGTH) {
    return {
      url: null,
      problem:
        "The schema's server address is too long. Enter the base URL yourself.",
    }
  }

  const variables = own(first, "variables")
  const missing: string[] = []
  const url = template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = own(own(variables, name), "default")

    if (
      (typeof value === "string" && value.length <= MAX_NAME_LENGTH) ||
      typeof value === "number"
    ) {
      return String(value)
    }

    missing.push(name)
    return ""
  })

  if (missing.length > 0) {
    return {
      url: null,
      problem: `The schema's server address has a variable without a default (${missing.join(", ")}). Enter the base URL yourself.`,
    }
  }

  return { url, problem: null }
}

function describeSecurity(doc: OpenApiDocument): string | null {
  const requirements = own(doc, "security")

  if (!Array.isArray(requirements) || requirements.length === 0) {
    return null
  }

  const schemes = own(own(doc, "components"), "securitySchemes")
  const names = Object.keys(isObject(requirements[0]) ? requirements[0] : {})

  if (names.length === 0) {
    return null
  }

  const described = names.map((name) => {
    const scheme = own(schemes, name)
    const type = ownString(scheme, "type")
    const where = ownString(scheme, "in")
    const header = ownString(scheme, "name")

    if (type === "apiKey" && where === "header" && header) {
      return `a key in the ${header} header`
    }

    if (type === "apiKey" && where === "query") {
      return "a key in the query string, which PCP does not send"
    }

    if (type === "http") {
      const kind = ownString(scheme, "scheme")?.toLowerCase()
      return kind === "basic" ? "basic authentication" : "a bearer token"
    }

    if (type === "oauth2" || type === "openIdConnect") {
      return "an OAuth token"
    }

    return name
  })

  return described.join(" and ")
}

export function generateTools(
  doc: OpenApiDocument,
  options: { readOnly: boolean; blockedHeaders: string[] },
): Generated {
  const tools: GeneratedTool[] = []
  const skipped: Generated["skipped"] = []
  const used = new Set<string>()
  /** The security requirements of the operations offered. */
  const requirements: unknown[] = []
  let operations = 0
  // Shared by every operation: see MAX_TOTAL_REF_NODES.
  let pool = MAX_TOTAL_REF_NODES
  // And what the tools come to once stored: see MAX_TOTAL_TOOL_CHARS.
  let stored = 0

  for (const [path, rawItem] of entries(doc.paths)) {
    // Before any pattern is run on it: some of the ones below are quadratic
    // in the length of a path made of braces.
    if (path.length > MAX_PATH_LENGTH) {
      skipped.push({
        operation: `${path.slice(0, 60)}…`,
        reason: "its path is longer than PCP reads",
      })
      continue
    }

    let item: unknown

    try {
      item = derefShallow(doc, rawItem)
    } catch (error) {
      if (error instanceof UnsupportedRef) {
        skipped.push({ operation: path, reason: error.describe() })
        continue
      }
      throw error
    }

    if (!isObject(item)) {
      continue
    }

    for (const method of METHODS) {
      const operation = own(item, method)

      if (!isObject(operation)) {
        continue
      }

      operations += 1

      if (operations > MAX_OPERATIONS) {
        throw invalid(
          `This schema has more than ${MAX_OPERATIONS} operations, more than PCP reads from one endpoint.`,
        )
      }

      if (options.readOnly && method !== "get") {
        continue
      }

      const label = `${method.toUpperCase()} ${path}`

      if (pool <= 0) {
        skipped.push({
          operation: label,
          reason: "the schema is larger than PCP reads in full",
        })
        continue
      }

      const budget: RefBudget = {
        nodes: Math.min(REF_MAX_NODES, pool),
        chars: REF_MAX_CHARS,
      }
      const granted = budget.nodes

      try {
        const tool = buildTool(
          doc,
          path,
          method,
          item,
          operation,
          options,
          budget,
        )
        const size =
          JSON.stringify(tool.inputSchema).length +
          JSON.stringify(tool.operation).length +
          tool.description.length +
          (tool.output?.length ?? 0)

        if (stored + size > MAX_TOTAL_TOOL_CHARS) {
          skipped.push({
            operation: label,
            reason: "the tools are larger than PCP stores for one endpoint",
          })
          continue
        }

        stored += size
        tools.push({ ...tool, name: uniqueName(tool.name, used) })
        requirements.push(own(operation, "security") ?? own(doc, "security"))
      } catch (error) {
        if (error instanceof Skip) {
          skipped.push({ operation: label, reason: error.reason })
        } else if (error instanceof UnsupportedRef) {
          skipped.push({ operation: label, reason: error.describe() })
        } else {
          throw error
        }
      } finally {
        // An exhausted budget is negative: the operation used all it had.
        pool -= granted - Math.max(0, budget.nodes)
      }
    }
  }

  const server = serverUrlOf(doc)
  const info = own(doc, "info")

  return {
    serverUrl: server.url,
    serverUrlProblem: server.problem,
    title: shorten(ownString(info, "title"), 200),
    description: shorten(ownString(info, "description"), 1000),
    security: describeSecurity(doc),
    oauth: readOAuth(doc, requirements),
    tools,
    skipped,
  }
}

type RawParameter = {
  name: string
  in: string
  required: boolean
  node: JsonObject
}

function parametersOf(doc: unknown, list: unknown): RawParameter[] {
  if (!Array.isArray(list)) {
    return []
  }

  if (list.length > MAX_PARAMETERS) {
    throw new Skip(`it has more than ${MAX_PARAMETERS} parameters`)
  }

  return list.flatMap((entry) => {
    const node = derefShallow(doc, entry)
    const name = ownString(node, "name")
    const location = ownString(node, "in")

    if (!isObject(node) || !name || !location) {
      return []
    }

    if (name.length > MAX_NAME_LENGTH) {
      throw new Skip("a parameter's name is too long")
    }

    return [
      {
        name,
        in: location,
        required: location === "path" || own(node, "required") === true,
        node,
      },
    ]
  })
}

function buildTool(
  doc: OpenApiDocument,
  path: string,
  method: Method,
  item: JsonObject,
  operation: JsonObject,
  options: { blockedHeaders: string[] },
  budget: RefBudget,
): GeneratedTool {
  if (!path.startsWith("/")) {
    throw new Skip("its path does not start with /")
  }

  const unsafe = unsafePathReason(path)
  if (unsafe) {
    throw new Skip(unsafe)
  }

  const servers = own(operation, "servers") ?? own(item, "servers")
  if (Array.isArray(servers) && servers.length > 0) {
    throw new Skip("it uses a server of its own")
  }

  // Path-level parameters, overridden by the operation's own.
  const merged = new Map<string, RawParameter>()
  for (const parameter of [
    ...parametersOf(doc, own(item, "parameters")),
    ...parametersOf(doc, own(operation, "parameters")),
  ]) {
    const key = `${parameter.in}:${parameter.in === "header" ? parameter.name.toLowerCase() : parameter.name}`
    merged.set(key, parameter)
  }

  const properties: JsonObject = {}
  const required: string[] = []
  const params: ParamPlan[] = []
  const placeholders = [...path.matchAll(/\{([^}]*)\}/g)].map(
    (match) => match[1]!,
  )

  // Path first, so path parameters keep their own names on a clash.
  const ordered = [...merged.values()].sort((a, b) => rank(a.in) - rank(b.in))

  for (const parameter of ordered) {
    const plan = planParameter(doc, parameter, placeholders, options, budget)

    if (!plan) {
      continue
    }

    // A value PCP sends itself is not the assistant's to give.
    if (plan.param.value !== undefined) {
      params.push({ ...plan.param, arg: parameter.name })
      continue
    }

    let arg = parameter.name
    if (Object.hasOwn(properties, arg) || arg === "__proto__") {
      arg = `${parameter.in}_${parameter.name}`
    }
    if (Object.hasOwn(properties, arg)) {
      throw new Skip(`two parameters are called ${parameter.name}`)
    }

    properties[arg] = plan.schema
    if (parameter.required) {
      required.push(arg)
    }
    params.push({ ...plan.param, arg })
  }

  for (const placeholder of placeholders) {
    if (
      !params.some((param) => param.in === "path" && param.name === placeholder)
    ) {
      throw new Skip(`its path has {${placeholder}} but no parameter for it`)
    }
  }

  const body = planBody(doc, method, operation, properties, budget)
  if (body) {
    properties[body.plan.arg] = body.schema
    if (body.plan.required) {
      required.push(body.plan.arg)
    }
  }

  const inputSchema: JsonObject = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }

  if (JSON.stringify(inputSchema).length > MAX_TOOL_SCHEMA_CHARS) {
    throw new Skip("its argument schema is larger than PCP passes on")
  }

  const summary = shorten(ownString(operation, "summary"), 500)
  const title = summary && summary.length <= 100 ? summary : null
  const annotations: ToolAnnotations = {
    ...(title ? { title } : {}),
    readOnlyHint: method === "get",
    ...(method === "delete" ? { destructiveHint: true } : {}),
    ...(method === "get" || method === "put" || method === "delete"
      ? { idempotentHint: true }
      : {}),
    openWorldHint: true,
  }

  const plan: CallPlan = {
    v: 1,
    method: method.toUpperCase() as CallPlan["method"],
    path,
    params,
    body: body?.plan ?? null,
    accept: acceptFor(doc, operation),
  }

  return {
    name: toolName(method, path, ownString(operation, "operationId")),
    title,
    description: describeOperation(doc, method, path, operation),
    inputSchema,
    annotations,
    operation: plan,
    output: outlineAnswer(doc, operation),
  }
}

function rank(location: string): number {
  return ["path", "query", "header", "cookie"].indexOf(location) + 1 || 9
}

function parameterSchema(
  doc: OpenApiDocument,
  parameter: RawParameter,
  budget: RefBudget,
): { schema: JsonObject; serialize?: "json" } | null {
  const schema = own(parameter.node, "schema")

  if (schema !== undefined) {
    const converted = toJsonSchema(inlineRefs(doc, schema, budget), doc.openapi)
    return { schema: isObject(converted) ? converted : {} }
  }

  const content = entries(own(parameter.node, "content"))

  if (content.length > 0) {
    const [type, media] = content[0]!

    if (!isJsonMediaType(type)) {
      return null
    }

    const converted = toJsonSchema(
      inlineRefs(doc, own(media, "schema") ?? {}, budget),
      doc.openapi,
    )
    return {
      schema: isObject(converted) ? converted : {},
      serialize: "json",
    }
  }

  return { schema: {} }
}

function planParameter(
  doc: OpenApiDocument,
  parameter: RawParameter,
  placeholders: string[],
  options: { blockedHeaders: string[] },
  budget: RefBudget,
): { param: Omit<ParamPlan, "arg">; schema: JsonObject } | null {
  const drop = (reason: string) => {
    if (parameter.required) {
      throw new Skip(reason)
    }
    return null
  }

  let style: ParamPlan["style"]
  const declared = ownString(parameter.node, "style")

  switch (parameter.in) {
    case "path":
      if (!placeholders.includes(parameter.name)) {
        return null
      }
      if (declared && declared !== "simple") {
        throw new Skip(`its path uses the ${declared} parameter style`)
      }
      style = "simple"
      break
    case "query":
      if (
        declared &&
        !["form", "spaceDelimited", "pipeDelimited", "deepObject"].includes(
          declared,
        )
      ) {
        return drop(
          `its ${parameter.name} parameter uses the ${declared} style`,
        )
      }
      style = (declared as ParamPlan["style"]) ?? "form"
      break
    case "header":
      // Accept, Content-Type and Authorization are ignored by the spec's
      // own rules; the rest are PCP's to set, or unsafe to let through.
      if (isBlockedHeader(parameter.name, options.blockedHeaders)) {
        return null
      }
      style = "simple"
      break
    case "cookie":
      return drop("it needs a cookie")
    default:
      return drop(`its ${parameter.name} parameter is in "${parameter.in}"`)
  }

  const schema = parameterSchema(doc, parameter, budget)

  if (!schema) {
    return drop(`its ${parameter.name} parameter is not plain text or JSON`)
  }

  const description = shorten(ownString(parameter.node, "description"), 1000)
  // Only a small plain example: one can be as large as the whole file.
  const rawExample = own(parameter.node, "example")
  const example =
    (typeof rawExample === "string" && rawExample.length <= 500) ||
    typeof rawExample === "number" ||
    typeof rawExample === "boolean"
      ? rawExample
      : undefined
  const property: JsonObject = {
    ...schema.schema,
    ...(description ? { description } : {}),
    ...(own(parameter.node, "deprecated") === true ? { deprecated: true } : {}),
    ...(example !== undefined && schema.schema.examples === undefined
      ? { examples: [example] }
      : {}),
  }

  const explode = own(parameter.node, "explode")
  const fixed =
    parameter.in === "path" || schema.serialize
      ? null
      : onlyValue(schema.schema, parameter.required)

  return {
    param: {
      name: parameter.name,
      in: parameter.in as ParamPlan["in"],
      required: parameter.required,
      style,
      explode: typeof explode === "boolean" ? explode : style === "form",
      ...(schema.serialize ? { serialize: schema.serialize } : {}),
      ...(fixed !== null ? { value: fixed } : {}),
    },
    schema: property,
  }
}

const SENDABLE_VALUE = new RegExp(`^[\\x20-\\x7e]{1,${MAX_HEADER_VALUE}}$`)

/**
 * The one value a header or query parameter can take, when PCP should send
 * it rather than ask for it: the schema allows a single value (const, or an
 * enum of one), and the parameter is required or defaults to that value. An
 * optional one without a default is left to the assistant, since leaving it
 * out may mean something.
 */
function onlyValue(schema: JsonObject, required: boolean): string | null {
  const constant = own(schema, "const")
  const choices = own(schema, "enum")
  const value =
    constant !== undefined
      ? constant
      : Array.isArray(choices) && choices.length === 1
        ? choices[0]
        : undefined

  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return null
  }

  if (!required && own(schema, "default") !== value) {
    return null
  }

  const text = String(value)
  return SENDABLE_VALUE.test(text) ? text : null
}

function planBody(
  doc: OpenApiDocument,
  method: Method,
  operation: JsonObject,
  properties: JsonObject,
  budget: RefBudget,
): { plan: BodyPlan; schema: JsonObject } | null {
  const raw = own(operation, "requestBody")

  if (raw === undefined) {
    return null
  }

  const body = derefShallow(doc, raw)
  const required = own(body, "required") === true
  const drop = (reason: string) => {
    if (required) {
      throw new Skip(reason)
    }
    return null
  }

  if (method === "get") {
    return drop("it sends a body with GET")
  }

  const content = entries(own(body, "content")).filter(([type]) =>
    SAFE_MEDIA_TYPE.test(type),
  )
  const pick =
    content.find(([type]) => isJsonMediaType(type) && type !== "*/*") ??
    content.find(([type]) =>
      type.toLowerCase().startsWith("application/x-www-form-urlencoded"),
    ) ??
    content.find(([type]) => type.toLowerCase().startsWith("text/")) ??
    content.find(([type]) => type === "*/*")

  if (!pick) {
    const types = content.map(([type]) => type.toLowerCase())
    return drop(
      types.some(
        (type) =>
          type.startsWith("multipart/") ||
          type.startsWith("application/octet-stream") ||
          type.startsWith("image/"),
      )
        ? "it needs a file upload"
        : `its body is ${types[0] ?? "of no declared type"}`,
    )
  }

  const [contentType, media] = pick
  const lower = contentType.toLowerCase()
  const encoding: BodyPlan["encoding"] = lower.startsWith(
    "application/x-www-form-urlencoded",
  )
    ? "form"
    : lower.startsWith("text/")
      ? "text"
      : "json"

  const declared = own(media, "schema")
  const converted =
    declared === undefined
      ? encoding === "text"
        ? { type: "string" }
        : {}
      : toJsonSchema(inlineRefs(doc, declared, budget), doc.openapi)

  const arg = Object.hasOwn(properties, "body")
    ? Object.hasOwn(properties, "requestBody")
      ? null
      : "requestBody"
    : "body"

  if (!arg) {
    throw new Skip("its parameters already use the names body and requestBody")
  }

  const description = shorten(ownString(body, "description"), 1000)

  return {
    plan: {
      arg,
      contentType: contentType === "*/*" ? "application/json" : contentType,
      encoding,
      required,
    },
    schema: {
      ...(isObject(converted) ? converted : {}),
      ...(description ? { description } : {}),
    },
  }
}

function successResponses(doc: OpenApiDocument, operation: JsonObject) {
  return entries(own(operation, "responses"))
    .filter(([status]) => /^2(\d\d|XX)$/i.test(status) || status === "default")
    .flatMap(([, response]) => {
      try {
        const resolved = derefShallow(doc, response)
        return isObject(resolved) ? [resolved] : []
      } catch {
        return []
      }
    })
}

function acceptFor(doc: OpenApiDocument, operation: JsonObject): string {
  const types = successResponses(doc, operation).flatMap((response) =>
    entries(own(response, "content"))
      .map(([type]) => type)
      .filter((type) => SAFE_MEDIA_TYPE.test(type)),
  )
  const json = types.find((type) => isJsonMediaType(type) && type !== "*/*")

  if (json) {
    return `${json}, */*;q=0.8`
  }

  const safe = types.filter((type) => /^[\w.+-]+\/[\w.+*-]+$/.test(type))
  return safe.length > 0
    ? `${safe.slice(0, 3).join(", ")}, */*;q=0.8`
    : "application/json, */*;q=0.8"
}

/** Letters and digits only, lower case: what two phrasings share. */
function sameWords(a: string, b: string): boolean {
  const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "")
  return plain(a) !== "" && plain(a) === plain(b)
}

/**
 * The description without lines that only say the method and path again
 * ("## GET /pets"), which the description ends with anyway.
 */
function withoutRestatedLine(
  description: string,
  method: Method,
  path: string,
): string {
  const plain = (text: string) =>
    text.toLowerCase().replace(/[^a-z0-9{}/_-]+/g, "")
  const restated = plain(`${method}${path}`)

  return description
    .split("\n")
    .filter((line) => plain(line) !== restated)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function describeOperation(
  doc: OpenApiDocument,
  method: Method,
  path: string,
  operation: JsonObject,
): string {
  const summary = shorten(ownString(operation, "summary"), 500)
  const description = shorten(
    ownString(operation, "description"),
    MAX_TOOL_DESCRIPTION,
  )
  const tags = Array.isArray(own(operation, "tags"))
    ? (own(operation, "tags") as unknown[])
        .slice(0, 10)
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => shorten(tag, 50))
    : []
  const returns = successResponses(doc, operation)
    .map((response) => shorten(ownString(response, "description"), 300))
    .find((text) => text.length > 0 && text.length <= 200)

  const tail = [
    `${method.toUpperCase()} ${path}`,
    tags.length > 0 ? `Tags: ${tags.join(", ")}` : "",
    returns ? `Returns: ${returns}` : "",
  ]
    .filter(Boolean)
    .join("\n")

  const body = withoutRestatedLine(description, method, path)
  let head = [
    sameWords(body.slice(0, summary.length), summary) ? "" : summary,
    body,
  ]
    .filter(Boolean)
    .join("\n\n")

  if (own(operation, "deprecated") === true) {
    head = `(Deprecated) ${head}`
  }

  const room = MAX_TOOL_DESCRIPTION - tail.length - 2
  if (head.length > room) {
    head = `${head.slice(0, Math.max(0, room - 1)).trimEnd()}…`
  }

  return head ? `${head}\n\n${tail}` : tail
}

/**
 * Where requests go. The owner's own base URL wins; otherwise the schema's
 * server, resolved against where the schema was downloaded. When a secret
 * is attached, a downloaded schema may not send it to another origin than
 * its own without the owner typing that address themselves: the schema is
 * someone else's document, the secret is the owner's.
 */
export function resolveBaseUrl(input: {
  ownerBaseUrl: string | null
  serverUrl: string | null
  serverUrlProblem: string | null
  /** The address the owner gave for the schema, if any. */
  specUrl: string | null
  /** Where the schema was finally read from, after redirects. */
  fetchedFrom: string | null
  hasSecret: boolean
}): string {
  if (input.ownerBaseUrl) {
    return validateBaseUrl(input.ownerBaseUrl)
  }

  if (input.serverUrlProblem) {
    throw invalid(input.serverUrlProblem)
  }

  if (!input.serverUrl) {
    throw invalid(
      "The schema does not say where the API lives. Enter the base URL.",
    )
  }

  const against = input.fetchedFrom ?? input.specUrl
  let absolute: URL

  try {
    absolute = against
      ? new URL(input.serverUrl, against)
      : new URL(input.serverUrl)
  } catch {
    throw invalid(
      against
        ? "The schema's server address is not a valid URL. Enter the base URL yourself."
        : `The schema gives only a relative server address (${input.serverUrl.slice(0, 100)}). Enter the base URL: where the API lives.`,
    )
  }

  if (input.hasSecret) {
    // A file has no origin to compare with: the schema's author chose the
    // address, and the owner's secret would follow it. Only an address the
    // owner typed is one they chose.
    if (!input.specUrl) {
      throw invalid(
        `The schema file names ${absolute.host} as its server. To send your secret there, enter the base URL yourself to confirm it.`,
      )
    }

    if (absolute.origin !== new URL(input.specUrl).origin) {
      throw invalid(
        `The schema points at ${absolute.host}, not where it was downloaded from. Enter the base URL yourself to confirm where your secret goes.`,
      )
    }
  }

  return validateBaseUrl(absolute.toString())
}
