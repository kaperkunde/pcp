import { invalid } from "../errors"
import { isBlockedHeader } from "../openapi/headers"
import { MAX_HEADER_VALUE } from "../openapi/limits"
import {
  MAX_FETCH_BODY_BYTES,
  MAX_FETCH_HEADERS,
  MAX_FETCH_LENGTH,
  MAX_FETCH_URL_LENGTH,
} from "./limits"
import { normalizeMethod } from "./rules"

/**
 * An assistant's web_fetch arguments as the request PCP will send, checked
 * before anything is stored or asked: the owner is only ever shown, and
 * only ever allows, a request PCP can make as it stands.
 */

/** What web_fetch takes, as the gateway's schema names it. */
export type FetchInput = {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  raw?: boolean
  max_length?: number
  start_index?: number
}

/** A checked request. Kept on a permission request as it is, encrypted. */
export type FetchArgs = {
  url: string
  method: string
  /** Lower-case names. */
  headers: Record<string, string>
  body?: string
  /** Hand HTML back as it is, not as Markdown. */
  raw?: boolean
  maxLength?: number
  startIndex?: number
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/
const HEADER_VALUE = new RegExp(`^[\\t\\x20-\\x7e]{0,${MAX_HEADER_VALUE}}$`)

/**
 * Headers an assistant may set although an API call may not: here they are
 * the assistant's own request, with no credential of the owner's beside them.
 */
const ASSISTANT_HEADERS = new Set(["accept", "content-type"])

/** Methods whose request has no body. */
const NO_BODY = new Set(["GET", "HEAD"])

export function validateFetchUrl(raw: string): URL {
  const trimmed = raw.trim()

  if (!trimmed) {
    throw invalid("Give the page's full address, like https://example.com/.")
  }

  if (trimmed.length > MAX_FETCH_URL_LENGTH) {
    throw invalid(
      `Keep the address under ${MAX_FETCH_URL_LENGTH.toLocaleString("en")} characters.`,
    )
  }

  let url: URL

  try {
    url = new URL(trimmed)
  } catch {
    throw invalid("Give the page's full address, like https://example.com/.")
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalid("web_fetch reads http:// and https:// addresses only.")
  }

  if (url.username || url.password) {
    throw invalid(
      "The address cannot contain a user name or password: web_fetch sends no credentials.",
    )
  }

  // The fragment is the browser's, never sent.
  url.hash = ""
  return url
}

function checkHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const entries = Object.entries(headers ?? {})

  if (entries.length > MAX_FETCH_HEADERS) {
    throw invalid(`Send at most ${MAX_FETCH_HEADERS} headers.`)
  }

  const checked: Record<string, string> = {}

  for (const [name, value] of entries) {
    if (!HEADER_NAME.test(name)) {
      throw invalid(`"${name.slice(0, 100)}" is not a header name.`)
    }

    const lower = name.toLowerCase()

    if (!ASSISTANT_HEADERS.has(lower) && isBlockedHeader(name)) {
      throw invalid(
        `web_fetch does not send a ${name} header from an assistant: PCP sets it itself, or it would carry a credential or change who the request seems to come from.`,
      )
    }

    if (typeof value !== "string" || !HEADER_VALUE.test(value)) {
      throw invalid(
        `The ${name} header is too long or has characters that cannot be sent.`,
      )
    }

    if (Object.hasOwn(checked, lower)) {
      throw invalid(`The ${name} header is given twice.`)
    }

    checked[lower] = value
  }

  return checked
}

function checkCount(
  value: number | undefined,
  name: string,
  { min, max }: { min: number; max: number },
): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(
      `${name} must be a whole number from ${min} to ${max.toLocaleString("en")}.`,
    )
  }

  return value
}

export function prepareFetch(input: FetchInput): FetchArgs {
  const url = validateFetchUrl(String(input.url ?? ""))
  const method = normalizeMethod(input.method)
  const headers = checkHeaders(input.headers)
  const body = input.body === "" ? undefined : input.body

  if (body !== undefined) {
    if (typeof body !== "string") {
      throw invalid("The body must be text.")
    }

    if (NO_BODY.has(method)) {
      throw invalid(
        `A ${method} request has no body; use POST, or put the data in the address.`,
      )
    }

    if (Buffer.byteLength(body, "utf8") > MAX_FETCH_BODY_BYTES) {
      throw invalid(
        `Keep the body under ${MAX_FETCH_BODY_BYTES / 1024 / 1024} MB.`,
      )
    }
  }

  const maxLength = checkCount(input.max_length, "max_length", {
    min: 1,
    max: MAX_FETCH_LENGTH,
  })
  const startIndex = checkCount(input.start_index, "start_index", {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  })

  return {
    url: url.toString(),
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(input.raw ? { raw: true } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(startIndex ? { startIndex } : {}),
  }
}
