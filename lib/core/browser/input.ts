import {
  INPUT_REPLAY_DELAY_MS,
  INPUT_RESYNC_MS,
  MAX_INPUT_REPLAY_DELAY_MS,
  VIEWPORT,
} from "./limits"
import type { ParsedInputBatch, ParsedInputEvent } from "./input-protocol"
import { MODIFIER_BITS } from "./input-protocol"
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
 */

type Clock = {
  /** The owner's time and PCP's time (epoch ms) that line up. */
  client: number
  server: number
  last: number
  /** How far behind the owner's time the replay runs now. */
  delay: number
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
    await dispatch(tab, event, due / 1000)
  }
}

/** Queues a batch behind the ones before it, and waits for it to play. */
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
