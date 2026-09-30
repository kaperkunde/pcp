import { redirect } from "next/navigation"

import { isPcpError } from "@/lib/core/errors"
import { startOAuth } from "@/lib/core/oauth"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireSession } from "@/lib/server/session"

export const dynamic = "force-dynamic"

/**
 * Begins connecting an OAuth server: PCP discovers the authorization
 * server, registers itself if it must, and sends the browser to sign in.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { ctx } = await requireSession()
  let destination: string

  try {
    const result = await startOAuth(ctx, id, {
      publicUrl: await publicUrlFor(ctx, request),
    })
    destination =
      "redirectTo" in result ? result.redirectTo : `/servers/${id}?connected=1`
  } catch (error) {
    const message = isPcpError(error)
      ? error.message
      : `Could not start the connection: ${error instanceof Error ? error.message : String(error)}`
    console.error("[oauth] start failed", { id, error })
    destination = `/servers/${id}?error=${encodeURIComponent(message.slice(0, 300))}`
  }

  redirect(destination)
}
