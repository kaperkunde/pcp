import { describe, expect, it } from "vitest"

import { MAX_VIEWERS_PER_TAB } from "./limits"
import type { Tab } from "./runtime"
import { subscribeScreencast, viewerCount, type Frame } from "./screencast"

// One screencast per tab, shared: the first viewer starts it, the last one
// stops it, a frame is acknowledged once a viewer took it, and a viewer who
// joins late gets the latest frame at once.

function fakeTab() {
  const sent: string[] = []
  const handlers = new Map<string, (event: unknown) => void>()
  const tab = {
    extra: new Map(),
    cdp: {
      send: async (method: string) => {
        sent.push(method)
        return {}
      },
      on: (event: string, handler: (event: unknown) => void) =>
        handlers.set(event, handler),
      off: (event: string) => handlers.delete(event),
    },
  } as unknown as Tab
  const emit = (data: string) =>
    handlers.get("Page.screencastFrame")?.({
      data,
      sessionId: 1,
      metadata: {
        deviceWidth: 1280,
        deviceHeight: 800,
        pageScaleFactor: 1,
        offsetTop: 0,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    })

  return { tab, sent, emit }
}

describe("the live view's screencast", () => {
  it("is shared by its viewers, started once and stopped by the last", async () => {
    const { tab, sent, emit } = fakeTab()
    const first: Frame[] = []
    const second: Frame[] = []

    const firstViewer = await subscribeScreencast(tab, (frame) =>
      first.push(frame),
    )
    emit("frame-1")
    const ack = () =>
      sent.filter((method) => method === "Page.screencastFrameAck").length
    // Chromium waits until a viewer has sent the frame on.
    expect(ack()).toBe(0)
    firstViewer!.took()
    expect(ack()).toBe(1)

    const secondViewer = await subscribeScreencast(tab, (frame) =>
      second.push(frame),
    )
    emit("frame-2")
    secondViewer!.took()
    firstViewer!.took()

    expect(first.map((frame) => frame.data)).toEqual(["frame-1", "frame-2"])
    // The late viewer starts from the latest frame.
    expect(second.map((frame) => frame.data)).toEqual(["frame-1", "frame-2"])
    expect(
      sent.filter((method) => method === "Page.startScreencast"),
    ).toHaveLength(1)
    // Once per frame, whoever took it first.
    expect(ack()).toBe(2)

    firstViewer!.stop()
    expect(sent).not.toContain("Page.stopScreencast")
    secondViewer!.stop()
    await Promise.resolve()
    expect(sent).toContain("Page.stopScreencast")
    expect(viewerCount(tab)).toBe(0)
  })

  it("turns away viewers past the limit", async () => {
    const { tab } = fakeTab()

    for (let i = 0; i < MAX_VIEWERS_PER_TAB; i++) {
      expect(await subscribeScreencast(tab, () => {})).not.toBeNull()
    }

    expect(await subscribeScreencast(tab, () => {})).toBeNull()
  })
})
