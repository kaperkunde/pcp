import { redirect } from "next/navigation"

import { isPcpError } from "@/lib/core/errors"
import { finishOAuth } from "@/lib/core/oauth"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireSession } from "@/lib/server/session"

export const dynamic = "force-dynamic"

/** Where the authorization server sends the browser back with a code. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { ctx } = await requireSession()
  let destination = `/servers/${id}?connected=1`

  try {
    await finishOAuth(ctx, id, new URL(request.url).searchParams, {
      publicUrl: await publicUrlFor(ctx, request),
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
