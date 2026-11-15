import {
  ACTION_TIMEOUT_MS,
  DRAG_STEP_MS,
  DRAG_STEPS,
  INPUT_REPLAY_DELAY_MS,
  INPUT_RESYNC_MS,
  MAX_INPUT_BACKLOG_MS,
  MAX_INPUT_REPLAY_DELAY_MS,
  VIEWPORT,
} from "./limits"
import type { ParsedInputBatch, ParsedInputEvent } from "./input-protocol"
import { MODIFIER_BITS } from "./input-protocol"
import { bounded } from "./queue"
import type { Tab } from "./runtime"

/**
 * Replays the owner's input in a tab through the DevTools protocol, which
 * enters Chromium's own input pipeline: the page gets trusted events
 * (isTrusted), in the order and at the pace they were made. Each event is
 * dispatched at the time it happened on the owner's screen plus a fixed
 * delay, with that time as its timestamp, so a batch that took 40 ms to
 * make takes 40 ms to replay. Input that arrives late (a slow or uneven
 * link, as through pcp.gg or from a phone) moves the replay further
 * behind, up to MAX_INPUT_REPLAY_DELAY_MS, so what follows plays at its own
 * pace rather than in a burst, and the delay shrinks back slowly while
 * input arrives in time. A batch that arrives far too late starts a new
 * clock rather than racing to catch up.
 *
 * Events are sent in order without waiting for Chromium to acknowledge
 * each: it acknowledges a mouse move only with its next frame (about
 * 17 ms), and waiting on every one would replay at most sixty moves a
 * second while a mouse makes hundreds, so the replay would fall seconds
 * behind. Chromium folds the moves into its frames as it does a real
 * mouse's. Should it still fall behind (a move waiting unacknowledged for
 * MAX_INPUT_BACKLOG_MS), moves are dropped until it catches up; presses,
 * releases, the wheel and keys never are.
 */

type Clock = {
  /** The owner's time and PCP's time (epoch ms) that line up. */
  client: number
  server: number
  last: number
  /** How far behind the owner's time the replay runs now. */
  delay: number
  /** Moves sent and not yet acknowledged: when each was sent (epoch ms). */
  unacked: Map<number, number>
  sent: number
  chain: Promise<unknown>
}

const CLOCK = "input"

function clockOf(tab: Tab): Clock {
  let clock = tab.extra.get(CLOCK) as Clock | undefined

  if (!clock) {
    clock = {
      client: -1,
      server: 0,
      last: 0,
      delay: INPUT_REPLAY_DELAY_MS,
      unacked: new Map(),
      sent: 0,
      chain: Promise.resolve(),
    }
    tab.extra.set(CLOCK, clock)
  }

  return clock
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value))
}

function pressedButton(buttons: number): "left" | "right" | "middle" | "none" {
  if (buttons & 1) return "left"
  if (buttons & 2) return "right"
  if (buttons & 4) return "middle"
  return "none"
}

/** The text a key types, if it types one. */
function keyText(event: Extract<ParsedInputEvent, { key: string }>) {
  if (event.modifiers & (MODIFIER_BITS.ctrl | MODIFIER_BITS.meta)) {
    return undefined
  }

  if (event.key === "Enter") return "\r"
  if (event.key === "Tab") return undefined
  return [...event.key].length === 1 ? event.key : undefined
}

/**
 * One event of the owner's input, or of an assistant's mouse (clickAt,
 * wheelAt, dragBetween below), sent to the tab as DevTools input, its
 * point kept inside the viewport.
 */
async function dispatch(
  tab: Tab,
  event: ParsedInputEvent,
  timestamp: number,
): Promise<void> {
  const { cdp } = tab

  switch (event.type) {
    case "move":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: clamp(event.x, VIEWPORT.width),
        y: clamp(event.y, VIEWPORT.height),
        button: pressedButton(event.buttons),
        buttons: event.buttons,
        // A real mouse reports half pressure while a button is down; the
        // protocol's default is none, which a page reads as pressure 0.
        force: event.buttons ? 0.5 : 0,
        modifiers: event.modifiers,
        timestamp,
      })
      return
    case "down":
    case "up":
      await cdp.send("Input.dispatchMouseEvent", {
        type: event.type === "down" ? "mousePressed" : "mouseReleased",
        x: clamp(event.x, VIEWPORT.width),
        y: clamp(event.y, VIEWPORT.height),
        button: event.button,
        buttons: event.buttons,
        clickCount: event.clickCount,
        // As a press, not a release (which has none), as Playwright's own
        // mouse sends them.
        ...(event.type === "down" ? { force: 0.5 } : {}),
        modifiers: event.modifiers,
        timestamp,
      })
      return
    case "wheel":
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: clamp(event.x, VIEWPORT.width),
        y: clamp(event.y, VIEWPORT.height),
        deltaX: event.dx,
        deltaY: event.dy,
        modifiers: event.modifiers,
        timestamp,
      })
      return
    case "keydown": {
      const text = keyText(event)
      await cdp.send("Input.dispatchKeyEvent", {
        type: text ? "keyDown" : "rawKeyDown",
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.keyCode,
        nativeVirtualKeyCode: event.keyCode,
        modifiers: event.modifiers,
        autoRepeat: event.repeat,
        ...(text ? { text, unmodifiedText: text } : {}),
        timestamp,
      })
      return
    }
    case "keyup":
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: event.keyCode,
        nativeVirtualKeyCode: event.keyCode,
        modifiers: event.modifiers,
        timestamp,
      })
      return
    case "text":
      await cdp.send("Input.insertText", { text: event.text })
      return
  }
}

