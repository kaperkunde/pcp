import {
  getTab,
  runningBrowser,
  saveVaultProfile,
  tabView,
  touch,
} from "@/lib/core/browser/runtime"
import { subscribeScreencast } from "@/lib/core/browser/screencast"
import { isSameOrigin } from "@/lib/server/same-origin"
import { currentSession } from "@/lib/server/session"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** How often the tab's address, title and who drives it are sent again. */
const STATE_EVERY_MS = 1_500

/**
 * The live view of a browser tab, for the signed-in owner: server-sent
 * events carrying the tab's state (`tab`), each picture of it as Chromium
 * paints it (`frame`, a JPEG and the viewport it shows), and `closed` when
 * it goes. A route handler, not a Server Action: an action answers once,
 * and this answers for as long as the page watches. Like the export
 * download, it checks for itself that the request came from PCP's own page.
 *
 * Watching keeps the browser from closing as idle, and when the owner
 * stops watching, what they did in the tab is saved with their key.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOrigin(request)) {
    return problem(403, "That request did not come from PCP's own page.")
  }

  const session = await currentSession()

  if (!session) {
    return problem(401, "Sign in first.")
  }

  const { id } = await params
  const { ctx } = session
  const tab = getTab(ctx.vaultId, id)

  if (!tab) {
    return problem(404, "That tab is closed.")
  }

  const encoder = new TextEncoder()
  let stop: (() => void) | null = null

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const send = (event: string, data: unknown) => {
        if (!open) return
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          )
        } catch {
          finish()
        }
      }
      const finish = () => {
        if (!open) return
        open = false
        stop?.()
        try {
          controller.close()
        } catch {
          // Already closed by the reader.
        }
        const vault = runningBrowser(ctx.vaultId)
        if (vault) {
          void saveVaultProfile(ctx, vault).catch(() => {})
        }
      }

      send("tab", await tabView(tab))
      const unsubscribe = await subscribeScreencast(tab, (frame) => {
        touch(ctx.vaultId)
        send("frame", frame)
      })

      if (!unsubscribe) {
        send("full", {
          message:
            "This tab already has as many people watching as it can show.",
        })
        finish()
        return
      }

      const ticker = setInterval(() => {
        if (tab.page.isClosed()) {
          send("closed", {})
          finish()
          return
        }
        void tabView(tab).then((view) => send("tab", view))
      }, STATE_EVERY_MS)

      stop = () => {
        clearInterval(ticker)
        unsubscribe()
      }
      tab.page.once("close", () => {
        send("closed", {})
        finish()
      })
      request.signal.addEventListener("abort", finish)
    },
    cancel() {
      stop?.()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      // Nginx and the like would hold the frames back otherwise.
      "X-Accel-Buffering": "no",
    },
  })
}

function problem(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  )
}
