/**
 * What run_code's executors share. An executor runs the program and owns
 * nothing else: every request the program makes goes to the bridge
 * (lib/core/code/run.ts) as an operation name and a JSON payload, both
 * untrusted, and the bridge alone decides what happens.
 */

/** The operations a program can ask the bridge for. */
export type BridgeOp = "call" | "read" | "keep" | "tools"

/**
 * The bridge's answer to one request. `ok: false` is an error the program
 * sees and may catch; `stop` ends the run where it is (the owner has to act
 * first), and the executor runs nothing of the program after it.
 */
export type BridgeReply =
  { ok: true; value: unknown } | { ok: false; error: string } | { stop: true }

export type Bridge = (op: string, payload: unknown) => Promise<BridgeReply>

/** How a run ended, as the executor saw it. */
export type RunEnd =
  /** The program finished; `returned` is its value as JSON, null for none. */
  | { kind: "done"; returned: string | null }
  /** It threw, or a limit stopped it; the message says which. */
  | { kind: "error"; message: string }
  /** The bridge stopped it: the owner has to act first. */
  | { kind: "stopped" }

export type RunResult = RunEnd & {
  /** What it printed, in order. */
  output: string
  /** Characters printed past the limit, not kept. */
  dropped: number
}

export type Executor = (input: {
  code: string
  bridge: Bridge
  /** Aborted when the run is out of time or the request went away. */
  signal: AbortSignal
}) => Promise<RunResult>
