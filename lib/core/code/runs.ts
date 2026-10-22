import { createHash, randomBytes } from "node:crypto"

import { MAX_REMEMBERED_RUNS, REMEMBERED_RUN_MS } from "./limits"

/**
 * Runs as PCP remembers them: each program's run (run_code's, and a wrapper
 * tool's) has an id and a trace of the calls it made, by server and tool,
 * with how each went and whether its server marks it read-only. The trace
 * holds no arguments and no results, so an answer that names it says what
 * may have taken effect without repeating anything a call carried.
 *
 * run_code's runs are also remembered here, in memory, for check_run and
 * for the duplicate guard: a run that outlives its call (it answers after
 * RUN_ANSWER_MS, or its client went away) keeps its outcome as a result of
 * the token's own (lib/core/tool-results.ts, encrypted, gone after a day),
 * and this map holds only that result's id. A restart forgets every run;
 * check_run then says the id is unknown.
 */

/** How one call of a run went; "running" while it is under way. */
export type CallOutcome = "ok" | "error" | "asked" | "refused" | "running"

export type TraceEntry = {
  server: string
  tool: string
  outcome: CallOutcome
  startedAt: number
  /** How long it took, once it ended. */
  ms: number | null
  /**
   * Whether its server marks it read-only (as call_read_only_tool decides);
   * null until the call was looked up, and for one that was refused.
   */
  readOnly: boolean | null
  /** It failed on the way (not reached, timed out): it may have gone through. */
  transit: boolean
  /** The step it was made in (pcp.step), when the program named one. */
  step?: string
  /**
   * The run a call to a wrapper's tool started (run.ts withWrappers), whose
   * answer names this run back: a flow called from run_code.
   */
  runId?: string
}

export type RunState = "running" | "finished" | "failed" | "stopped"

/** Why a run ended other than by finishing. */
export type ExitReason =
  "error" | "time" | "cpu" | "calls" | "memory" | "gone" | "owner" | "internal"

const REASONS: Record<ExitReason, string> = {
  error: "uncaught error",
  time: "wall-clock limit",
  cpu: "CPU limit",
  calls: "call limit",
  memory: "memory limit",
  gone: "client went away",
  owner: "stopped for the owner's answer",
  internal: "PCP failed while running it",
}

export function reasonLabel(reason: ExitReason): string {
  return REASONS[reason]
}

const STATES: Record<RunState, string> = {
  running: "still running",
  finished: "finished",
  failed: "failed",
  stopped: "stopped",
}

export function stateLabel(state: RunState): string {
  return STATES[state]
}

/** Said whenever a call that changes things completed, or may have. */
export const MAY_HAVE_TAKEN_EFFECT =
  "Some of this run may have taken effect: check the completed calls (and the site or account they act on) before running it again."

/** Said of a call that changes things and failed on its way. */
export const MAY_HAVE_GONE_THROUGH =
  "The call may have gone through before it failed: check before trying it again."

/** A short, opaque id, `run_` and random hex. */
export function newRunId(): string {
  return `run_${randomBytes(8).toString("hex")}`
}

/** What tells one program from another for the duplicate guard. */
export function programKey(language: string, code: string): string {
  return createHash("sha256").update(`${language}\n${code}`).digest("hex")
}

/** A call of the trace, as a line of an answer. */
export function callLine(entry: TraceEntry, now = Date.now()): string {
  const name = `${entry.server}/${entry.tool}`
  const how =
    entry.outcome === "running"
      ? `under way (${seconds(now - entry.startedAt)} so far)`
      : entry.outcome === "asked"
        ? "asked the owner, did not run"
        : entry.outcome === "refused"
          ? "refused, did not run"
          : entry.outcome === "error" && entry.transit
            ? "error, may have gone through"
            : entry.outcome

  const where = [
    ...(entry.step ? [`step '${entry.step}'`] : []),
    ...(entry.runId ? [`run ${entry.runId}`] : []),
  ]

  return `- ${name}${where.length > 0 ? ` (${where.join(", ")})` : ""}: ${how}${entry.ms !== null ? `, ${seconds(entry.ms)}` : ""}${entry.readOnly === true ? " (read-only)" : ""}`
}

/**
 * The calls that may have changed something: not marked read-only, and
 * completed (well or not) or still under way.
 */
