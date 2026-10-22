import { MAX_ELEMENT_NAME_CHARS } from "./limits"

/**
 * Why an action on a page failed, in plain words. Playwright's message is
 * one line ("locator.click: Timeout 10000ms exceeded.") and then its call
 * log, where the reason is: an element that covers the target, one that is
 * not visible, not enabled, gone. The reason is taken from the log, and the
 * element it names described by its tag, role, label and id only: never
 * the page's text beyond that.
 */

const MAX_REASON_CHARS = 300
const MAX_LABEL_CHARS = 60

function attribute(html: string, name: string): string | null {
  const value = html.match(new RegExp(`\\s${name}="([^"]*)"`, "i"))?.[1]
  return value ? value.replace(/\s+/g, " ").trim() || null : null
}

function short(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * An element as the call log shows it ("<div class=… role="dialog">…"),
 * described: its role or tag, and the label or id it has.
 */
export function describeElement(html: string): string {
  const tag = html.match(/^<([a-zA-Z][\w-]*)/)?.[1]?.toLowerCase() ?? "element"
  const role = attribute(html, "role")
  const label =
    attribute(html, "aria-label") ??
    attribute(html, "title") ??
    attribute(html, "alt")
  const id = attribute(html, "id")
  const what = role
    ? `a ${short(role, 40)}${role === tag ? "" : ` (<${tag}>)`}`
    : `a <${tag}> element`

  return short(
    `${what}${label ? ` "${short(label, MAX_LABEL_CHARS)}"` : ""}${id ? ` with id "${short(id, 40)}"` : ""}`,
    MAX_ELEMENT_NAME_CHARS,
  )
}

type Rule = { test: RegExp; say: (match: RegExpMatchArray) => string }

/** What the call log says, last line first; the first rule that fits. */
const RULES: Rule[] = [
  {
    test: /(<[^>]+>)[^]*?(?:from (<[^>]+>)[^]*? subtree )?intercepts pointer events/,
    say: (match) =>
      `Another element covers it and would get the click: ${describeElement(match[2] ?? match[1]!)}. Close or move what covers it first (a dialog, a banner, a menu), or pass force: true to click anyway.`,
  },
  {
    test: /element is not visible/,
    say: () =>
      "The element is not visible: it is hidden, or has no size. Open what holds it (a menu, a tab), or take a new snapshot.",
  },
  {
    test: /element is not enabled|element is disabled/,
    say: () => "The element is disabled, so it takes nothing now.",
  },
  {
    test: /element is not editable|not an <input>, <textarea>|is not an <input>/i,
    say: () => "The element does not take text.",
  },
  {
    test: /not a <select> element/i,
    say: () => "The element is not a list to choose in.",
  },
  {
    test: /did not find some options/,
    say: () => "The list has no option with that value or label.",
  },
  {
    test: /element is not stable/,
    say: () => "The element kept moving (an animation), so it was not clicked.",
  },
  {
    test: /element (?:is not attached|was detached)/,
    say: () =>
      "The element left the page as it changed. Take a new snapshot and use its refs.",
  },
  {
    test: /element is outside of the viewport/,
    say: () => "The element is outside the page and could not be scrolled to.",
  },
]

/** A failure's reason, bounded, for an answer. */
export function failureReason(error: unknown): string {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).replace(/\u001b\[[0-9;]*m/g, "")
  const [first = "", ...rest] = message.split("\n")
  const logAt = rest.findIndex((line) => /^\s*Call log:/.test(line))
  const log = logAt >= 0 ? rest.slice(logAt + 1) : []

  for (const line of [...log].reverse()) {
    for (const rule of RULES) {
      const match = line.match(rule.test)
      if (match) return short(rule.say(match), MAX_REASON_CHARS)
    }
  }

  if (
    /Target page, context or browser has been closed|Target closed/.test(first)
  ) {
    return "The tab's page closed while this was being done."
  }

  const timeout = first.match(/Timeout (\d+)ms exceeded/)

  if (timeout) {
    const seconds = Math.round(Number(timeout[1]) / 1000)
    const found = log.some((line) => /locator resolved to/.test(line))

    return found
      ? `It did not finish within ${seconds} seconds.`
      : `The element was not on the page within ${seconds} seconds. Take a new snapshot and use its refs.`
  }

  for (const rule of RULES) {
    const match = first.match(rule.test)
    if (match) return short(rule.say(match), MAX_REASON_CHARS)
  }

  // Playwright's own words, without the method it was in.
  return short(first.replace(/^[\w.]+: /, ""), MAX_REASON_CHARS)
}
