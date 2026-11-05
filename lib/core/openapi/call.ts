import { STATUS_CODES } from "node:http"

import type { CallToolResult } from "@modelcontextprotocol/client"

import { PcpError } from "../errors"
import { PublicOnlyRefusal } from "../public-only"
import { AddressBlockedError } from "./address"
import { describeFetchError, discard, readCapped } from "./http"
import {
  CALL_TIMEOUT_MS,
  MAX_ERROR_EXCERPT,
  MAX_FILE_RESPONSE_BYTES,
  MAX_FILE_NAME_CHARS,
  MAX_RESPONSE_BYTES,
  MAX_STRUCTURED_CHARS,
} from "./limits"
import type { BuiltRequest } from "./request"
import { makeRedactor } from "./redact"
import { send, type SendOptions } from "./transport"

export { redactSecrets } from "./redact"

/**
 * Sends one request and turns the answer into an MCP tool result: JSON is
 * passed on compact (and as structuredContent when small enough; the gateway
 * shapes both for the assistant, see answers.ts), text
 * passes through. A file (a PDF, an image: any other type, or one the schema
 * declares `format: binary`) is kept for the token as a result and answered
 * as its handle, with its type, size and name, when the caller can keep one;
 * otherwise it is described rather than dumped. An error status is an error
 * result the assistant can read, not an exception.
 *
 * Redirects are never followed. fetch drops Authorization on a redirect to
 * another origin but keeps any other header, so following one could hand
 * an X-API-Key to whatever host the answer names.
 */

export type CallOutcome = { result: CallToolResult; status: number }

export function statusLine(response: Response): string {
  const text = response.statusText || STATUS_CODES[response.status] || ""
  return `HTTP ${response.status}${text ? ` ${text}` : ""}`
}

