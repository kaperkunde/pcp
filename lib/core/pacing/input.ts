import { z } from "zod"

import { invalid } from "../errors"
import {
  BROWSER_PACING_CLASSES,
  MAX_ASSISTANT_PACE_MS,
  PACE_KEY_OF,
  browserPacingClass,
  MAX_WRAPPER_PACE_TOOLS,
  type BrowserPace,
  type BrowserPacingClass,
  type PaceRange,
  type WrapperPace,
} from "./limits"

/**
 * A pace an assistant gives (lib/core/pacing/): a tab's (browser tabs,
 * action pace), a wrapper's (its definition's `pace`), or a call's within
 * its wrapper's (pcp.call's `pace` option), as the tools take it and as
 * they are checked. Pure: nothing here reads the vault.
 */

/** Whether a range sits inside bounds, both ends. */
export function paceWithin(range: PaceRange, bounds: PaceRange): boolean {
  return range.minMs >= bounds.minMs && range.maxMs <= bounds.maxMs
}

/**
 * A range as an assistant or the owner gave it (min_ms, max_ms), checked:
 * whole milliseconds, the low end first, and no longer than any pace PCP
 * serves. `what` names it in the refusal.
 */
export function checkPaceRange(
  range: { minMs: number; maxMs: number },
  what: string,
): PaceRange {
  const { minMs, maxMs } = range

  for (const ms of [minMs, maxMs]) {
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_ASSISTANT_PACE_MS) {
      throw invalid(
        `Keep ${what} between 0 and ${MAX_ASSISTANT_PACE_MS.toLocaleString("en")} milliseconds.`,
      )
    }
  }

  if (minMs > maxMs) {
    throw invalid(
      `${upper(what)}: the shortest wait comes first, then the longest.`,
    )
  }

  return { minMs, maxMs }
}

function upper(line: string): string {
  return line.charAt(0).toUpperCase() + line.slice(1)
}

/** A range in words: "0.15 to 0.6 s". */
export function describeRange(range: PaceRange): string {
  return range.minMs === range.maxMs
    ? `${range.minMs / 1000} s`
    : `${range.minMs / 1000} to ${range.maxMs / 1000} s`
}

/**
 * A range as a tool takes it (tabs' pace, a wrapper's pace, pcp.call's
 * pace option): min_ms and max_ms in whole milliseconds. That the low end
 * comes first is checked by checkPaceRange (JSON Schema cannot say it).
 */
export const paceRangeInput = z
  .strictObject({
    min_ms: z
      .number()
      .int()
      .min(0)
      .max(MAX_ASSISTANT_PACE_MS)
      .describe(
        "The shortest wait after the previous action at the site ended, in milliseconds.",
      ),
    max_ms: z
      .number()
      .int()
      .min(0)
      .max(MAX_ASSISTANT_PACE_MS)
      .describe(
        "The longest wait, in milliseconds, no less than min_ms: each wait is picked at random between the two.",
      ),
  })
  .describe("A wait between two lengths, picked at random each time.")

/** paceRangeInput's shape. */
export type PaceRangeInput = { min_ms: number; max_ms: number }

/** A pace per kind of browser action, as a tool takes it. */
export const browserPaceInput = z.strictObject({
  actions: paceRangeInput
    .optional()
    .describe(
      "Before each action in a page (click, type, press_key, select_option, scroll and the like).",
    ),
  navigations: paceRangeInput
    .optional()
    .describe(
      "Before a page is opened (navigate, back, download by its address), once the page the tab shows has settled.",
    ),
})

/** browserPaceInput's shape. */
export type BrowserPaceInput = {
  actions?: PaceRangeInput
  navigations?: PaceRangeInput
}

/** A range as a tool gave it, checked. */
export function fromRangeInput(input: PaceRangeInput, what: string): PaceRange {
  return checkPaceRange({ minMs: input.min_ms, maxMs: input.max_ms }, what)
}

/** A range as a tool answers with it. */
export function toRangeInput(range: PaceRange): PaceRangeInput {
  return { min_ms: range.minMs, max_ms: range.maxMs }
}

/** A pace as a tool gave it, each range checked. */
export function fromPaceInput(input: BrowserPaceInput): BrowserPace {
  return {
    ...(input.actions
      ? { actions: fromRangeInput(input.actions, "the pace for actions") }
      : {}),
    ...(input.navigations
      ? {
          navigations: fromRangeInput(
            input.navigations,
            "the pace for opening a page",
          ),
        }
      : {}),
  }
}

/**
 * The classes of a pace that sit outside the owner's bounds: what an
 * assistant may not set without asking.
 */
export function outsideBounds(
  pace: BrowserPace,
  bounds: Record<BrowserPacingClass, PaceRange>,
): BrowserPacingClass[] {
  return BROWSER_PACING_CLASSES.filter((pacingClass) => {
    const range = pace[PACE_KEY_OF[pacingClass]]
    return range !== undefined && !paceWithin(range, bounds[pacingClass])
  })
}

/** The owner's words for a class of browser action. */
export const BROWSER_CLASS_WORDS: Record<BrowserPacingClass, string> = {
  browser_act: "actions in a page",
  browser_navigate: "opening a page",
}

/**
 * A wrapper's pace as create_wrapper and update_wrapper take it: per kind
 * of action, and per browser tool its programs call.
 */
