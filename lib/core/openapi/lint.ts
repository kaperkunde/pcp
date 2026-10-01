import { parameterExample } from "./generate"
import { isBlockedHeader } from "./headers"
import { entries, isObject, own, ownString, type JsonObject } from "./json"
import { MAX_SCHEMA_PROBLEMS } from "./limits"
import type { PatchOperation } from "./patch"
import type { OpenApiDocument } from "./parse"
import { resolvePointer } from "./refs"

/**
 * Mistakes in a schema that confuse an assistant more than they stop PCP,
 * each with the edit that fixes it when there is one, so an assistant can
 * send it with update_endpoint (or spec_patches) instead of working out
 * the JSON Pointer itself. Found in the schema as edited.
 *
 * - An example that is not of the parameter's type. (One written as a query
 *   string, "?status=paid", is not a mistake to report: the generator reads
 *   it as the value after "=".)
 * - A required header whose example shows one value and whose schema
 *   allows any: if it only takes that value, PCP can send it itself. Not
 *   for a header that carries a credential, whose example is a placeholder
 *   for something only the owner has.
 * - Operations that do not describe their answer, so describe_tool cannot
 *   say what they return.
 */

export type SchemaProblem = {
  /** What is wrong, in words. */
  problem: string
  /** Where, as a JSON Pointer into the edited schema. */
  at: string
  /** Edits that fix it, when PCP can tell what the fix is. */
  fix?: PatchOperation[]
}

const METHODS = ["get", "put", "post", "delete", "patch"]

function escape(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1")
}

/** Every parameter the schema defines in one place, by pointer. */
function parameters(doc: OpenApiDocument): Array<[string, JsonObject]> {
  const found: Array<[string, JsonObject]> = []

  for (const [name, node] of entries(
    own(own(doc, "components"), "parameters"),
  )) {
    if (isObject(node) && !own(node, "$ref")) {
      found.push([`/components/parameters/${escape(name)}`, node])
    }
  }

  for (const [path, item] of entries(doc.paths)) {
    const base = `/paths/${escape(path)}`
    const lists: Array<[string, unknown]> = [
      [`${base}/parameters`, own(item, "parameters")],
      ...METHODS.map(
        (method) =>
          [
            `${base}/${method}/parameters`,
            own(own(item, method), "parameters"),
          ] as [string, unknown],
      ),
    ]

    for (const [at, list] of lists) {
      if (!Array.isArray(list)) {
        continue
      }

      list.forEach((node, index) => {
        if (isObject(node) && !own(node, "$ref")) {
          found.push([`${at}/${index}`, node])
        }
      })
    }
  }

  return found
}

/** A parameter's schema, its $ref followed once. */
function schemaOf(doc: OpenApiDocument, parameter: JsonObject): JsonObject {
  const schema = own(parameter, "schema")
  const ref = ownString(schema, "$ref")

  if (ref) {
    try {
      const resolved = resolvePointer(doc, ref)
      return isObject(resolved) ? resolved : {}
    } catch {
      return {}
    }
  }

  return isObject(schema) ? schema : {}
}

function fitsType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "integer":
      return (
        (typeof value === "number" && Number.isInteger(value)) ||
        (typeof value === "string" && /^-?\d+$/.test(value))
      )
    case "number":
      return (
        typeof value === "number" ||
        (typeof value === "string" &&
          value.trim() !== "" &&
          !isNaN(Number(value)))
      )
    case "boolean":
      return typeof value === "boolean" || value === "true" || value === "false"
    default:
      return true
  }
}

function exampleProblems(
  doc: OpenApiDocument,
  at: string,
  parameter: JsonObject,
): SchemaProblem[] {
  const name = ownString(parameter, "name") ?? ""
  // As an assistant is shown it, query-string prefix and all taken off.
  const example = parameterExample(own(parameter, "example"))
  const schema = schemaOf(doc, parameter)

  if (example === undefined || fitsType(example, own(schema, "type"))) {
    return []
  }

  return [
    {
      problem: `The example for ${name} (${JSON.stringify(example).slice(0, 80)}) is not a ${String(own(schema, "type"))}.`,
      at: `${at}/example`,
      fix: [{ op: "remove", path: `${at}/example` }],
    },
  ]
}

/** A header named for a credential: a password, key, token or secret. */
const CREDENTIAL_HEADER = /pass(word)?|secret|token|key|auth|session|cookie/i

function headerProblems(
  doc: OpenApiDocument,
  at: string,
  parameter: JsonObject,
  blockedHeaders: string[],
): SchemaProblem[] {
  const name = ownString(parameter, "name") ?? ""
  const schema = schemaOf(doc, parameter)
  const example = own(parameter, "example") ?? own(schema, "example")

  if (
    own(parameter, "in") !== "header" ||
    own(parameter, "required") !== true ||
    isBlockedHeader(name, blockedHeaders) ||
    CREDENTIAL_HEADER.test(name) ||
    own(schema, "enum") !== undefined ||
    own(schema, "const") !== undefined ||
    typeof example !== "string" ||
    !/^[\x20-\x7e]{1,200}$/.test(example)
  ) {
    return []
  }

  // The schema may be shared through a $ref: edit the parameter's own copy.
  const schemaAt = `${at}/schema`

  return [
    {
      problem: `${name} is a required header, and its example is always ${JSON.stringify(example)}. If that is the only value it takes, these edits let PCP send it instead of asking for it on every call.`,
      at,
      fix: [
        {
          op: own(parameter, "schema") === undefined ? "add" : "replace",
          path: schemaAt,
          value: { type: "string", enum: [example], default: example },
        },
      ],
    },
  ]
}

/** Operations whose success answer has no JSON schema. */
function undescribedAnswers(doc: OpenApiDocument): number {
  let count = 0

  for (const [, item] of entries(doc.paths)) {
    for (const method of METHODS) {
      const operation = own(item, method)

      if (!isObject(operation)) {
        continue
      }

      const described = entries(own(operation, "responses")).some(
        ([status, response]) => {
          if (!/^2(\d\d|XX)$/i.test(status)) {
            return false
          }

          let resolved: unknown = response
          const ref = ownString(response, "$ref")

          if (ref) {
            try {
              resolved = resolvePointer(doc, ref)
            } catch {
              return false
            }
          }

          return entries(own(resolved, "content")).some(
            ([type, media]) =>
              /json/i.test(type) && own(media, "schema") !== undefined,
          )
        },
      )

      if (!described && method === "get") {
        count += 1
      }
    }
  }

  return count
}

/**
 * The likely mistakes in a schema, at most MAX_SCHEMA_PROBLEMS of them, and
 * how many more there are.
 */
export function lintDocument(
  doc: OpenApiDocument,
  { blockedHeaders = [] }: { blockedHeaders?: string[] } = {},
): { problems: SchemaProblem[]; more: number } {
  const problems: SchemaProblem[] = []

  for (const [at, parameter] of parameters(doc)) {
    problems.push(
      ...exampleProblems(doc, at, parameter),
      ...headerProblems(doc, at, parameter, blockedHeaders),
    )
  }

  const undescribed = undescribedAnswers(doc)

  if (undescribed > 0) {
    problems.push({
      problem: `${undescribed} GET operation${undescribed === 1 ? " does" : "s do"} not describe ${undescribed === 1 ? "its" : "their"} answer as JSON, so describe_tool cannot say what ${undescribed === 1 ? "it returns" : "they return"}.`,
      at: "/paths",
    })
  }

  return {
    problems: problems.slice(0, MAX_SCHEMA_PROBLEMS),
    more: Math.max(0, problems.length - MAX_SCHEMA_PROBLEMS),
  }
}
