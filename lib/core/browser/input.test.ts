import { describe, expect, it } from "vitest"

import { dispatchInput } from "./input"
import { InputBatchSchema, type InputBatch } from "./input-protocol"
import { INPUT_REPLAY_DELAY_MS } from "./limits"
import type { Tab } from "./runtime"

// The owner's input replayed in a tab: trusted events through the DevTools
// protocol, in order, each at the pace it was made and stamped with that
// time, so a CAPTCHA reading the mouse sees a person's cadence.

type Sent = { method: string; params: Record<string, unknown>; at: number }

function fakeTab(): { tab: Tab; sent: Sent[] } {
  const sent: Sent[] = []
  const tab = {
    extra: new Map(),
    cdp: {
      send: async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params, at: Date.now() })
        return {}
      },
    },
  } as unknown as Tab

  return { tab, sent }
}

const parse = (batch: InputBatch) => InputBatchSchema.parse(batch)

/**
 * A tab whose DevTools session acknowledges a mouse move only after
 * `ackMs`, as Chromium does with its next frame (about 17 ms at 60 Hz);
 * `ackMs` Infinity never acknowledges one.
 */
function slowTab(ackMs: number): { tab: Tab; sent: Sent[] } {
  const sent: Sent[] = []
  const tab = {
    extra: new Map(),
    cdp: {
      send: (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params, at: Date.now() })

        if (params.type !== "mouseMoved") return Promise.resolve({})
        if (!Number.isFinite(ackMs)) return new Promise(() => {})
        return new Promise((resolve) => setTimeout(() => resolve({}), ackMs))
      },
    },
  } as unknown as Tab

  return { tab, sent }
}

const moves = (from: number, count: number, every = 1) =>
  Array.from({ length: count }, (_, i) => ({
    type: "move" as const,
    t: from + i * every,
    x: 10 + i,
    y: 20,
  }))

