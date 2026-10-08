import { MAX_VIEWERS_PER_TAB, SCREENCAST_QUALITY, VIEWPORT } from "./limits"
import type { Tab } from "./runtime"

/**
 * The live view's pictures: Chromium's screencast of a tab, one JPEG each
 * time the page repaints, shared by everyone watching it. The first viewer
 * starts it and the last one stops it; a viewer who joins is given the
 * latest frame at once, since a still page sends no more.
 *
 * Chromium sends the next frame only once the last one is acknowledged, and
 * PCP acknowledges it only when a viewer has taken it (`took`), so the
 * screencast runs at the pace of the fastest viewer's connection. A slower
 * viewer (one watching through pcp.gg over a home upload, say) keeps only
 * the newest frame it has not sent yet and skips the rest: it falls behind
 * by a frame, never by a queue of them.
 */

export type FrameMetadata = {
  /** The viewport the frame shows, in CSS pixels. */
  deviceWidth: number
  deviceHeight: number
  pageScaleFactor: number
  offsetTop: number
  scrollOffsetX: number
  scrollOffsetY: number
}

export type Frame = {
  /** Base64 JPEG. */
  data: string
  metadata: FrameMetadata
}

type Viewer = (frame: Frame) => void

type Screencast = {
  viewers: Set<Viewer>
  last: Frame | null
  /** The frame Chromium waits on to be acknowledged before it paints on. */
  unacked: number | null
  ack: (() => void) | null
  stop: (() => Promise<void>) | null
}

export type ScreencastSubscription = {
  /** The viewer sent a frame on and can take another. */
  took: () => void
  stop: () => void
}

const SCREENCAST = "screencast"

function stateOf(tab: Tab): Screencast {
  let state = tab.extra.get(SCREENCAST) as Screencast | undefined

  if (!state) {
    state = {
      viewers: new Set(),
      last: null,
      unacked: null,
      ack: null,
      stop: null,
    }
    tab.extra.set(SCREENCAST, state)
  }

  return state
}

export function viewerCount(tab: Tab): number {
  return stateOf(tab).viewers.size
}

async function start(tab: Tab, state: Screencast): Promise<void> {
  const { cdp } = tab
  const onFrame = (event: {
    data: string
    metadata: FrameMetadata
    sessionId: number
  }) => {
    state.unacked = event.sessionId
    const frame = { data: event.data, metadata: event.metadata }
    state.last = frame

    for (const viewer of state.viewers) {
      viewer(frame)
    }
  }

  state.ack = () => {
    if (state.unacked === null) return
    const sessionId = state.unacked
    state.unacked = null
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {})
  }
  cdp.on("Page.screencastFrame", onFrame)
  state.stop = async () => {
    cdp.off("Page.screencastFrame", onFrame)
    await cdp.send("Page.stopScreencast").catch(() => {})
  }
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: SCREENCAST_QUALITY,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  })
}

/**
 * Starts handing a tab's frames to a viewer, which calls `took` each time it
 * has sent one on, and `stop` when it goes. Refuses past MAX_VIEWERS_PER_TAB.
 */
export async function subscribeScreencast(
  tab: Tab,
  viewer: Viewer,
): Promise<ScreencastSubscription | null> {
  const state = stateOf(tab)

  if (state.viewers.size >= MAX_VIEWERS_PER_TAB) {
    return null
  }

  state.viewers.add(viewer)

  if (state.viewers.size === 1 && !state.stop) {
    await start(tab, state)
  } else if (state.last) {
    viewer(state.last)
  }

  return {
    took: () => state.ack?.(),
    stop: () => {
      state.viewers.delete(viewer)

      if (state.viewers.size === 0 && state.stop) {
        const stop = state.stop
        state.stop = null
        state.last = null
        state.unacked = null
        state.ack = null
        void stop()
      }
    },
  }
}
