import { STATUS_CODES } from "node:http"

import type { CallToolResult } from "@modelcontextprotocol/client"

import { PcpError } from "../errors"
import { AddressBlockedError } from "./address"
import { describeFetchError, discard, readCapped } from "./http"
import { isObject } from "./json"
import {
  CALL_TIMEOUT_MS,
  MAX_ERROR_EXCERPT,
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
 * passes through, anything else is described rather than dumped. An error
 * status is an error result the assistant can read, not an exception.
 *
 * Redirects are never followed. fetch drops Authorization on a redirect to
 * another origin but keeps any other header, so following one could hand
 * an X-API-Key to whatever host the answer names.
 */

export type CallOutcome = { result: CallToolResult; status: number }

function statusLine(response: Response): string {
  const text = response.statusText || STATUS_CODES[response.status] || ""
  return `HTTP ${response.status}${text ? ` ${text}` : ""}`
}

function mediaType(response: Response): string {
  return (response.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase()
}

function isJson(type: string): boolean {
  return /^application\/([\w.+-]+\+)?json$/.test(type)
}

function isText(type: string): boolean {
  return (
    type.startsWith("text/") ||
    /^application\/([\w.+-]+\+)?(xml|yaml|x-yaml)$/.test(type) ||
    type === "application/javascript" ||
    type === "application/x-www-form-urlencoded"
  )
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export async function executeCall(
  request: BuiltRequest,
  {
    timeoutMs = CALL_TIMEOUT_MS,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    redact = [],
    publicOnly = false,
    addressCheck,
  }: {
    timeoutMs?: number
    maxResponseBytes?: number
    /** Credential values to remove from whatever the API answers. */
    redact?: string[]
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
      { publicOnly, addressCheck },
    )
  } catch (error) {
    // A refused address is the endpoint's rule at work, not an outage.
    if (error instanceof AddressBlockedError) {
      throw new PcpError("forbidden", error.message)
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

  const ok = status >= 200 && status < 300
  const type = mediaType(response)
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
  let structured: Record<string, unknown> | null = null

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
      const wrapped = isObject(value) ? value : { value }
      if (ok && JSON.stringify(wrapped).length <= MAX_STRUCTURED_CHARS) {
        structured = wrapped
      }
    } catch {
      // Not the JSON it claimed to be; pass the text on as it is.
    }
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
      ...(structured ? { structuredContent: structured } : {}),
    },
  }
}
