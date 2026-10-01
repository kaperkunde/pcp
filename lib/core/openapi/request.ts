import { invalid, PcpError } from "../errors"
import { isBlockedHeader } from "./headers"
import { entries, isObject } from "./json"
import { MAX_HEADER_VALUE, MAX_REQUEST_BODY_BYTES, USER_AGENT } from "./limits"
import type { CallPlan, ParamPlan } from "./plan"

/**
 * An assistant's arguments as one HTTP request, following the call plan.
 * Everything the assistant sends is data in a place the plan named: a path
 * segment (percent-encoded, never "." or ".."), a query parameter, a
 * declared header (never one PCP owns), or the body. The credential goes
 * on last, so no argument can replace it, and the finished URL must still
 * be under the endpoint's base URL.
 */

export type BuiltRequest = {
  url: string
  method: CallPlan["method"]
  headers: Record<string, string>
  body?: string
}

const HEADER_VALUE = new RegExp(`^[\\t\\x20-\\x7e]{0,${MAX_HEADER_VALUE}}$`)

function scalar(value: unknown, arg: string): string {
  if (typeof value === "string") {
    return value
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value)
  }

  if (typeof value === "boolean") {
    return String(value)
  }

  throw invalid(`"${arg}" must be a string, a number or a boolean here.`)
}

function loose(value: unknown, arg: string): string {
  return isObject(value) || Array.isArray(value)
    ? JSON.stringify(value)
    : scalar(value, arg)
}

function pathValue(param: ParamPlan, value: unknown): string {
  const encode = (item: unknown) => encodeURIComponent(scalar(item, param.arg))
  let encoded: string

  if (param.serialize === "json") {
    encoded = encodeURIComponent(JSON.stringify(value))
  } else if (Array.isArray(value)) {
    encoded = value.map(encode).join(",")
  } else if (isObject(value)) {
    encoded = entries(value)
      .map(([key, item]) =>
        param.explode
          ? `${encodeURIComponent(key)}=${encode(item)}`
          : `${encodeURIComponent(key)},${encode(item)}`,
      )
      .join(",")
  } else {
    encoded = encode(value)
  }

  // encodeURIComponent leaves dots alone, and a "." or ".." segment would
  // move the request to another path once the URL is normalized.
  if (encoded === "" || encoded === "." || encoded === "..") {
    throw invalid(`"${param.arg}" cannot be empty, "." or "..".`)
  }

  return encoded
}

function appendQuery(
  query: URLSearchParams,
  param: ParamPlan,
  value: unknown,
): void {
  if (param.serialize === "json") {
    query.append(param.name, JSON.stringify(value))
    return
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => scalar(item, param.arg))

    switch (param.style) {
      case "spaceDelimited":
        query.append(param.name, items.join(" "))
        return
      case "pipeDelimited":
        query.append(param.name, items.join("|"))
        return
      case "deepObject":
        throw invalid(`"${param.arg}" must be an object.`)
      default:
        if (param.explode) {
          for (const item of items) query.append(param.name, item)
        } else {
          query.append(param.name, items.join(","))
        }
        return
    }
  }

  if (isObject(value)) {
    const pairs = entries(value).map(
      ([key, item]) => [key, scalar(item, param.arg)] as const,
    )

    if (param.style === "deepObject") {
      for (const [key, item] of pairs) {
        query.append(`${param.name}[${key}]`, item)
      }
    } else if (param.style === "form" && param.explode) {
      for (const [key, item] of pairs) query.append(key, item)
    } else {
      query.append(param.name, pairs.flat().join(","))
    }
    return
  }

  query.append(param.name, scalar(value, param.arg))
}

function headerValue(param: ParamPlan, value: unknown): string {
  const text =
    param.serialize === "json"
      ? JSON.stringify(value)
      : Array.isArray(value)
        ? value.map((item) => scalar(item, param.arg)).join(",")
        : isObject(value)
          ? entries(value)
              .map(([key, item]) =>
                param.explode
                  ? `${key}=${scalar(item, param.arg)}`
                  : `${key},${scalar(item, param.arg)}`,
              )
              .join(",")
          : scalar(value, param.arg)

  if (!HEADER_VALUE.test(text)) {
    throw invalid(
      `"${param.arg}" contains characters a header cannot carry, or is too long.`,
    )
  }

  return text
}

