import { protectedResourceMetadata } from "@/lib/core/oauth-server/metadata"
import { discoveryJson, preflight } from "@/lib/server/oauth-endpoints"
import { publicUrlWithoutSession } from "@/lib/server/public-url"

/**
 * Protected resource metadata (RFC 9728) for the gateway: at
 * /.well-known/oauth-protected-resource/mcp, where a 401 from /mcp points,
 * and at the bare address for clients that look there. It names PCP itself
 * as the authorization server.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ resource?: string[] }> },
): Promise<Response> {
  const { resource = [] } = await params

  if (resource.length > 0 && resource.join("/") !== "mcp") {
    return new Response("Not found", { status: 404 })
  }

  return discoveryJson(
    protectedResourceMetadata(await publicUrlWithoutSession(request)),
  )
}

export const OPTIONS = preflight