export function sideEffects(trace: TraceEntry[]): TraceEntry[] {
  return trace.filter(
    (entry) =>
      entry.readOnly !== true &&
      (entry.outcome === "ok" ||
        entry.outcome === "error" ||
        entry.outcome === "running"),
  )
}

/**
 * The part of an answer that says what of a run may have taken effect:
 * the calls that change things and completed, and the warning when any
 * did or may have.
 */
export function effectLines(trace: TraceEntry[], now = Date.now()): string[] {
  const effects = sideEffects(trace)

  if (effects.length === 0) {
    return ["No call that changes things completed."]
  }

  return [
    `Calls that change things and completed:\n${effects.map((entry) => callLine(entry, now)).join("\n")}`,
    MAY_HAVE_TAKEN_EFFECT,
  ]
}

/** Every call of the trace, for a run still going or check_run. */
export function traceLines(trace: TraceEntry[], now = Date.now()): string {
  return trace.length === 0
    ? "No calls yet."
    : trace.map((entry) => callLine(entry, now)).join("\n")
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

/** A run_code run, remembered for check_run and the duplicate guard. */
export type RunRecord = {
  id: string
  vaultId: string
  tokenId: string
  /** programKey of what it runs. */
  key: string
  startedAt: number
  trace: TraceEntry[]
  state: RunState
  reason: ExitReason | null
  endedAt: number | null
  /** Its outcome went back in run_code's own answer. */
  answered: boolean
  /** The kept result that holds its outcome, once a run that went on ended. */
  outcomeId: string | null
  /** Settles once it ended and its outcome, if it is kept, was. */
  settled: Promise<void>
  settle: () => void
}

type Registry = Map<string, RunRecord>

const REGISTRY = Symbol.for("pcp.code.runs")

/** One per process, on globalThis, as the sandbox's state. */
function registry(): Registry {
  const holder = globalThis as unknown as { [REGISTRY]?: Registry }
  holder[REGISTRY] ??= new Map()
  return holder[REGISTRY]
}

/** Starts remembering a run of the token's. */
export function rememberRun(input: {
  id: string
  vaultId: string
  tokenId: string
  key: string
  trace: TraceEntry[]
  startedAt: number
}): RunRecord {
  let settle = () => {}
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  const record: RunRecord = {
    ...input,
    state: "running",
    reason: null,
    endedAt: null,
    answered: false,
    outcomeId: null,
    settled,
    settle,
  }

  forgetOld()
  registry().set(record.id, record)

  return record
}

/** Drops runs past REMEMBERED_RUN_MS, and the oldest ended past the cap. */
function forgetOld(now = Date.now()): void {
  const runs = registry()

  for (const [id, run] of runs) {
    if (run.endedAt !== null && now - run.endedAt > REMEMBERED_RUN_MS) {
      runs.delete(id)
    }
  }

  // A Map iterates in insertion order: the oldest first.
  for (const [id, run] of runs) {
    if (runs.size < MAX_REMEMBERED_RUNS) {
      break
    }

    if (run.endedAt !== null) {
      runs.delete(id)
    }
  }
}

/** The token's run by its id; another token's, or one forgotten, is null. */
export function findRun(
  vaultId: string,
  tokenId: string,
  id: string,
): RunRecord | null {
  const run = registry().get(id)

  return run && run.vaultId === vaultId && run.tokenId === tokenId ? run : null
}

/**
 * The token's run of the same program that is still going, or that ended
 * within `withinMs` other than by stopping for the owner (whose answer says
 * to run it again once they have answered); null for none.
 */
export function duplicateRun(
  vaultId: string,
  tokenId: string,
  key: string,
  withinMs: number,
  now = Date.now(),
): RunRecord | null {
  let found: RunRecord | null = null

  for (const run of registry().values()) {
    if (run.vaultId !== vaultId || run.tokenId !== tokenId || run.key !== key) {
      continue
    }

    if (
      run.state === "running" ||
      (run.state !== "stopped" &&
        run.endedAt !== null &&
        now - run.endedAt <= withinMs)
    ) {
      found = run
    }
  }

  return found
}

/** Forgets every run; for tests. */
export function forgetRuns(): void {
  registry().clear()
}
