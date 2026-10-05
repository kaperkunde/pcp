import { MAX_VIEWERS_PER_TAB, SCREENCAST_QUALITY, VIEWPORT } from "./limits"
import type { Tab } from "./runtime"

/**
 * The live view's pictures: Chromium's screencast of a tab, one JPEG each
 * time the page repaints, shared by everyone watching it. The first viewer
 * starts it and the last one stops it; a viewer who joins is given the
 * latest frame at once, since a still page sends no more.
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
  stop: (() => Promise<void>) | null
}

const SCREENCAST = "screencast"

function stateOf(tab: Tab): Screencast {
  let state = tab.extra.get(SCREENCAST) as Screencast | undefined

  if (!state) {
    state = { viewers: new Set(), last: null, stop: null }
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
    cdp
      .send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch(() => {})
    const frame = { data: event.data, metadata: event.metadata }
    state.last = frame

    for (const viewer of state.viewers) {
      viewer(frame)
    }
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
 * Starts sending a tab's frames to a viewer; the function it returns
 * stops. Refuses past MAX_VIEWERS_PER_TAB.
 */
export async function subscribeScreencast(
  tab: Tab,
  viewer: Viewer,
): Promise<(() => void) | null> {
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

  return () => {
    state.viewers.delete(viewer)

    if (state.viewers.size === 0 && state.stop) {
      const stop = state.stop
      state.stop = null
      state.last = null
      void stop()
    }
  }
}
