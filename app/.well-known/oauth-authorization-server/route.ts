import { authorizationServerMetadata } from "@/lib/core/oauth-server/metadata"
import { discoveryJson, preflight } from "@/lib/server/oauth-endpoints"
import { publicUrlWithoutSession } from "@/lib/server/public-url"

/**
 * Authorization server metadata (RFC 8414). The issuer is PCP's public URL,
 * which differs per install, so this is answered per request.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  return discoveryJson(
    authorizationServerMetadata(await publicUrlWithoutSession(request)),
  )
}

export const OPTIONS = preflight
