import type { CallToolResult } from "@modelcontextprotocol/server"

import { PcpError } from "../errors"
import { AddressBlockedError } from "../openapi/address"
import {
  decodeUtf8,
  isJson,
  isText,
  mediaType,
  statusLine,
} from "../openapi/call"
import { describeFetchError, discard, readCapped } from "../openapi/http"
import { send, type SendOptions } from "../openapi/transport"
import { PCP_VERSION } from "../version"
import {
  decodeBody,
  htmlToMarkdown,
  isHtml,
  looksLikeHtml,
  sliceText,
} from "./html"
import {
  DEFAULT_FETCH_LENGTH,
  FETCH_ACCEPT,
  FETCH_TIMEOUT_MS,
  MAX_FETCH_REDIRECTS,
  MAX_FETCH_RESPONSE_BYTES,
} from "./limits"
import type { FetchArgs } from "./request"
import { siteKey } from "./rules"

/**
 * Sends one web_fetch request and turns the answer into a tool result.
 *
 * Public addresses only, always: the name is resolved by PCP and every
 * address it answers with is checked as the socket connects
 * (openapi/transport.ts), so a page cannot be used to reach the owner's own
 * network. No secret is read and no cookie is kept: what goes out is what
 * the assistant wrote, with PCP's user agent.
 *
 * Redirects are followed by hand and only within the site the owner decided
 * about. One to another site ends the call with where it pointed, so that
 * site gets its own decision when the assistant fetches it.
 */

const USER_AGENT = `pcp/${PCP_VERSION} (web_fetch)`
const REDIRECTS = new Set([301, 302, 303, 307, 308])

export type FetchOptions = Pick<SendOptions, "addressCheck">

function result(text: string, isError: boolean): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  }
}

function headersFor(args: FetchArgs): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: FETCH_ACCEPT,
    ...args.headers,
  }

  if (args.body !== undefined && !headers["content-type"]) {
    let json = false

    try {
      JSON.parse(args.body)
      json = true
    } catch {
      json = false
    }

    headers["content-type"] = json
      ? "application/json"
      : "text/plain; charset=utf-8"
  }

  return headers
}

export async function fetchWeb(
  args: FetchArgs,
  { addressCheck }: FetchOptions = {},
): Promise<CallToolResult> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const site = siteKey(new URL(args.url))
  const headers = headersFor(args)
  let url = new URL(args.url)
  let method = args.method
  let body = args.body

  for (let hop = 0; ; hop++) {
    let response: Response

    try {
      response = await send(
        url.toString(),
        { method, headers, body, signal },
        { publicOnly: true, addressCheck },
      )
    } catch (error) {
      if (error instanceof AddressBlockedError) {
        throw new PcpError(
          "forbidden",
          `${error.host} is, or resolves to, a private or local address, and web_fetch only reaches public ones.`,
        )
      }

      throw new PcpError(
        "upstream",
        `${url.host} could not be reached: ${describeFetchError(error, FETCH_TIMEOUT_MS)}.`,
      )
    }

    const location = REDIRECTS.has(response.status)
      ? response.headers.get("location")
      : null

    if (location === null) {
      return readAnswer(response, url, args)
    }

    await discard(response)
    let next: URL

    try {
      next = new URL(location, url)
    } catch {
      return result(
        `${statusLine(response)}: ${url} redirects to an address PCP cannot read.`,
        true,
      )
    }

    next.hash = ""

    if (
      (next.protocol !== "https:" && next.protocol !== "http:") ||
      next.username ||
      next.password
    ) {
      return result(
        `${statusLine(response)}: ${url} redirects to an address web_fetch does not follow (${next.protocol}).`,
        true,
      )
    }

    if (siteKey(next) !== site) {
      return result(
        `${statusLine(response)}: ${url} redirects to ${next}, which is another site. PCP follows redirects only within a site, so the owner decides about that one on its own: call web_fetch with ${next} to continue.`,
        false,
      )
    }

    if (hop >= MAX_FETCH_REDIRECTS) {
      return result(
        `${url} redirected more than ${MAX_FETCH_REDIRECTS} times; give the final address.`,
        true,
      )
    }

    // What browsers do: a 303 is always fetched with GET, and a 301 or 302
    // after a POST too. 307 and 308 repeat the request as it was.
    if (
      response.status === 303 ||
      (method === "POST" &&
        (response.status === 301 || response.status === 302))
    ) {
      method = method === "HEAD" ? "HEAD" : "GET"
      body = undefined
      delete headers["content-type"]
    }

    url = next
  }
}

async function readAnswer(
  response: Response,
  url: URL,
  args: FetchArgs,
): Promise<CallToolResult> {
  let read: { bytes: Buffer; truncated: boolean }

  try {
    read = await readCapped(response, MAX_FETCH_RESPONSE_BYTES)
  } catch (error) {
    throw new PcpError(
      "upstream",
      `${url.host} stopped answering: ${describeFetchError(error, FETCH_TIMEOUT_MS)}.`,
    )
  }

  const ok = response.status >= 200 && response.status < 300
  const type = mediaType(response)
  const contentType = response.headers.get("content-type") ?? ""
  const { bytes, truncated } = read
  const lead = [`URL: ${url}`, `Status: ${statusLine(response)}`]

  if (bytes.length === 0) {
    return result(`${lead.join("\n")}\n\n(no content)`, !ok)
  }

  const html = isHtml(type) || (type === "" && looksLikeHtml(bytes))
  const textual = html || isJson(type) || isText(type)
  const unlabelledText = type === "" && !html && decodeUtf8(bytes) !== null

  if (!textual && !unlabelledText) {
    lead.push(`Type: ${type || "unlabelled binary data"}`)
    return result(
      `${lead.join("\n")}\n\n(The page is ${bytes.length}${truncated ? "+" : ""} bytes of ${type || "binary data"}; web_fetch passes on HTML, text and JSON only.)`,
      !ok,
    )
  }

  let text = decodeBody(bytes, contentType, html)
  let kind = type || (html ? "text/html" : "text/plain")

  if (html && !args.raw) {
    try {
      const converted = htmlToMarkdown(text, url.toString())

      if (converted.title) {
        lead.push(`Title: ${converted.title}`)
      }

      text = converted.markdown
      kind = `${kind}, as Markdown`
    } catch {
      kind = `${kind}, as HTML (PCP could not convert it)`
    }
  } else if (isJson(type) && !truncated) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      // Not the JSON it claimed to be; pass the text on as it is.
    }
  }

  lead.push(`Type: ${kind}`)

  if (truncated) {
    lead.push(
      `PCP read the first ${MAX_FETCH_RESPONSE_BYTES / 1024 / 1024} MB of the answer only.`,
    )
  }

  const slice = sliceText(
    text,
    args.startIndex ?? 0,
    args.maxLength ?? DEFAULT_FETCH_LENGTH,
  )

  if (slice.total === 0) {
    return result(`${lead.join("\n")}\n\n(no text)`, !ok)
  }

  if ((args.startIndex ?? 0) >= slice.total) {
    lead.push(
      `start_index ${args.startIndex} is past the end: the text has ${slice.total} characters.`,
    )
    return result(lead.join("\n"), true)
  }

  lead.push(
    slice.end < slice.total
      ? `Characters ${slice.start} to ${slice.end} of ${slice.total}; call again with start_index ${slice.end} for the rest.`
      : slice.start > 0
        ? `Characters ${slice.start} to ${slice.end} of ${slice.total}: the end.`
        : `${slice.total} characters.`,
  )

  return result(`${lead.join("\n")}\n\n${slice.part}`, !ok)
}
