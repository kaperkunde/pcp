import { redirect } from "next/navigation"

import { isPcpError } from "@/lib/core/errors"
import { finishGoogleConnect, googleStateFor } from "@/lib/core/google/account"
import { finishOAuth, serverForState } from "@/lib/core/oauth"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireSession } from "@/lib/server/session"

export const dynamic = "force-dynamic"

/**
 * Where every authorization server sends the browser back with a code: the
 * one redirect address the owner registers with a provider. The state
 * parameter says which sign-in it was for: the Google sign-in (the owner's
 * Google page), or a server.
 */
export async function GET(request: Request) {
  const { ctx } = await requireSession()
  const params = new URL(request.url).searchParams
  let destination: string

  if (await googleStateFor(ctx, params).catch(() => false)) {
    try {
      await finishGoogleConnect(ctx, params, {
        publicUrl: await publicUrlFor(ctx, request),
      })
      destination = "/servers/google?connected=1"
    } catch (error) {
      const message = isPcpError(error)
        ? error.message
        : "Could not finish connecting Google."
      console.error("[google] callback failed", {
        error: isPcpError(error) ? error.code : "unexpected",
      })
      destination = `/servers/google?error=${encodeURIComponent(message.slice(0, 300))}`
    }

    redirect(destination)
  }

  try {
    const { serverId } = await finishOAuth(ctx, params, {
      publicUrl: await publicUrlFor(ctx, request),
    })
    destination = `/servers/${serverId}?connected=1`
  } catch (error) {
    const message = isPcpError(error)
      ? error.message
      : `Could not finish the connection: ${error instanceof Error ? error.message : String(error)}`
    const serverId = await serverForState(ctx, params).catch(() => null)
    console.error("[oauth] callback failed", { serverId, error })
    destination = `${serverId ? `/servers/${serverId}` : "/servers"}?error=${encodeURIComponent(message.slice(0, 300))}`
  }

  redirect(destination)
}
