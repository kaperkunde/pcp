import { randomBytes } from "node:crypto"

import { asBytes } from "../crypto"
import { invalid, PcpError } from "../errors"
import { isBlockedHeader } from "./headers"
import { entries, isObject } from "./json"
import {
  MAX_HEADER_VALUE,
  MAX_REQUEST_BODY_BYTES,
  MAX_UPLOAD_BODY_BYTES,
  MAX_UPLOAD_FILES,
  USER_AGENT,
} from "./limits"
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
  /** Text, or the bytes of an upload. */
  body?: string | Uint8Array<ArrayBuffer>
}

/** A kept file an upload sends, read by the caller (endpoints.ts). */
export type UploadFile = { bytes: Buffer; name: string | null; type: string }

/**
 * The files of an upload, by where the plan puts them: the whole body
 * (binary), or a multipart field. The caller opens each handle the
 * arguments name; this file never reads a kept result itself.
 */
export type Uploads = {
  body?: UploadFile
  fields?: Record<string, UploadFile[]>
}

/** A header parameter's value: no quote, no line break. */
function dispositionValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/"/g, "%22")
}

function bareType(type: string): string {
  return type.split(";")[0]!.trim().toLowerCase()
}

/** A declared type to send as it is, or a wildcard the file's type fills. */
function uploadType(declared: string, file: UploadFile): string {
  const bare = bareType(declared)
  const fileType = bareType(file.type)
  const own = /^[\w.+-]+\/[\w.+-]+$/.test(fileType)
    ? fileType
    : "application/octet-stream"

  return bare.includes("*") || bare === "application/octet-stream"
    ? own
    : declared
}

function multipartBody(
  plan: NonNullable<CallPlan["body"]>,
  value: unknown,
  uploads: Uploads,
): { bytes: Buffer; contentType: string } {
  if (!isObject(value)) {
    throw invalid(`"${plan.arg}" must be an object of form fields.`)
  }

  const boundary = `----pcp${randomBytes(16).toString("hex")}`
  const parts: Buffer[] = []
  const fileFields = new Set((plan.files ?? []).map((file) => file.name))
  let count = 0

  const head = (name: string, extra = "") =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${dispositionValue(name)}"${extra}\r\n`,
      "utf8",
    )

  for (const [key, item] of entries(value)) {
    if (item === undefined || item === null) continue

    if (fileFields.has(key)) {
      const files = uploads.fields?.[key]

      if (!files || files.length === 0) {
        throw new PcpError(
          "state",
          `PCP did not read the file for "${key}"; nothing was sent.`,
        )
      }

      for (const file of files) {
        count += 1
        parts.push(
          head(key, `; filename="${dispositionValue(file.name ?? "file")}"`),
          Buffer.from(
            `Content-Type: ${uploadType("application/octet-stream", file)}\r\n\r\n`,
          ),
          file.bytes,
          Buffer.from("\r\n"),
        )
      }
      continue
    }

    const values =
      Array.isArray(item) && item.every((x) => !isObject(x)) ? item : [item]

    for (const entry of values) {
      const text =
        isObject(entry) || Array.isArray(entry)
          ? JSON.stringify(entry)
          : loose(entry, plan.arg)
      parts.push(head(key), Buffer.from(`\r\n${text}\r\n`, "utf8"))
    }
  }

  if (count > MAX_UPLOAD_FILES) {
    throw invalid(`An upload carries at most ${MAX_UPLOAD_FILES} files.`)
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`))

  return {
    bytes: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
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

/** encodeURIComponent, with its URIError (a lone surrogate) as a message. */
function encodePart(text: string, arg: string): string {
  try {
    return encodeURIComponent(text)
  } catch {
    throw invalid(`"${arg}" has a character that cannot be sent.`)
  }
}

function pathValue(param: ParamPlan, value: unknown): string {
  const encode = (item: unknown) => {
    const raw = scalar(item, param.arg)

    // A slash is encoded, so the value stays one segment on the wire, but a
    // server or proxy that decodes %2F before it tidies the path would read
    // "../../admin" as the path it spells. Refuse a dot component, however
    // the slashes around it are written.
    if (raw.split(/[\\/]/).some((part) => part === "." || part === "..")) {
      throw invalid(
        `"${param.arg}" cannot have "." or ".." between slashes, since a server may read them as a path.`,
      )
    }

    return encodePart(raw, param.arg)
  }
  let encoded: string

  if (param.serialize === "json") {
    encoded = encodePart(JSON.stringify(value), param.arg)
  } else if (Array.isArray(value)) {
    encoded = value.map(encode).join(",")
  } else if (isObject(value)) {
    encoded = entries(value)
      .map(([key, item]) =>
        param.explode
          ? `${encodePart(key, param.arg)}=${encode(item)}`
          : `${encodePart(key, param.arg)},${encode(item)}`,
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
    case "binary":
    case "multipart":
      throw new PcpError("state", "An upload is not encoded as text.")
  }
}

export function buildRequest(
  plan: CallPlan,
  baseUrl: string,
  args: unknown,
  auth: Record<string, string>,
  uploads: Uploads = {},
): BuiltRequest {
  if (args !== undefined && !isObject(args)) {
    throw invalid("The arguments must be an object.")
  }

  const given = args ?? {}
  const known = [
    ...plan.params
      .filter((param) => param.value === undefined)
      .map((param) => param.arg),
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
    const value = param.value ?? valueOf(param.arg)

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

  let body: string | Uint8Array<ArrayBuffer> | undefined

  if (plan.body) {
    const value = valueOf(plan.body.arg)

    if (value === undefined) {
      if (plan.body.required) {
        throw invalid(`Missing argument "${plan.body.arg}".`)
      }
    } else if (
      plan.body.encoding === "binary" ||
      plan.body.encoding === "multipart"
    ) {
      let bytes: Buffer

      if (plan.body.encoding === "binary") {
        const file = uploads.body

        if (!file) {
          throw new PcpError(
            "state",
            `PCP did not read the file for "${plan.body.arg}"; nothing was sent.`,
          )
        }

        bytes = file.bytes
        headers["content-type"] = uploadType(plan.body.contentType, file)
      } else {
        const built = multipartBody(plan.body, value, uploads)
        bytes = built.bytes
        headers["content-type"] = built.contentType
      }

      if (bytes.length > MAX_UPLOAD_BODY_BYTES) {
        throw invalid(
          `The upload is larger than ${MAX_UPLOAD_BODY_BYTES / 1024 / 1024} MB.`,
        )
      }

      body = asBytes(bytes)
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
