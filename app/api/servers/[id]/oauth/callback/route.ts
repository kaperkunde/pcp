import { redirect } from "next/navigation"

import { isPcpError } from "@/lib/core/errors"
import { finishOAuth } from "@/lib/core/oauth"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireSession } from "@/lib/server/session"

export const dynamic = "force-dynamic"

/**
 * The per-server redirect address PCP registered itself with before there
 * was one for the whole install (/api/oauth/callback). Clients registered
 * then still send the browser here.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { ctx } = await requireSession()
  let destination = `/servers/${id}?connected=1`

  try {
    await finishOAuth(ctx, new URL(request.url).searchParams, {
      publicUrl: await publicUrlFor(ctx, request),
      serverId: id,
    })
  } catch (error) {
    const message = isPcpError(error)
      ? error.message
      : `Could not finish the connection: ${error instanceof Error ? error.message : String(error)}`
    console.error("[oauth] callback failed", { id, error })
    destination = `/servers/${id}?error=${encodeURIComponent(message.slice(0, 300))}`
  }

  redirect(destination)
}
