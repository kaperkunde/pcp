import type { TabView } from "@/lib/core/browser/types"

/**
 * What the Browser page's tabs view says about a tab, kept apart from the
 * component so it can be tested: where it is, the letter that stands in
 * for an icon it has none of, and its state in a word.
 */

/** The tab's site, as a list shows it: the host, or the address itself. */
export function tabHost(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host || url
  } catch {
    return url
  }
}

/**
 * The letter in the tile of a tab without an icon: the site's first letter
 * or digit past a "www.", or a dot for a page without one (about:blank).
 */
export function tabInitial(url: string): string {
  let host = ""

  try {
    host = new URL(url).hostname
  } catch {
    // Not an address: no letter.
  }

  const letter = host.replace(/^www\./i, "").match(/[\p{L}\p{N}]/u)?.[0]

  return letter ? letter.toLocaleUpperCase() : "·"
}

/** Who has the tab, and whether something is working in it. */
export type TabState = "owner" | "busy" | "idle"

export function tabState(tab: Pick<TabView, "control" | "busy">): TabState {
  if (tab.control === "owner") return "owner"
  return tab.busy ? "busy" : "idle"
}

/** The state's word, for its badge. */
export const TAB_STATE_LABELS: Record<TabState, string> = {
  owner: "With you",
  busy: "In use",
  idle: "Idle",
}
