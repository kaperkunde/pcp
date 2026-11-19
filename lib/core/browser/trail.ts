import { MAX_TRAIL_ENTRIES } from "./limits"

/**
 * What happened to a tab's page, for a field report: its navigations,
 * reloads and the times its refs started afresh, with the time. Kept in
 * memory with the tab (never on disk, never in the request log), the latest
 * MAX_TRAIL_ENTRIES, and nothing of an address but its host: no path, no
 * query, no value. An error about an element a call could not find tells
 * the last few (trailLines), so a report shows what the page did.
 */

export type TrailKind = "navigated" | "reopened" | "refs reset" | "asked owner"

type Entry = { at: number; kind: TrailKind; site: string }

export type TrailHolder = object

const KEY = Symbol.for("pcp.browser.trail")

/** On globalThis: the browser is called from bundles that are built apart. */
function trails(): WeakMap<TrailHolder, Entry[]> {
  const holder = globalThis as unknown as {
    [KEY]?: WeakMap<TrailHolder, Entry[]>
  }

  return (holder[KEY] ??= new WeakMap())
}

function siteOf(address: string): string {
  try {
    return new URL(address).host || "no site"
  } catch {
    return "no site"
  }
}

export function noteTrail(
  tab: TrailHolder,
  kind: TrailKind,
  address: string,
  at: number = Date.now(),
): void {
  const all = trails()
  const list = all.get(tab) ?? []
  list.push({ at, kind, site: siteOf(address) })

  if (list.length > MAX_TRAIL_ENTRIES) {
    list.splice(0, list.length - MAX_TRAIL_ENTRIES)
  }

  all.set(tab, list)
}

/** The tab's trail, oldest first, a line each: "12:01:02Z navigated host (3s ago)". */
export function trailLines(
  tab: TrailHolder,
  now: number = Date.now(),
  last: number = MAX_TRAIL_ENTRIES,
): string[] {
  return (trails().get(tab) ?? []).slice(-last).map((entry) => {
    const time = new Date(entry.at).toISOString().slice(11, 19)
    const ago = Math.max(0, Math.round((now - entry.at) / 1000))
    return `${time}Z ${entry.kind} ${entry.site} (${ago}s ago)`
  })
}
