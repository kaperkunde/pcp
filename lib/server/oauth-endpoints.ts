import "server-only"

import { OAuthError } from "@/lib/core/oauth-server/errors"
import { checkRateLimit } from "@/lib/core/rate-limit"
import { clientIp } from "@/lib/server/client-ip"

/**
 * What the route handlers of PCP's authorization server have in common
 * (app/oauth/*, app/.well-known/*): JSON answers that are never cached,
 * CORS for clients that run in a browser, form bodies read strictly, and
 * OAuth errors as RFC 6749 §5.2 shapes them. The logic is in
 * lib/core/oauth-server/.
 */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
}

/** Bodies the token and revocation endpoints take; theirs are small. */
const MAX_FORM_BYTES = 16 * 1024

export function oauthJson(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === null ? {} : { "Content-Type": "application/json" }),
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...CORS_HEADERS,
      ...extra,
    },
  })
}

/** A discovery document: public, the same for everyone, briefly cached. */
export function discoveryJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
      ...CORS_HEADERS,
    },
  })
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

export function oauthErrorResponse(error: unknown): Response {
  if (error instanceof OAuthError) {
    return oauthJson(
      error.toJSON(),
      error.status,
      error.status === 401 ? { "WWW-Authenticate": 'Basic realm="pcp"' } : {},
    )
  }

  console.error("[oauth] request error", error)
  return oauthJson(
    {
      error: "server_error",
      error_description: "PCP could not answer this request.",
    },
    500,
  )
}

/** Within the per-address limit for this endpoint, or the answer to send. */
export async function oauthRateLimit(
  endpoint: string,
  limit: { max: number; windowMs: number },
): Promise<Response | null> {
  if (checkRateLimit(`oauth-${endpoint}:${await clientIp()}`, limit)) {
    return null
  }

  return oauthJson(
    {
      error: "temporarily_unavailable",
      error_description: "Too many requests; slow down.",
    },
    429,
    { "Retry-After": String(Math.ceil(limit.windowMs / 1000)) },
  )
}

async function cappedText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  const text = declared > maxBytes ? null : await request.text()

  if (text === null || Buffer.byteLength(text) > maxBytes) {
    throw new OAuthError("invalid_request", "The request body is too large.")
  }

  return text
}

/**
 * An application/x-www-form-urlencoded body as single values. A parameter
 * sent twice is refused, as RFC 6749 §3.2 requires.
 */
export async function formParams(
  request: Request,
): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? ""

  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(type)) {
    throw new OAuthError(
      "invalid_request",
      "Send the parameters as application/x-www-form-urlencoded.",
    )
  }

  const params: Record<string, string> = {}

  for (const [key, value] of new URLSearchParams(
    await cappedText(request, MAX_FORM_BYTES),
  )) {
    if (Object.hasOwn(params, key)) {
      throw new OAuthError("invalid_request", `${key} was sent twice.`)
    }

    params[key] = value
  }

  return params
}

/** A JSON body of at most `maxBytes`. */
export async function jsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const type = request.headers.get("content-type") ?? ""

  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new OAuthError(
      "invalid_client_metadata",
      "Send the client's metadata as application/json.",
    )
  }

  try {
    return JSON.parse(await cappedText(request, maxBytes))
  } catch (error) {
    if (error instanceof OAuthError) {
      throw error
    }

    throw new OAuthError(
      "invalid_client_metadata",
      "The body is not valid JSON.",
    )
  }
}