function encodeBody(
  plan: NonNullable<CallPlan["body"]>,
  value: unknown,
): string {
  switch (plan.encoding) {
    case "json":
      return JSON.stringify(value)
    case "form": {
      if (!isObject(value)) {
        throw invalid(`"${plan.arg}" must be an object of form fields.`)
      }
      const form = new URLSearchParams()
      for (const [key, item] of entries(value)) {
        if (item === undefined || item === null) continue
        if (Array.isArray(item)) {
          for (const entry of item) form.append(key, loose(entry, plan.arg))
        } else {
          form.append(key, loose(item, plan.arg))
        }
      }
      return form.toString()
    }
    case "text":
      return loose(value, plan.arg)
  }
}

export function buildRequest(
  plan: CallPlan,
  baseUrl: string,
  args: unknown,
  auth: Record<string, string>,
): BuiltRequest {
  if (args !== undefined && !isObject(args)) {
    throw invalid("The arguments must be an object.")
  }

  const given = args ?? {}
  const known = [
    ...plan.params.map((param) => param.arg),
    ...(plan.body ? [plan.body.arg] : []),
  ]

  for (const key of Object.keys(given)) {
    if (!known.includes(key)) {
      throw invalid(
        `Unknown argument "${key}". This tool takes: ${known.join(", ") || "no arguments"}.`,
      )
    }
  }

  const valueOf = (arg: string) => {
    const value = Object.hasOwn(given, arg) ? given[arg] : undefined
    return value === null ? undefined : value
  }

  let path = plan.path
  const query = new URLSearchParams()
  const headers: Record<string, string> = {}
  const authNames = Object.keys(auth)

  for (const param of plan.params) {
    const value = valueOf(param.arg)

    if (value === undefined) {
      if (param.required) {
        throw invalid(`Missing argument "${param.arg}".`)
      }
      continue
    }

    switch (param.in) {
      case "path":
        path = path.split(`{${param.name}}`).join(pathValue(param, value))
        break
      case "query":
        appendQuery(query, param, value)
        break
      case "header":
        if (!isBlockedHeader(param.name, authNames)) {
          headers[param.name.toLowerCase()] = headerValue(param, value)
        }
        break
    }
  }

  if (/\{[^}]*\}/.test(path)) {
    throw new PcpError(
      "state",
      "PCP's plan for this tool leaves part of its path unfilled; re-read the schema.",
    )
  }

  let body: string | undefined

  if (plan.body) {
    const value = valueOf(plan.body.arg)

    if (value === undefined) {
      if (plan.body.required) {
        throw invalid(`Missing argument "${plan.body.arg}".`)
      }
    } else {
      body = encodeBody(plan.body, value)

      if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) {
        throw invalid(
          `The request body is larger than ${MAX_REQUEST_BODY_BYTES / 1024 / 1024} MB.`,
        )
      }

      headers["content-type"] = plan.body.contentType
    }
  }

  headers.accept = plan.accept
  headers["user-agent"] = USER_AGENT

  for (const [name, value] of Object.entries(auth)) {
    headers[name.toLowerCase()] = value
  }

  const base = new URL(baseUrl)
  const basePath = base.pathname.replace(/\/+$/, "")
  const url = new URL(base.origin)
  url.pathname = `${basePath}${path}`
  url.search = query.toString()

  const inside =
    url.origin === base.origin &&
    (basePath === "" ||
      url.pathname === basePath ||
      url.pathname.startsWith(`${basePath}/`))

  if (!inside) {
    throw new PcpError(
      "state",
      "The request would leave the endpoint's base URL, so PCP did not send it.",
    )
  }

  return {
    url: url.toString(),
    method: plan.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  }
}
