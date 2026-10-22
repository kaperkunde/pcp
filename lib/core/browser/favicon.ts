import type { CDPSession } from "patchright-core"

import { FAVICON_BUFFER_BYTES, MAX_FAVICON_BYTES } from "./limits"

/**
 * A tab's icon, for the owner's list of tabs. Chromium fetches a page's
 * icon itself, through the tab (its own `<link rel="icon">`, through the
 * proxy as every request is), as a request of type Other; PCP reads the
 * bytes of that response off the tab's DevTools session once it has
 * arrived. Nothing is fetched for it, nothing runs in the page, and what
 * the owner's page shows is a data: address, so their own browser never
 * asks the site for anything either. A page whose icon Chromium did not
 * load (or one too large, or not a picture) has none, and the list shows
 * the site's first letter.
 */

/** The pictures an icon may be. SVG in an <img> runs nothing and loads nothing. */
const ICON_TYPES = new Set([
  "image/png",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/gif",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/avif",
  "image/bmp",
])

/**
 * The icon as a data: address, or null when it is not one PCP shows: a
 * type outside ICON_TYPES, nothing, or over MAX_FAVICON_BYTES.
 */
export function faviconDataUrl(
  mimeType: string,
  body: string,
  base64Encoded: boolean,
): string | null {
  const type = mimeType.split(";")[0]!.trim().toLowerCase()

  if (!ICON_TYPES.has(type)) {
    return null
  }

  const bytes = base64Encoded
    ? Buffer.from(body, "base64")
    : Buffer.from(body, "utf8")

  if (bytes.length === 0 || bytes.length > MAX_FAVICON_BYTES) {
    return null
  }

  return `data:${type};base64,${bytes.toString("base64")}`
}

type ResponseReceived = {
  requestId: string
  type?: string
  frameId?: string
  response: { mimeType: string }
}

/**
 * Follows a tab's icon on its DevTools session: forgotten when the main
 * frame loads another document, set when Chromium has the new page's icon.
 * `mine` says whether the session is still the tab's (a reopened tab has
 * another), `mainFrame` which frame is the page's own.
 */
export async function watchFavicon(
  cdp: CDPSession,
  {
    mainFrame,
    mine,
    set,
  }: {
    mainFrame: () => string
    mine: () => boolean
    set: (favicon: string | null) => void
  },
): Promise<void> {
  // Icons by request id, between the response and the end of its body.
  const icons = new Map<string, string>()

  cdp.on("Network.responseReceived", (event: ResponseReceived) => {
    if (!mine() || event.frameId !== mainFrame()) return

    if (event.type === "Document") {
      icons.clear()
      set(null)
    } else if (
      event.type === "Other" &&
      event.response.mimeType.toLowerCase().startsWith("image/")
    ) {
      icons.set(event.requestId, event.response.mimeType)
    }
  })
  cdp.on("Network.loadingFinished", ({ requestId }: { requestId: string }) => {
    const mimeType = icons.get(requestId)
    if (mimeType === undefined) return
    icons.delete(requestId)

    void cdp
      .send("Network.getResponseBody", { requestId })
      .then(({ body, base64Encoded }) => {
        const favicon = faviconDataUrl(mimeType, body, base64Encoded)
        if (favicon && mine()) set(favicon)
      })
      .catch(() => {
        // Gone from Chromium's buffer, or the page closed: no icon.
      })
  })
  cdp.on("Network.loadingFailed", ({ requestId }: { requestId: string }) => {
    icons.delete(requestId)
  })

  await cdp.send("Network.enable", {
    maxResourceBufferSize: MAX_FAVICON_BYTES,
    maxTotalBufferSize: FAVICON_BUFFER_BYTES,
  })
}