export function mediaType(response: Response): string {
  return (response.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase()
}

export function isJson(type: string): boolean {
  return /^application\/([\w.+-]+\+)?json$/.test(type)
}

export function isText(type: string): boolean {
  return (
    type.startsWith("text/") ||
    /^application\/([\w.+-]+\+)?(xml|yaml|x-yaml)$/.test(type) ||
    type === "application/javascript" ||
    type === "application/x-www-form-urlencoded"
  )
}

export function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** A file the API answered, for the caller to keep as the token's result. */
export type AnsweredFile = {
  bytes: Buffer
  mediaType: string
  name: string | null
}

/**
 * Keeps an answered file and returns its handle ({"$result": id, type,
 * size, name, readableUntil}), which the answer carries in its place.
 */
export type FileKeeper = (file: AnsweredFile) => Promise<{ $result: string }>

/**
 * The file name a Content-Disposition header offers (filename*, as RFC 6266
 * prefers, else filename), without a path; null when it names none.
 */
export function dispositionName(header: string | null): string | null {
  if (!header) {
    return null
  }

  let name: string | null = null
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header)

  if (extended) {
    const value = extended[1]!.trim().replace(/^"(.*)"$/, "$1")
    const parts = /^([\w!#$%&+^`{}~-]*)'[^']*'(.*)$/.exec(value)

    try {
      name = parts ? decodeURIComponent(parts[2]!) : null
    } catch {
      name = null
    }
  }

  if (name === null) {
    const plain = /(?:^|;)\s*filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]*)/i.exec(
      header,
    )

    if (plain) {
      name =
        plain[2] !== undefined
          ? plain[2].replace(/\\(.)/g, "$1")
          : plain[1]!.trim()
    }
  }

  const clean = (name ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .split(/[\\/]/)
    .pop()!
    .trim()
    .slice(0, MAX_FILE_NAME_CHARS)

  return clean === "" || clean === "." || clean === ".." ? null : clean
}

/**
 * The answer's media type for a kept file: a plain type/subtype, never one
 * that holds the credential (compared as the type was lower-cased), else
 * application/octet-stream.
 */
function safeType(type: string, redact: string[]): string {
  const plain = /^[\w.+-]+\/[\w.+-]+$/.test(type) && type.length <= 100

  return plain &&
    !redact.some(
      (value) => value.length >= 4 && type.includes(value.toLowerCase()),
    )
    ? type
    : "application/octet-stream"
}

/** Whether the bytes hold one of the credential's values as it is. */
function holdsSecret(bytes: Buffer, values: string[]): boolean {
  return values.some(
    (value) => value.length >= 4 && bytes.includes(Buffer.from(value, "utf8")),
  )
}

export async function executeCall(
  request: BuiltRequest,
  {
    timeoutMs = CALL_TIMEOUT_MS,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    redact = [],
    publicOnly = false,
    addressCheck,
    dial,
    keepFile,
    maxFileBytes = MAX_FILE_RESPONSE_BYTES,
    fileTypes = [],
  }: {
    timeoutMs?: number
    maxResponseBytes?: number
    /** Credential values to remove from whatever the API answers. */
    redact?: string[]
    /**
     * Keeps a file the API answered as the token's result. Without it a
     * file is described, not passed on.
     */
    keepFile?: FileKeeper
    /** The largest file kept; a larger one is refused, not cut. */
    maxFileBytes?: number
    /** Media types the schema declares as a file (`format: binary`). */
    fileTypes?: string[]
  } & SendOptions = {},
): Promise<CallOutcome> {
  // Everything below that is built from the answer goes through this: the
  // status line, a redirect's target and an error message are the API's
  // words as much as its body is.
  const scrub = makeRedactor(redact)
  let response: Response

  try {
    response = await send(
      request.url,
      {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(timeoutMs),
      },
      { publicOnly, addressCheck, dial },
    )
  } catch (error) {
    // A refused address is the endpoint's rule at work, not an outage.
    if (error instanceof AddressBlockedError) {
      throw new PublicOnlyRefusal(error.message)
    }

    throw new PcpError(
      "upstream",
      scrub.text(describeFetchError(error, timeoutMs)),
    )
  }

  const status = response.status

  if (status >= 300 && status < 400) {
    await discard(response)
    let target = ""
    try {
      const location = new URL(
        response.headers.get("location") ?? "",
        request.url,
      )
      target = ` to ${location.origin}${location.pathname}`
    } catch {
      // No usable Location; say only that it redirected.
    }

    return {
      status,
      result: {
        content: [
          {
            type: "text",
            text: scrub.text(
              `${statusLine(response)}: the API redirected${target}. PCP does not follow redirects; the owner can set the endpoint's base URL to where it points.`,
            ),
          },
        ],
        isError: true,
      },
    }
  }

  const ok = status >= 200 && status < 300
  const type = mediaType(response)
  const textual = isJson(type) || isText(type) || type === ""

  // A file, kept whole as the token's result: read up to its own cap, and
  // refused past it, never cut.
  if (ok && keepFile && (fileTypes.includes(type) || !textual)) {
    return answerFile(response, {
      type,
      textual,
      maxFileBytes,
      keepFile,
      scrub,
      redact,
      timeoutMs,
    })
  }

  let bytes: Buffer
  let truncated: boolean

  try {
    ;({ bytes, truncated } = await readCapped(response, maxResponseBytes))
  } catch (error) {
    throw new PcpError(
      "upstream",
      scrub.text(describeFetchError(error, timeoutMs)),
    )
  }

  const cut = truncated
    ? `\n… (truncated by PCP: the answer was larger than ${Math.round(maxResponseBytes / 1024)} KB)`
    : ""

  if (bytes.length === 0) {
    return {
      status,
      result: {
        content: [
          {
            type: "text",
            text: scrub.text(
              ok
                ? `(no content, ${statusLine(response)})`
                : statusLine(response),
            ),
          },
        ],
        ...(ok ? {} : { isError: true }),
      },
    }
  }

  let text: string | null = null
  let structured: unknown = undefined

  if (isJson(type) || isText(type) || type === "") {
    text = decodeUtf8(bytes) ?? (type === "" ? null : bytes.toString("utf8"))

    // Before the JSON is parsed, so the text and structuredContent are
    // both clean.
    if (text !== null) {
      text = scrub.text(text, { truncated })
    }
  }

  if (text !== null && isJson(type) && !truncated) {
    try {
      // Parsed and walked again: the parser decodes escapes (\/, \u0026,
      // \u00e9) that hid a key from the pass over the raw text.
      const value = scrub.value(JSON.parse(text))
      text = scrub.text(JSON.stringify(value))
      // Any JSON value, as MCP 2026-07-28 takes it: an API's list or
      // number is passed as it is, not wrapped.
      if (ok && JSON.stringify(value).length <= MAX_STRUCTURED_CHARS) {
        structured = value
      }
    } catch {
      // Not the JSON it claimed to be; pass the text on as it is.
    }
  }

  // Bytes with no type that are not text: a file after all.
  if (text === null && ok && keepFile && type === "" && !truncated) {
    return keptFileAnswer(
      status,
      {
        bytes,
        mediaType: "application/octet-stream",
        name:
          scrub.text(
            dispositionName(response.headers.get("content-disposition")) ?? "",
          ) || null,
      },
      { keepFile, redact },
    )
  }

  if (text === null) {
    const note = scrub.text(
      `(The API answered with ${bytes.length}${truncated ? "+" : ""} bytes of ${type || "unlabelled binary data"}; PCP passes on text and JSON only.)`,
    )
    return {
      status,
      result: {
        content: [
          {
            type: "text",
            text: ok ? note : scrub.text(`${statusLine(response)}\n${note}`),
          },
        ],
        ...(ok ? {} : { isError: true }),
      },
    }
  }

  if (!ok) {
    const excerpt =
      text.length > MAX_ERROR_EXCERPT
        ? `${text.slice(0, MAX_ERROR_EXCERPT)}\n…`
        : text
    return {
      status,
      result: {
        content: [
          {
            type: "text",
            text: scrub.text(`${statusLine(response)}\n${excerpt}`),
          },
        ],
        isError: true,
      },
    }
  }

  return {
    status,
    result: {
      content: [{ type: "text", text: `${text}${cut}` }],
      ...(structured !== undefined
        ? { structuredContent: structured as Record<string, unknown> }
        : {}),
    },
  }
}

const FILE_NOTE = (id: string) =>
  `PCP keeps this file for you: pass {"$result": "${id}"} where a tool wants a file (an upload's file argument, send_email's or create_draft's attachments, the browser's upload_file, a field that takes base64), read it with read_result, or get it onto your own computer with share_result's link where this token has it.`

function refusedFile(status: number, message: string): CallOutcome {
  return {
    status,
    result: { content: [{ type: "text", text: message }], isError: true },
  }
}

/** Reads a file the API answered, up to its cap, and keeps it. */
async function answerFile(
  response: Response,
  {
    type,
    textual,
    maxFileBytes,
    keepFile,
    scrub,
    redact,
    timeoutMs,
  }: {
    type: string
    textual: boolean
    maxFileBytes: number
    keepFile: FileKeeper
    scrub: ReturnType<typeof makeRedactor>
    redact: string[]
    timeoutMs: number
  },
): Promise<CallOutcome> {
  const status = response.status
  const tooLarge = (size: string) =>
    refusedFile(
      status,
      `The API answered with a file of ${size} bytes, more than PCP takes from an API (${maxFileBytes.toLocaleString("en")} bytes), so it was not kept. The owner can raise the largest file in PCP's settings, under Resources.`,
    )
  const declared = Number(response.headers.get("content-length") ?? "")

  // Said up front: nothing of it is read.
  if (Number.isSafeInteger(declared) && declared > maxFileBytes) {
    await discard(response)
    return tooLarge(declared.toLocaleString("en"))
  }

  let bytes: Buffer

  try {
    const read = await readCapped(response, maxFileBytes)

    if (read.truncated) {
      return tooLarge(`more than ${maxFileBytes.toLocaleString("en")}`)
    }

    bytes = read.bytes
  } catch (error) {
    throw new PcpError(
      "upstream",
      scrub.text(describeFetchError(error, timeoutMs)),
    )
  }

  if (bytes.length === 0) {
    return {
      status,
      result: {
        content: [
          {
            type: "text",
            text: scrub.text(`(no content, ${statusLine(response)})`),
          },
        ],
      },
    }
  }

  const name =
    scrub.text(
      dispositionName(response.headers.get("content-disposition")) ?? "",
    ) || null
  const asText = textual ? decodeUtf8(bytes) : null

  // A text the schema calls a file is scrubbed like any other text, and
  // kept as UTF-8.
  if (asText !== null) {
    return keptFileAnswer(
      status,
      {
        bytes: Buffer.from(scrub.text(asText), "utf8"),
        mediaType: `${safeType(type, redact)}; charset=utf-8`,
        name,
      },
      { keepFile, redact: [] },
    )
  }

  return keptFileAnswer(
    status,
    { bytes, mediaType: safeType(type, redact), name },
    { keepFile, redact },
  )
}

async function keptFileAnswer(
  status: number,
  file: AnsweredFile,
  { keepFile, redact }: { keepFile: FileKeeper; redact: string[] },
): Promise<CallOutcome> {
  // Bytes are not text to scrub: a file that holds the credential PCP sent
  // (an API that echoes the request back as a file) is not passed on.
  if (holdsSecret(file.bytes, redact)) {
    return refusedFile(
      status,
      "The API answered with a file that holds the credential PCP sent, so PCP did not keep it.",
    )
  }

  const handle = await keepFile(file)
  const value = { file: handle, note: FILE_NOTE(handle.$result) }

  return {
    status,
    result: {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    },
  }
}
