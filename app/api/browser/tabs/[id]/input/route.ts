import { dispatchInput } from "@/lib/core/browser/input"
import { InputBatchSchema } from "@/lib/core/browser/input-protocol"
import { INPUT_BATCHES, MAX_INPUT_BATCH_BYTES } from "@/lib/core/browser/limits"
import {
  getTab,
  runningBrowser,
  saveVaultProfile,
  touch,
} from "@/lib/core/browser/runtime"
import { checkRateLimit } from "@/lib/core/rate-limit"
import { isSameOrigin } from "@/lib/server/same-origin"
import { currentSession } from "@/lib/server/session"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * The owner's mouse and keyboard in a browser tab they hold: a batch of
 * events, each with the time it happened, replayed in the tab at the pace
 * it was made (lib/core/browser/input.ts). A route handler for the same
 * reason as the stream next to it, with the same checks: PCP's own page,
 * the owner's session, and a tab of their vault that they have taken over.
 *
 * It answers once the batch is queued, not once it has played: the page
 * sends one batch at a time, and holding each answer for its replay would
 * hold the next batch behind it, so input would arrive later and later.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOrigin(request)) {
    return problem(403, "That request did not come from PCP's own page.")
  }

  const length = request.headers.get("content-length")

  if (length !== null && Number(length) > MAX_INPUT_BATCH_BYTES) {
    return problem(413, "That is too much input at once.")
  }

  const session = await currentSession()

  if (!session) {
    return problem(401, "Sign in first.")
  }

  if (!checkRateLimit(`browser-input:${session.sessionId}`, INPUT_BATCHES)) {
    return problem(429, "Too much input at once; slow down.")
  }

  const { id } = await params
  const { ctx } = session
  const tab = getTab(ctx.vaultId, id)

  if (!tab) {
    return problem(404, "That tab is closed.")
  }

  if (tab.control !== "owner") {
    return problem(409, "Take the tab over first.")
  }

  let body: unknown

  try {
    const text = await request.text()

    if (text.length > MAX_INPUT_BATCH_BYTES) {
      return problem(413, "That is too much input at once.")
    }

    body = JSON.parse(text)
  } catch {
    return problem(400, "The input could not be read.")
  }

  const batch = InputBatchSchema.safeParse(body)

  if (!batch.success) {
    return problem(400, "The input could not be read.")
  }

  touch(ctx.vaultId)
  // Played in order behind the batches before it; the profile is saved
  // (at most every few seconds) once this one has gone out.
  void dispatchInput(tab, batch.data)
    .catch(() => {})
    .then(async () => {
      const vault = runningBrowser(ctx.vaultId)

      if (vault) {
        await saveVaultProfile(ctx, vault)
      }
    })
    .catch((error) =>
      console.error("[browser] saving the profile failed", error),
    )

  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  })
}

function problem(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  )
}
