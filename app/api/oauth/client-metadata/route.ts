import { clientMetadataDocument } from "@/lib/core/oauth-client"
import { PCP_CLIENT_INFO } from "@/lib/core/upstream"
import { publicUrlWithoutSession } from "@/lib/server/public-url"

export const dynamic = "force-dynamic"

/**
 * PCP's OAuth client metadata document: an authorization server that
 * supports them fetches it when PCP signs in with this address as its
 * client ID, instead of PCP registering itself. Public on purpose; it says
 * only what any registration would (PCP's name and its redirect address).
 */
export async function GET(request: Request) {
  const document = clientMetadataDocument(
    await publicUrlWithoutSession(request),
    PCP_CLIENT_INFO.version,
  )

  if (!document) {
    // Off https no authorization server will use it, and PCP never offers it.
    return Response.json({ error: "not_found" }, { status: 404 })
  }

  return Response.json(document, {
    headers: { "cache-control": "public, max-age=3600" },
  })
}
