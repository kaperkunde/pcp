import type { Page, Response } from "patchright-core"

import { isChallenge } from "../fetch/challenge"

/**
 * What a page's main frame shows: the last document it loaded, and whether
 * that was a site's check of its visitors (fetch/challenge.ts) rather than
 * the page. A check Cloudflare can decide without the visitor (most of
 * them) passes on its own a few seconds after it loads: its script reloads
 * or posts back, and the next document is the page. One that wants a person
 * (a box to tick) stays until someone does it, which in PCP is the owner
 * through hand_over.
 *
 * It only listens: nothing runs in the page, and nothing is read from it
 * but the answers' status and headers, which Chromium reports anyway.
 */

/** How waiting for a check ended. */
export type ChallengeOutcome = "passed" | "still" | "gone"

export type DocumentWatch = {
  /** The document the main frame shows is a site's check. */
  challenged: () => boolean
  /** That document's HTTP status, or null before the first. */
  status: () => number | null
  /**
   * Waits until the main frame shows a document that is not a check, loaded
   * as far as DOMContentLoaded: "passed" (at once if it already does),
   * "still" when the time runs out on a check, "gone" when the page closes.
   * A page that is no longer a check but still loading when the time runs
   * out counts as passed.
   */
  pass: (timeoutMs: number) => Promise<ChallengeOutcome>
}

function isMainDocument(page: Page, response: Response): boolean {
  try {
    return (
      response.frame() === page.mainFrame() &&
      response.request().isNavigationRequest()
    )
  } catch {
    // A service worker's answer has no frame; service workers are blocked.
    return false
  }
}

/** Starts watching a page; for its whole life, before its first load. */
export function watchDocuments(page: Page): DocumentWatch {
  let challenged = false
  let status: number | null = null
  let loaded = true
  let closed = false
  const waiters = new Set<() => void>()
  const wake = () => {
    for (const waiter of [...waiters]) waiter()
  }

  page.on("response", (response) => {
    if (!isMainDocument(page, response)) {
      return
    }

    const code = response.status()

    // A redirect leads on to the document; a 204 or 205 opens none (it is
    // how the gate answers a page it refuses), so the old one stays.
    if ((code >= 300 && code < 400) || code === 204 || code === 205) {
      return
    }

    challenged = isChallenge(response.headers())
    status = code
    loaded = false
    wake()
  })
  page.on("domcontentloaded", () => {
    loaded = true
    wake()
  })
  page.on("close", () => {
    closed = true
    wake()
  })

  return {
    challenged: () => challenged,
    status: () => status,
    pass: (timeoutMs) =>
      new Promise<ChallengeOutcome>((resolve) => {
        const finish = (outcome: ChallengeOutcome) => {
          clearTimeout(timer)
          waiters.delete(check)
          resolve(outcome)
        }
        const check = () => {
          if (closed) finish("gone")
          else if (!challenged && loaded) finish("passed")
        }
        const timer = setTimeout(
          () => finish(closed ? "gone" : challenged ? "still" : "passed"),
          timeoutMs,
        )

        waiters.add(check)
        check()
      }),
  }
}
