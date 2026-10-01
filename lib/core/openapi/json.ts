/**
 * Reading untrusted JSON. Lookups go through Object.hasOwn so a key such as
 * "constructor" never resolves to something on Object.prototype, and copies
 * skip "__proto__", the one key whose assignment changes an object's
 * prototype instead of adding a property.
 */

export type JsonObject = Record<string, unknown>

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function own(object: unknown, key: string): unknown {
  return isObject(object) && Object.hasOwn(object, key)
    ? object[key]
    : undefined
}

export function ownString(object: unknown, key: string): string | undefined {
  const value = own(object, key)
  return typeof value === "string" ? value : undefined
}

export function entries(object: unknown): Array<[string, unknown]> {
  return isObject(object)
    ? Object.entries(object).filter(([key]) => key !== "__proto__")
    : []
}