export const wrapperPaceInput = browserPaceInput
  .extend({
    tools: z
      .array(
        z.strictObject({
          tool: z
            .string()
            .min(1)
            .max(40)
            .describe(
              "A browser tool, by its name alone: click, type, navigate…",
            ),
          min_ms: paceRangeInput.shape.min_ms,
          max_ms: paceRangeInput.shape.max_ms,
        }),
      )
      .max(MAX_WRAPPER_PACE_TOOLS)
      .optional()
      .describe(
        "Before a call of one browser tool, in place of its kind's: a quicker type into a code's boxes, a slower click on a busy page.",
      ),
  })
  .describe(
    "The pace of the browser calls its tools make, in place of the owner's: a random wait between min_ms and max_ms after the previous action at the site ended. A program picks within it per call with pcp.call(…, { pace: { min_ms, max_ms } }). Within what the owner lets assistants set, or else their request says so; a site they paced themselves never goes faster than they set, and a tab given a pace of its own keeps it.",
  )

/** wrapperPaceInput's shape. */
export type WrapperPaceInput = BrowserPaceInput & {
  tools?: Array<{ tool: string; min_ms: number; max_ms: number }>
}

/**
 * A wrapper's pace as a tool or the owner's form gave it, checked: each
 * tool one the browser has (`isBrowserTool`, browser/tools.ts) and paces.
 */
export function fromWrapperPaceInput(
  input: WrapperPaceInput,
  isBrowserTool: (name: string) => boolean,
): WrapperPace {
  const pace: WrapperPace = fromPaceInput(input)
  const tools: Record<string, PaceRange> = {}

  for (const entry of input.tools ?? []) {
    if (!isBrowserTool(entry.tool)) {
      throw invalid(
        `${entry.tool} is not a browser tool: name one such as click, type or navigate.`,
      )
    }

    if (browserPacingClass(entry.tool, { action: "open" }) === null) {
      throw invalid(
        `${entry.tool} is not a browser tool that is paced: name one such as click, type or navigate (snapshot and the other reading tools never wait).`,
      )
    }

    if (tools[entry.tool]) {
      throw invalid(`The pace names ${entry.tool} twice.`)
    }

    tools[entry.tool] = checkPaceRange(
      { minMs: entry.min_ms, maxMs: entry.max_ms },
      `the pace for ${entry.tool}`,
    )
  }

  return Object.keys(tools).length > 0 ? { ...pace, tools } : pace
}

/** A wrapper's pace as the tools answer with it (get_wrapper). */
export function toWrapperPaceInput(pace: WrapperPace): WrapperPaceInput {
  return {
    ...(pace.actions ? { actions: toRangeInput(pace.actions) } : {}),
    ...(pace.navigations
      ? { navigations: toRangeInput(pace.navigations) }
      : {}),
    ...(pace.tools
      ? {
          tools: Object.entries(pace.tools).map(([tool, range]) => ({
            tool,
            ...toRangeInput(range),
          })),
        }
      : {}),
  }
}

/** Whether a wrapper's pace says nothing. */
export function emptyPace(pace: WrapperPace | null | undefined): boolean {
  return (
    !pace ||
    (!pace.actions &&
      !pace.navigations &&
      Object.keys(pace.tools ?? {}).length === 0)
  )
}

/**
 * Each range of a wrapper's pace outside the owner's bounds, in words: a
 * tool's by the class it is paced as (navigate, back and tabs open
 * navigate; the rest act).
 */
export function wrapperPaceOutside(
  pace: WrapperPace,
  bounds: Record<BrowserPacingClass, PaceRange>,
): string[] {
  const out: string[] = []

  for (const pacingClass of BROWSER_PACING_CLASSES) {
    const range = pace[PACE_KEY_OF[pacingClass]]

    if (range && !paceWithin(range, bounds[pacingClass])) {
      out.push(
        `before ${BROWSER_CLASS_WORDS[pacingClass]} ${describeRange(range)} (assistants may set ${describeRange(bounds[pacingClass])})`,
      )
    }
  }

  for (const [tool, range] of Object.entries(pace.tools ?? {})) {
    // A download is an action when a click starts it and opens a page when
    // it is by its address: its pace stays within the bounds of both.
    const classes: BrowserPacingClass[] =
      tool === "download"
        ? ["browser_act", "browser_navigate"]
        : [browserPacingClass(tool, { action: "open" }) ?? "browser_act"]
    const over = classes.find(
      (pacingClass) => !paceWithin(range, bounds[pacingClass]),
    )

    if (over) {
      out.push(
        `before ${tool} ${describeRange(range)} (assistants may set ${describeRange(bounds[over])} for ${BROWSER_CLASS_WORDS[over]})`,
      )
    }
  }

  return out
}

/** A wrapper's pace in words, one part per range. */
export function wrapperPaceWords(pace: WrapperPace): string[] {
  return [
    ...BROWSER_PACING_CLASSES.flatMap((pacingClass) => {
      const range = pace[PACE_KEY_OF[pacingClass]]
      return range
        ? [`before ${BROWSER_CLASS_WORDS[pacingClass]} ${describeRange(range)}`]
        : []
    }),
    ...Object.entries(pace.tools ?? {}).map(
      ([tool, range]) => `before ${tool} ${describeRange(range)}`,
    ),
  ]
}