async function replay(tab: Tab, batch: ParsedInputBatch): Promise<void> {
  const clock = clockOf(tab)

  for (const event of batch.events) {
    const now = Date.now()
    let due = clock.server + (event.t - clock.client) + clock.delay

    // The first event, a jump back in the owner's time, or input that came
    // in long after it was made: start the clock again from here.
    if (
      clock.client < 0 ||
      event.t < clock.client ||
      now - due > INPUT_RESYNC_MS
    ) {
      clock.client = event.t
      clock.server = now
      clock.delay = INPUT_REPLAY_DELAY_MS
      due = now + clock.delay
    } else if (due < now) {
      // Late: run further behind, so this plays now and what follows
      // keeps its pace instead of coming out all at once.
      const delay = Math.min(MAX_INPUT_REPLAY_DELAY_MS, clock.delay + now - due)
      due += delay - clock.delay
      clock.delay = delay
    } else if (clock.delay > INPUT_REPLAY_DELAY_MS) {
      // In time: close up a millisecond per event, a pace nobody sees.
      clock.delay -= 1
      due -= 1
    }

    due = Math.max(due, clock.last)

    if (due > now) {
      await sleep(due - now)
    }

    clock.last = due

    if (event.type !== "move") {
      void dispatch(tab, event, due / 1000).catch(() => {})
      continue
    }

    // Map keeps the order moves were sent in: the first is the oldest.
    const oldest = clock.unacked.values().next().value

    if (oldest !== undefined && Date.now() - oldest > MAX_INPUT_BACKLOG_MS) {
      continue
    }

    const id = clock.sent++
    clock.unacked.set(id, Date.now())
    void dispatch(tab, event, due / 1000)
      .catch(() => {})
      .finally(() => clock.unacked.delete(id))
  }
}

/**
 * Queues a batch behind the ones before it, and waits until its last event
 * has been sent (not acknowledged).
 */
export function dispatchInput(
  tab: Tab,
  batch: ParsedInputBatch,
): Promise<void> {
  const clock = clockOf(tab)
  const run = () => replay(tab, batch)
  const result = clock.chain.then(run, run)
  clock.chain = result.catch(() => {})
  return result
}

/**
 * An assistant's mouse: click, scroll and drag at a point of the viewport
 * (CSS pixels), for what a page draws without elements to name (a canvas,
 * a map). The same DevTools events as the owner's input above, made one
 * after the other and each waited for, so the page has them all before
 * the call answers.
 */

export type MouseButton = "left" | "right" | "middle"
export type Point = { x: number; y: number }

const BUTTON_BITS: Record<MouseButton, number> = {
  left: 1,
  right: 2,
  middle: 4,
}

/** The point kept inside the viewport, as dispatch sends it. */
export function inViewport(point: Point): Point {
  return {
    x: clamp(point.x, VIEWPORT.width),
    y: clamp(point.y, VIEWPORT.height),
  }
}

async function send(tab: Tab, event: ParsedInputEvent): Promise<void> {
  await bounded(
    dispatch(tab, event, Date.now() / 1000),
    ACTION_TIMEOUT_MS,
    "Input.dispatchMouseEvent",
  )
}

function mouse(
  type: "move" | "down" | "up",
  { x, y }: Point,
  button: MouseButton,
  { held = false, clickCount = 1 }: { held?: boolean; clickCount?: number },
): ParsedInputEvent {
  const buttons = held ? BUTTON_BITS[button] : 0

  return type === "move"
    ? { type, t: 0, x, y, buttons, modifiers: 0 }
    : {
        type,
        t: 0,
        x,
        y,
        button,
        buttons,
        clickCount,
        modifiers: 0,
      }
}

/** A click (two for double) with a button at a point. */
export async function clickAt(
  tab: Tab,
  point: Point,
  {
    button = "left",
    double = false,
  }: { button?: MouseButton; double?: boolean } = {},
): Promise<Point> {
  const at = inViewport(point)
  await send(tab, mouse("move", at, button, {}))

  for (const clickCount of double ? [1, 2] : [1]) {
    await send(tab, mouse("down", at, button, { held: true, clickCount }))
    await send(tab, mouse("up", at, button, { clickCount }))
  }

  return at
}

/** The wheel turned at a point, by dx and dy CSS pixels. */
export async function wheelAt(
  tab: Tab,
  point: Point,
  delta: { dx: number; dy: number },
): Promise<Point> {
  const at = inViewport(point)
  await send(tab, mouse("move", at, "left", {}))
  await send(tab, { type: "wheel", t: 0, ...at, ...delta, modifiers: 0 })
  return at
}

/**
 * A drag: the button pressed at one point, moved in steps to the other
 * while held, and let go there.
 */
export async function dragBetween(
  tab: Tab,
  from: Point,
  to: Point,
  { button = "left" }: { button?: MouseButton } = {},
): Promise<{ from: Point; to: Point }> {
  const start = inViewport(from)
  const end = inViewport(to)
  await send(tab, mouse("move", start, button, {}))
  await send(tab, mouse("down", start, button, { held: true }))

  for (let step = 1; step <= DRAG_STEPS; step++) {
    const point = {
      x: start.x + ((end.x - start.x) * step) / DRAG_STEPS,
      y: start.y + ((end.y - start.y) * step) / DRAG_STEPS,
    }
    await send(tab, mouse("move", point, button, { held: true }))
    await sleep(DRAG_STEP_MS)
  }

  await send(tab, mouse("up", end, button, {}))
  return { from: start, to: end }
}
