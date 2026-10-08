import {
  getTab,
  runningBrowser,
  saveVaultProfile,
  tabView,
  touch,
} from "@/lib/core/browser/runtime"
import {
  subscribeScreencast,
  type Frame,
  type ScreencastSubscription,
} from "@/lib/core/browser/screencast"
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
  // What waits to be sent, newest only: a connection slower than the
  // screencast (through pcp.gg over a home upload) skips frames instead of
  // piling them up here. The stream asks for the next piece (`pull`) only
  // once the last one is on its way, so nothing queues past one event.
  let tabState: unknown = null
  let frame: Frame | null = null
  let ending: { event: string; data: unknown } | null = null
  let done = false
  let wake: (() => void) | null = null
  let subscription: ScreencastSubscription | null = null
  let ticker: ReturnType<typeof setInterval> | null = null
  const notify = () => {
    wake?.()
    wake = null
  }
  const end = (event: string, data: unknown) => {
    ending ??= { event, data }
    notify()
  }
  const finish = () => {
    if (done) return
    done = true
    if (ticker) clearInterval(ticker)
    subscription?.stop()
    notify()
    const vault = runningBrowser(ctx.vaultId)
    if (vault) {
      void saveVaultProfile(ctx, vault).catch(() => {})
    }
  }
  const event = (name: string, data: unknown) =>
    encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)

  const stream = new ReadableStream<Uint8Array>({
    async start() {
      tabState = await tabView(tab)
      subscription = await subscribeScreencast(tab, (next) => {
        touch(ctx.vaultId)
        frame = next
        notify()
      })

      // Gone while this was starting.
      if (done) {
        subscription?.stop()
        return
      }

      if (!subscription) {
        end("full", {
          message:
            "This tab already has as many people watching as it can show.",
        })
        return
      }

      ticker = setInterval(() => {
        if (tab.page.isClosed()) {
          end("closed", {})
          return
        }
        void tabView(tab).then((view) => {
          tabState = view
          notify()
        })
      }, STATE_EVERY_MS)
      tab.page.once("close", () => end("closed", {}))
      request.signal.addEventListener("abort", finish)

      if (request.signal.aborted) {
        finish()
      }
    },
    async pull(controller) {
      while (!done && !ending && tabState === null && frame === null) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }

      if (done || ending) {
        if (ending && !done) {
          controller.enqueue(event(ending.event, ending.data))
        }
        finish()
        controller.close()
        return
      }

      if (tabState !== null) {
        controller.enqueue(event("tab", tabState))
        tabState = null
        return
      }

      controller.enqueue(event("frame", frame))
      frame = null
      // Chromium may paint the next one.
      subscription?.took()
    },
    cancel() {
      finish()
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