describe("replaying the owner's input", () => {
  it("keeps the order, the gaps between events and their timestamps", async () => {
    const { tab, sent } = fakeTab()

    await dispatchInput(
      tab,
      parse({
        seq: 0,
        events: [
          { type: "move", t: 1000, x: 10, y: 20 },
          { type: "move", t: 1030, x: 14, y: 26 },
          { type: "down", t: 1100, x: 14, y: 26, button: "left", buttons: 1 },
          { type: "up", t: 1180, x: 14, y: 26, button: "left" },
        ],
      }),
    )

    expect(sent.map((call) => call.params.type)).toEqual([
      "mouseMoved",
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ])

    const stamps = sent.map((call) => (call.params.timestamp as number) * 1000)
    expect(stamps[1]! - stamps[0]!).toBeCloseTo(30, 0)
    expect(stamps[3]! - stamps[0]!).toBeCloseTo(180, 0)

    // Played at that pace, not in a burst.
    expect(sent[3]!.at - sent[0]!.at).toBeGreaterThanOrEqual(170)
    expect(sent[0]!.at - stamps[0]!).toBeGreaterThanOrEqual(-5)
    expect(sent[2]!.params).toMatchObject({
      button: "left",
      buttons: 1,
      clickCount: 1,
    })
  })

  it("gives a press and a drag the half pressure of a real mouse, and a move or release none", async () => {
    const { tab, sent } = fakeTab()

    await dispatchInput(
      tab,
      parse({
        seq: 0,
        events: [
          { type: "move", t: 2000, x: 10, y: 20 },
          { type: "down", t: 2010, x: 10, y: 20, button: "left", buttons: 1 },
          { type: "move", t: 2020, x: 14, y: 22, buttons: 1 },
          { type: "up", t: 2030, x: 14, y: 22, button: "left" },
          { type: "move", t: 2040, x: 18, y: 22 },
        ],
      }),
    )

    // What a page reads as PointerEvent.pressure: 0 for a hover, 0.5 while a
    // button is down. A release carries none, as Playwright's own mouse sends.
    expect(sent.map((call) => [call.params.type, call.params.force])).toEqual([
      ["mouseMoved", 0],
      ["mousePressed", 0.5],
      ["mouseMoved", 0.5],
      ["mouseReleased", undefined],
      ["mouseMoved", 0],
    ])
  })

  it("starts a new clock for input that arrives long after it was made", async () => {
    const { tab, sent } = fakeTab()

    await dispatchInput(
      tab,
      parse({ seq: 0, events: [{ type: "move", t: 0, x: 1, y: 1 }] }),
    )
    const started = Date.now()
    // The next batch says it happened 5 seconds later, but arrives at once
    // after a pause the clock cannot explain: it plays now, not in 5 s.
    await new Promise((resolve) => setTimeout(resolve, 700))
    await dispatchInput(
      tab,
      parse({ seq: 1, events: [{ type: "move", t: 100, x: 2, y: 2 }] }),
    )

    expect(Date.now() - started).toBeLessThan(700 + INPUT_REPLAY_DELAY_MS + 200)
    expect(sent).toHaveLength(2)
  })

  it("keeps the pace of input that arrives late, rather than bursting it", async () => {
    const { tab, sent } = fakeTab()

    await dispatchInput(
      tab,
      parse({
        seq: 0,
        events: [
          { type: "move", t: 0, x: 1, y: 1 },
          { type: "move", t: 20, x: 2, y: 2 },
        ],
      }),
    )
    // The next batch was made right after, but a slow link delivers it
    // about 200 ms late.
    await new Promise((resolve) => setTimeout(resolve, 250))
    await dispatchInput(
      tab,
      parse({
        seq: 1,
        events: [
          { type: "move", t: 40, x: 3, y: 3 },
          { type: "move", t: 80, x: 4, y: 4 },
          { type: "move", t: 120, x: 5, y: 5 },
        ],
      }),
    )

    const late = sent.slice(2)
    expect(late[1]!.at - late[0]!.at).toBeGreaterThanOrEqual(30)
    expect(late[2]!.at - late[1]!.at).toBeGreaterThanOrEqual(30)
    // Stamped at that pace too, less the millisecond per event the replay
    // closes up by once input is in time again.
    const stamps = late.map((call) => (call.params.timestamp as number) * 1000)
    expect(stamps[2]! - stamps[0]!).toBeGreaterThanOrEqual(76)
    expect(stamps[2]! - stamps[0]!).toBeLessThanOrEqual(80)
  })

  it("keeps up with a fast mouse though Chromium acknowledges a move only with its next frame", async () => {
    const { tab, sent } = slowTab(17)
    const started = Date.now()

    // 200 samples over 200 ms, as a 1,000 Hz mouse sends them.
    await dispatchInput(tab, parse({ seq: 0, events: moves(0, 200) }))

    // At its own pace, not 200 acknowledgements one after another
    // (3.4 s, during which everything after it waits).
    expect(Date.now() - started).toBeLessThan(200 + INPUT_REPLAY_DELAY_MS + 250)
    expect(sent).toHaveLength(200)
    expect(sent.map((call) => call.params.x)).toEqual(
      moves(0, 200).map((event) => event.x),
    )
    const stamps = sent.map((call) => (call.params.timestamp as number) * 1000)
    expect(stamps.at(-1)! - stamps[0]!).toBeGreaterThanOrEqual(190)
  })

  it("drops moves, never a click, while Chromium is far behind", async () => {
    const { tab, sent } = slowTab(Infinity)

    await dispatchInput(
      tab,
      parse({
        seq: 0,
        events: [
          ...moves(0, 15, 100),
          { type: "down", t: 1500, x: 5, y: 5, button: "left", buttons: 1 },
          { type: "up", t: 1550, x: 5, y: 5, button: "left" },
        ],
      }),
    )

    const kinds = sent.map((call) => call.params.type)
    // Moves stop once the oldest one Chromium has not taken has waited
    // a second; the click still goes.
    expect(kinds.filter((kind) => kind === "mouseMoved").length).toBeLessThan(
      15,
    )
    expect(kinds.slice(-2)).toEqual(["mousePressed", "mouseReleased"])
  })

  it("types printable keys as text and leaves shortcuts as keys", async () => {
    const { tab, sent } = fakeTab()

    await dispatchInput(
      tab,
      parse({
        seq: 0,
        events: [
          { type: "keydown", t: 0, key: "a", code: "KeyA", keyCode: 65 },
          { type: "keyup", t: 5, key: "a", code: "KeyA", keyCode: 65 },
          {
            type: "keydown",
            t: 10,
            key: "c",
            code: "KeyC",
            keyCode: 67,
            modifiers: 2,
          },
          { type: "keydown", t: 20, key: "Enter", code: "Enter", keyCode: 13 },
          { type: "text", t: 30, text: "pasted text" },
        ],
      }),
    )

    expect(
      sent.map((call) => [
        call.method,
        call.params.type ?? null,
        call.params.text ?? null,
      ]),
    ).toEqual([
      ["Input.dispatchKeyEvent", "keyDown", "a"],
      ["Input.dispatchKeyEvent", "keyUp", null],
      ["Input.dispatchKeyEvent", "rawKeyDown", null],
      ["Input.dispatchKeyEvent", "keyDown", "\r"],
      ["Input.insertText", null, "pasted text"],
    ])
  })

  it("refuses what is not input", () => {
    expect(() => parse({ seq: 0, events: [] })).toThrow()
    expect(() =>
      parse({ seq: 0, events: [{ type: "eval", t: 0 } as never] }),
    ).toThrow()
    expect(() =>
      parse({ seq: 0, events: [{ type: "move", t: 0, x: 1e9, y: 0 }] }),
    ).toThrow()
  })
})
