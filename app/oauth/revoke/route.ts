import { revokeRequest } from "@/lib/core/oauth-server/tokens"
import {
  formParams,
  oauthErrorResponse,
  oauthJson,
  oauthRateLimit,
  preflight,
} from "@/lib/server/oauth-endpoints"

/**
 * Token revocation (RFC 7009): an assistant signing itself out. Revoking a
 * refresh token revokes the API token it belongs to.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const RATE_LIMIT = { max: 60, windowMs: 60_000 }

export async function POST(request: Request): Promise<Response> {
  const limited = await oauthRateLimit("revoke", RATE_LIMIT)

  if (limited) {
    return limited
  }

  try {
    await revokeRequest(
      await formParams(request),
      request.headers.get("authorization"),
    )

    return oauthJson(null)
  } catch (error) {
    return oauthErrorResponse(error)
  }
}

export const OPTIONS = preflight
