import { entries, isObject, own, type JsonObject } from "./json"

/**
 * An OpenAPI schema object (already inlined) as the JSON Schema an
 * assistant reads in describe_tool. 3.1 schemas are JSON Schema already;
 * 3.0 ones differ in a few keywords (nullable, boolean exclusive bounds,
 * example). Keywords that only matter to code generators are dropped, and
 * properties marked readOnly are left out: they are what the API sends
 * back, not what a request carries.
 */

const KEEP = new Set([
  "type",
  "format",
  "title",
  "description",
  "default",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "required",
  "examples",
  "deprecated",
  "contentMediaType",
  "contentEncoding",
])

const SUBSCHEMA_LISTS = ["allOf", "oneOf", "anyOf", "prefixItems"]

export function toJsonSchema(node: unknown, openapiVersion: string): unknown {
  const legacy = openapiVersion.startsWith("3.0")

  function convert(value: unknown): unknown {
    if (value === true || value === false) {
      return value
    }

    if (!isObject(value)) {
      return {}
    }

    const out: JsonObject = {}

    for (const [key, child] of entries(value)) {
      if (KEEP.has(key)) {
        out[key] = child
      }
    }

    const properties = own(value, "properties")
    const readOnly: string[] = []

    if (isObject(properties)) {
      const converted: JsonObject = {}
      for (const [name, schema] of entries(properties)) {
        if (own(schema, "readOnly") === true) {
          readOnly.push(name)
          continue
        }
        converted[name] = convert(schema)
      }
      out.properties = converted
    }

    const patternProperties = own(value, "patternProperties")
    if (isObject(patternProperties)) {
      const converted: JsonObject = {}
      for (const [pattern, schema] of entries(patternProperties)) {
        converted[pattern] = convert(schema)
      }
      out.patternProperties = converted
    }

    const items = own(value, "items")
    if (items !== undefined) {
      out.items = Array.isArray(items) ? items.map(convert) : convert(items)
    }

    const additional = own(value, "additionalProperties")
    if (additional !== undefined) {
      out.additionalProperties =
        typeof additional === "boolean" ? additional : convert(additional)
    }

    for (const key of SUBSCHEMA_LISTS) {
      const list = own(value, key)
      if (Array.isArray(list)) {
        out[key] = list.map(convert)
      }
    }

    const not = own(value, "not")
    if (not !== undefined) {
      out.not = convert(not)
    }

    if (Array.isArray(out.required)) {
      const required = out.required.filter(
        (name): name is string =>
          typeof name === "string" && !readOnly.includes(name),
      )
      if (required.length > 0) {
        out.required = required
      } else {
        delete out.required
      }
    } else {
      delete out.required
    }

    if (legacy) {
      for (const [flag, bound] of [
        ["exclusiveMinimum", "minimum"],
        ["exclusiveMaximum", "maximum"],
      ] as const) {
        if (out[flag] === true && typeof out[bound] === "number") {
          out[flag] = out[bound]
          delete out[bound]
        } else if (typeof out[flag] === "boolean") {
          delete out[flag]
        }
      }
    }

    const example = own(value, "example")
    if (example !== undefined && out.examples === undefined) {
      out.examples = [example]
    }

    if (out.type === undefined) {
      if (out.properties) {
        out.type = "object"
      } else if (out.items) {
        out.type = "array"
      }
    }

    if (legacy && own(value, "nullable") === true) {
      if (typeof out.type === "string") {
        out.type = [out.type, "null"]
        if (Array.isArray(out.enum) && !out.enum.includes(null)) {
          out.enum = [...out.enum, null]
        }
      } else if (out.type === undefined && Object.keys(out).length > 0) {
        return { anyOf: [out, { type: "null" }] }
      }
    }

    return out
  }

  return convert(node)
}
