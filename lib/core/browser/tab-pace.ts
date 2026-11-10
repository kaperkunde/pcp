import {
  PACE_KEY_OF,
  type BrowserPace,
  type BrowserPacingClass,
  type PaceRange,
} from "../pacing/limits"

import type { Tab } from "./runtime"

/**
 * A tab's own pace (lib/core/pacing/): what an assistant set for it with
 * tabs' action pace, within the owner's bounds or as the owner allowed it
 * on a tab_pace request. It lives with the tab, in this process's memory:
 * never stored, never in an export, and gone when the tab closes (a
 * WeakMap keyed by the tab), so it never outlasts what it was set for.
 */

const STORE = Symbol.for("pcp.browser.tabPace")

/** One per process, on globalThis as the browser's runtime is. */
function paces(): WeakMap<Tab, BrowserPace> {
  const holder = globalThis as unknown as {
    [STORE]?: WeakMap<Tab, BrowserPace>
  }
  holder[STORE] ??= new WeakMap()
  return holder[STORE]
}

/** The tab's own pace, or null when it follows the owner's. */
export function tabPace(tab: Tab): BrowserPace | null {
  return paces().get(tab) ?? null
}

/** The tab's own pace for one class, if it has one. */
export function tabPaceFor(
  tab: Tab,
  pacingClass: BrowserPacingClass,
): PaceRange | null {
  return tabPace(tab)?.[PACE_KEY_OF[pacingClass]] ?? null
}

/** Sets the tab's own pace; empty (or null) puts it back on the owner's. */
export function setTabPace(tab: Tab, pace: BrowserPace | null): void {
  if (!pace || (!pace.actions && !pace.navigations)) {
    paces().delete(tab)
    return
  }

  paces().set(tab, {
    ...(pace.actions ? { actions: { ...pace.actions } } : {}),
    ...(pace.navigations ? { navigations: { ...pace.navigations } } : {}),
  })
}
