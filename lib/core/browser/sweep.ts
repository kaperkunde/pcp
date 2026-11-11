import { runLabel } from "../code/runs"
import type { TabControl } from "./types"
import { RUN_TAB_GRACE_MS, TAB_IDLE_TTL_MS } from "./limits"

/**
 * Which tabs are done with, so the browser's few tabs (MAX_TABS, shared by
 * every token) are not held by tabs nobody comes back to: one nobody used
 * for TAB_IDLE_TTL_MS, and one whose run (a run_code program's, or a
 * wrapper's) has ended and that nothing used for RUN_TAB_GRACE_MS since, or
 * at once when a tab is wanted and the browser is full. A tab belongs to
 * the run whose call used it last: a call outside any run takes it out of
 * runs, and it stays until it idles out. Looked at by the browser's calls
 * (call.ts), inside a request: no timer. Closing a tab needs no key; the
 * profile is saved by the call that closed them, which holds one.
 *
 * Never swept: a tab a call holds now, one being reopened, one the owner
 * holds (a hand-over included), the owner's own (no token's), and the tab
 * the sweeping call names. Kept apart from Chromium so it can be tested on
 * its own.
 */

/** A run a tab is used in, and when it ended (null while it runs). */
export type TabRun = {
  id: string
  label: string | null
  endedAt: number | null
}

/** What of a tab the sweep looks at. */
export type SweepTab = {
  id: string
  tokenId: string | null
  control: TabControl
  running: unknown
  reopening: unknown
  lastUsedAt: number
  run: TabRun | null
}

export type Swept = { id: string; why: "idle" | "run" }

/** The runs tabs are used in, one record per run (its signal's). */
const RUNS = new WeakMap<AbortSignal, TabRun>()

/**
 * The run a call is made in, as tabs keep it: its id, what it is of
 * (code/runs.ts runLabel) and when it ended, which its signal says (it
 * aborts once the run is over). Null for a call outside any run.
 */
export function callRun(
  runId: string | undefined,
  signal: AbortSignal | undefined,
  now = () => Date.now(),
): TabRun | null {
  if (!runId || !signal) {
    return null
  }

  let run = RUNS.get(signal)

  if (!run || run.id !== runId) {
    const made: TabRun = {
      id: runId,
      label: runLabel(runId),
      endedAt: signal.aborted ? now() : null,
    }
    signal.addEventListener(
      "abort",
      () => {
        made.endedAt ??= now()
      },
      { once: true },
    )
    RUNS.set(signal, made)
    run = made
  }

  return run
}

/** The tabs to close now, and why, oldest first. */
export function tabsToSweep(
  tabs: Iterable<SweepTab>,
  {
    now = Date.now(),
    keep = null,
    needRoom = false,
  }: { now?: number; keep?: string | null; needRoom?: boolean } = {},
): Swept[] {
  const swept: Swept[] = []

  for (const tab of tabs) {
    if (
      tab.id === keep ||
      tab.tokenId === null ||
      tab.control === "owner" ||
      tab.running ||
      tab.reopening
    ) {
      continue
    }

    const ended = tab.run?.endedAt ?? null

    if (
      ended !== null &&
      (needRoom || now - Math.max(ended, tab.lastUsedAt) >= RUN_TAB_GRACE_MS)
    ) {
      swept.push({ id: tab.id, why: "run" })
    } else if (now - tab.lastUsedAt >= TAB_IDLE_TTL_MS) {
      swept.push({ id: tab.id, why: "idle" })
    }
  }

  return swept
}

/** "run r_1 (wrapper shop/order)", as the list of tabs names a run. */
export function runName(run: Pick<TabRun, "id" | "label">): string {
  if (!run.label) {
    return `run ${run.id}`
  }

  return run.label === "run_code"
    ? `run ${run.id}`
    : `run ${run.id} (wrapper ${run.label})`
}

/** How long, in words: "40 seconds", "3 minutes", "2 hours". */
export function spanWords(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))

  if (seconds < 60) {
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`
  }

  const minutes = Math.round(seconds / 60)

  if (minutes < 120) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
  }

  const hours = Math.round(minutes / 60)
  return `${hours} hours`
}
