import { tokenRequest } from "@/lib/core/oauth-server/tokens"
import {
  formParams,
  oauthErrorResponse,
  oauthJson,
  oauthRateLimit,
  preflight,
} from "@/lib/server/oauth-endpoints"
import { publicUrlWithoutSession } from "@/lib/server/public-url"

/**
 * The token endpoint of PCP's authorization server: a code (with its PKCE
 * verifier) or a refresh token in, an access token and a new refresh token
 * out. See lib/core/oauth-server/tokens.ts.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Generous: an assistant's servers share a few addresses between all of
// their users.
const RATE_LIMIT = { max: 120, windowMs: 60_000 }

export async function POST(request: Request): Promise<Response> {
  const limited = await oauthRateLimit("token", RATE_LIMIT)

  if (limited) {
    return limited
  }

  try {
    const params = await formParams(request)
    const tokens = await tokenRequest(
      params,
      request.headers.get("authorization"),
      await publicUrlWithoutSession(request),
    )

    return oauthJson(tokens)
  } catch (error) {
    return oauthErrorResponse(error)
  }
}

export const OPTIONS = preflight
