import { registerClient } from "@/lib/core/oauth-server/clients"
import { MAX_REGISTRATION_BYTES } from "@/lib/core/oauth-server/limits"
import {
  jsonBody,
  oauthErrorResponse,
  oauthJson,
  oauthRateLimit,
  preflight,
} from "@/lib/server/oauth-endpoints"

/**
 * Dynamic client registration (RFC 7591), open to anyone: a registration
 * gets nothing until the owner approves a sign-in for it on PCP's page.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const RATE_LIMIT = { max: 20, windowMs: 60 * 60_000 }

export async function POST(request: Request): Promise<Response> {
  const limited = await oauthRateLimit("register", RATE_LIMIT)

  if (limited) {
    return limited
  }

  try {
    const client = await registerClient(
      await jsonBody(request, MAX_REGISTRATION_BYTES),
    )

    return oauthJson(client, 201)
  } catch (error) {
    return oauthErrorResponse(error)
  }
}

export const OPTIONS = preflight
