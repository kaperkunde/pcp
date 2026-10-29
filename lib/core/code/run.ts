import type { CallToolResult } from "@modelcontextprotocol/server"

import { readFields, type AnswerShape } from "../answers"
import { isConnectResult } from "../connect"
import { isPcpError } from "../errors"
import { bareType, isTextType } from "../media-types"
import type { CodeCallOutcome, PermissionScope } from "../permissions"
import {
  appendRequestLog,
  noteOwnerAsked,
  withLogNote,
  type LogNote,
} from "../request-log"
import { MAX_HANDLE_DEPTH, missingResultMessage } from "../result-handles"
import {
  handleOf,
  keepBytes,
  keepResult,
  openResult,
  resultNotice,
} from "../tool-results"
import { loadResourceLimits, type ResourceLimits } from "../resources/state"
import {
  DUPLICATE_RUN_MS,
  MAX_CALLS_PER_RUN,
  MAX_CODE_CHARS,
  MAX_KEEPS_PER_RUN,
  MAX_MEDIA_PER_RUN,
  MAX_PARALLEL_CALLS,
  MAX_READS_PER_RUN,
  MAX_STEP_NAME_CHARS,
  RUN_ANSWER_MS,
  RUN_PROGRESS_MS,
  RUN_TIMEOUT_MS,
} from "./limits"
import {
  compressImage,
  framesProgram,
  mediaKind,
  readFrameOptions,
  readImageOptions,
  type FrameOptions,
} from "./media"
import { Output } from "./output"
import { runJavaScript } from "./quickjs"
import {
  duplicateRun,
  effectLines,
  findRun,
  MAY_HAVE_TAKEN_EFFECT,
  newRunId,
  programKey,
  reasonLabel,
  rememberRun,
  seconds,
  sideEffects,
  stateLabel,
  traceLines,
  type ExitReason,
  type RunRecord,
  type RunState,
  type TraceEntry,
} from "./runs"
import { sandboxExecutor, sandboxLanguages, sandboxRuns } from "./sandbox"
import type { Bridge, BridgeReply, Executor, RunResult } from "./types"

/**
 * run_code: an assistant's program that calls the owner's tools and works on
 * their answers, so a large answer is filtered or moved without passing
 * through the assistant. The program runs in an executor (quickjs.ts) that
 * reaches nothing but the bridge here, and the bridge reaches nothing but
 * what the token itself may do:
 *
 * - `call` goes to the gateway's caller, which looks the tool up among the
 *   token's own, at the token's level: blocked is an error, "ask" stops the
 *   run with the owner's permission link (the request is the same one a
 *   call_tool would leave), and an allowed tool runs through the same
 *   upstream path as call_tool (permissions.ts runCodeCall). Every call is
 *   in the request log, under run_code, by server and tool.
 * - `read` opens one of the token's own kept results, as text, or as
 *   base64 for a file's bytes.
 * - `keep` keeps a text, or bytes sent as base64, as a result of the
 *   token's, and hands back its handle, which any later call (the
 *   program's or the assistant's) can name in place of the value.
 * - `tools` lists what the gateway's list_tools would: the token's servers,
 *   or one server's tools it can see, at its levels. It reaches no server.
 * - `media` makes a smaller copy of one of the token's kept images
 *   (pcp.image.compress: crop, fit, grey, re-encode), decoded here in PCP's
 *   process (media.ts) and never in the program's engine, or takes frames
 *   from one of its kept videos (pcp.video.frames), which ffmpeg does in the
 *   sandbox: PCP runs sandbox/pcp.py's `frames` there with a bridge that
 *   only reads that video and keeps JPEGs. Either is a new result of the
 *   token's, counted as a keep (each frame one), and neither is logged, as
 *   keeps are not.
 *
 * `pcp.step(name, fn)` is no operation of its own: the program's runtime
 * (quickjs.ts) runs fn, sends the step's name with each call made in it for
 * the trace, and rethrows an error from it as "failed at step '…'".
 *
 * Files move as handles: a file in an answer is kept and the program gets
 * its handle, and passes the handle on; it reads the bytes only when it
 * asks to (`read` as base64).
 *
 * Nothing here reads a secret or opens a connection, and the program's text
 * is not logged or kept.
 *
 * Every run has an id (`run_…`) and a trace of its calls (runs.ts: server,
 * tool, how it went, whether it only reads; never arguments or results), and
 * every answer but a plain success says the id, why the run ended, and the
 * calls that change things that completed. run_code answers at most
 * RUN_ANSWER_MS after it started, under the minute after which clients give
 * up: a program not done by then, or whose client went away, goes on within
 * RUN_TIMEOUT_MS, and its outcome is kept as a result of the token's for
 * check_run. The same program sent again while it runs, or soon after it
 * ended, is answered with that run unless the assistant asks for a rerun.
 */

/**
 * The run a program's call is made for. `onRun` is told the id of the run
 * a wrapper's tool starts for it (wrappers/run.ts), for the trace.
 * `deadline` is when the run's own limit ends it (epoch milliseconds): a
 * call waits for its turn under pacing until shortly before it
 * (lib/core/pacing/), rather than be refused with work half done.
 */
export type CallRun = {
  runId: string
  signal: AbortSignal
  deadline: number
  onRun?: (runId: string) => void
}

/** How the gateway runs a program's call: by name, at the token's level. */
export type CodeCaller = (
  input: {
    server: string
    tool: string
    args: Record<string, unknown>
    /**
     * The run the call is made for: its id, and a signal that aborts only
     * when the run itself is over (never when the client leaves), for the
     * upstream call (upstream.ts callServerTool's runId and signal), and
     * where a call to a wrapper's tool says the run it started.
     */
    run: CallRun
    /** Says, once the tool is found, whether its server marks it read-only. */
    lookedUp?: (readOnly: boolean) => void
  } & AnswerShape,
) => Promise<CodeCallOutcome>

/**
 * How the gateway lists for a program: with no server, the token's servers;
 * with one, the tools on it the token can see. Nothing is fetched.
 */
export type CodeLister = (
  server: string | null,
) => { ok: true; value: unknown } | { ok: false; error: string }

/** What run_code shows of each part before keeping the rest. */
const SHOWN_OUTPUT_CHARS = 20_000
const SHOWN_RETURN_CHARS = 30_000

function text(value: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: value }],
    ...(isError ? { isError: true } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

const HANDLE_KEYS = new Set([
  "$result",
  "type",
  "length",
  "size",
  "name",
  "preview",
  "readableUntil",
])

/**
 * A handle as PCP wrote it into an answer ({"$result", "type", "size", …,
 * "readableUntil"}) made the bare {"$result"} that stands for its value in a
 * call, so a program can pass on what it was handed as it is.
 */
export function bareHandles(value: unknown, depth = 0): unknown {
  if (depth > MAX_HANDLE_DEPTH) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => bareHandles(item, depth + 1))
  }

  if (!isRecord(value)) {
    return value
  }

  if (
    typeof value.$result === "string" &&
    typeof value.readableUntil === "string" &&
    Object.keys(value).every((key) => HANDLE_KEYS.has(key))
  ) {
    return { $result: value.$result }
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      bareHandles(item, depth + 1),
    ]),
  )
}

const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function refuse(error: string): BridgeReply {
  return { ok: false, error }
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** What runCode is told besides what runs the program. */
export type RunCodeOptions = RunOptions & {
  /**
   * The request's own: when it aborts, the client went away. The run goes
   * on (its outcome is kept for check_run); only the answer comes early.
   */
  signal?: AbortSignal
  /** How long the call is held before it answers "still running". */
  answerMs?: number
  /** How often `progress` is told while the call is held. */
  progressMs?: number
  /** Told now and then while the call is held: progress notifications. */
  progress?: (progress: RunProgress) => void
}

export type RunProgress = { runId: string; elapsedMs: number; calls: number }

/**
 * Runs one program for the token. The answer says what it printed and
 * returned, or why it failed or stopped; a long part is kept as a result
 * of the token's and shown cut, with a notice naming it. A program not done
 * within `answerMs`, or whose client went away, goes on, and the answer says
 * it is still running; its outcome is kept for check_run when it ends.
 */
export async function runCode(
  scope: PermissionScope,
  input: {
    code: string
    /** A shell program has no value to return, only output and a status. */
    returns?: boolean
    /** The language it is in, to tell one program from another. */
    language?: string
    /** Run it even when the same program runs, or ran a moment ago. */
    rerun?: boolean
  },
  {
    signal,
    answerMs = RUN_ANSWER_MS,
    progressMs = RUN_PROGRESS_MS,
    progress,
    ...options
  }: RunCodeOptions,
): Promise<CallToolResult> {
  if (typeof input.code !== "string" || input.code.trim() === "") {
    return text("Send the program in code.", true)
  }

  if (input.code.length > MAX_CODE_CHARS) {
    return text(
      `The program is ${input.code.length.toLocaleString("en")} characters; run_code takes ${MAX_CODE_CHARS.toLocaleString("en")} at most.`,
      true,
    )
  }

  const key = programKey(input.language ?? "javascript", input.code)

  if (input.rerun !== true) {
    const earlier = duplicateRun(
      scope.ctx.vaultId,
      scope.tokenId,
      key,
      DUPLICATE_RUN_MS,
    )

    if (earlier) {
      return duplicateAnswer(earlier)
    }
  }

  const limits = await loadResourceLimits()
  const record = rememberRun({
    id: newRunId(),
    vaultId: scope.ctx.vaultId,
    tokenId: scope.tokenId,
    key,
    trace: [],
    startedAt: Date.now(),
  })

  // The client's signal is not the run's: the run ends by its own limits.
  const outcome = runProgram(
    scope,
    { code: input.code },
    { ...options, runId: record.id, trace: record.trace },
  )
    .then(
      async (run): Promise<{ answer: CallToolResult } | { busy: string }> => {
        if ("busy" in run) {
          return run
        }

        const answer = await answerFor(scope, run, input, limits)
        record.state = run.state
        record.reason = run.reason
        record.endedAt = Date.now()

        return { answer }
      },
    )
    .catch((error: unknown) => {
      // PCP failed around the run (its answer could not be put together):
      // the run is over all the same, and what it did is still said.
      console.error("[run_code] a run failed inside PCP", {
        error: error instanceof Error ? error.message : "unknown",
      })
      record.state = "failed"
      record.reason = "internal"
      record.endedAt = Date.now()

      return {
        answer: text(
          [
            `Run ${record.id}: failed. Exit reason: ${reasonLabel("internal")}.`,
            "Something went wrong inside PCP.",
            ...effectLines(record.trace),
          ].join("\n\n"),
          true,
        ),
      }
    })

  const first = await held(record, outcome, {
    ms: answerMs,
    signal,
    progressMs,
    progress,
  })

  if (first) {
    if ("busy" in first.value) {
      dropRun(record)
      return text(first.value.busy, true)
    }

    record.answered = true
    record.settle()
    return first.value.answer
  }

  // It goes on without its call: its outcome is kept for check_run.
  void outcome
    .then(async (answer) => {
      if ("busy" in answer) {
        dropRun(record)
        return
      }

      const kept = await keepResult(scope.ctx, {
        tokenId: scope.tokenId,
        serverId: null,
        toolName: "run_code",
        // The calls first: a stop's permission link stays last.
        text: [
          `Calls:\n${traceLines(record.trace)}`,
          ...answer.answer.content.flatMap((part) =>
            part.type === "text" ? [part.text] : [],
          ),
        ].join("\n\n"),
        mediaType: "text/plain",
        name: `${record.id}.txt`,
      })
      record.outcomeId = kept.id
    })
    .catch((error: unknown) => {
      console.error("[run_code] a run's outcome was not kept", {
        error: error instanceof Error ? error.message : "unknown",
      })
    })
    .finally(() => record.settle())

  return stillRunning(record)
}

/**
 * Holds a call open until `until` settles, `ms` after the run started, or
 * the client goes away, telling `progress` as it waits. Null when it gave
 * up first.
 */
async function held<T>(
  record: RunRecord,
  until: Promise<T>,
  {
    ms,
    signal,
    progressMs,
    progress,
  }: {
    ms: number
    signal?: AbortSignal
    progressMs: number
    progress?: (progress: RunProgress) => void
  },
): Promise<{ value: T } | null> {
  const ticker = progress
    ? setInterval(
        () =>
          progress({
            runId: record.id,
            elapsedMs: Date.now() - record.startedAt,
            calls: record.trace.length,
          }),
        progressMs,
      )
    : null
  let release = () => {}
  const gaveUp = new Promise<null>((resolve) => {
    if (signal?.aborted) {
      resolve(null)
      return
    }

    const deadline = setTimeout(() => resolve(null), ms)
    const onGone = () => resolve(null)
    signal?.addEventListener("abort", onGone, { once: true })
    release = () => {
      clearTimeout(deadline)
      signal?.removeEventListener("abort", onGone)
    }
  })

  try {
    return await Promise.race([until.then((value) => ({ value })), gaveUp])
  } finally {
    release()

    if (ticker) {
      clearInterval(ticker)
    }
  }
}

/** A run that never started (PCP was busy): nothing to ask about. */
function dropRun(record: RunRecord): void {
  record.state = "failed"
  record.endedAt = record.startedAt
  record.key = ""
  record.settle()
}

/** What an ended run answers, in run_code's call or kept for check_run. */
async function answerFor(
  scope: PermissionScope,
  run: Extract<ProgramRun, { result: RunResult }>,
  input: { returns?: boolean },
  limits: ResourceLimits,
): Promise<CallToolResult> {
  const { result, stop, calls, took, id, trace, reason, state } = run
  const did = `${seconds(took)}, ${plural(calls, "call")}`
  const output = await shownOutput(scope, result.output, result.dropped)
  const head = `Run ${id}: ${stateLabel(state)}.${reason ? ` Exit reason: ${reasonLabel(reason)}.` : ""}`

  if (result.kind === "stopped" && stop) {
    return withLead(
      [
        `The program stopped at ${stop.at} after ${did}: the owner has to act before that call can run, and nothing of the program ran after it. Calls before it did run.`,
        head,
        ...(output ? [`It printed:\n${output}`] : []),
        ...effectLines(trace),
        isConnectResult(stop.result)
          ? "Once the owner has connected it (check_server says when), run the program again."
          : "Once the owner has answered below, run the program again (if they allowed the tool only once, check_permission gives that one call's answer instead; for the program to make it, they choose Always allow, or Allow for while that lasts).",
      ].join("\n\n"),
      stop.result,
    )
  }

  if (result.kind === "done") {
    return text(
      [
        `The program finished in ${did} (${id}).`,
        ...(output ? [`It printed:\n${output}`] : []),
        ...(result.returned !== null
          ? [
              `It returned:\n${await shownReturn(scope, result.returned, limits)}`,
            ]
          : input.returns === false
            ? []
            : ["It returned nothing."]),
      ].join("\n\n"),
    )
  }

  return text(
    [
      `The program failed after ${did}.`,
      head,
      result.kind === "error" ? result.message : "It was stopped.",
      ...(output ? [`It printed:\n${output}`] : []),
      ...effectLines(trace),
    ].join("\n\n"),
    true,
  )
}

/** The answer for a run that goes on past its call. */
function stillRunning(record: RunRecord): CallToolResult {
  const now = Date.now()

  return text(
    [
      `Run ${record.id} is still running, ${seconds(now - record.startedAt)} after it started, with ${plural(record.trace.length, "call")} so far. PCP answers now so that this call does not time out; the run goes on, for ${RUN_TIMEOUT_MS / 60_000} minutes at most in all.`,
      `Calls so far:\n${traceLines(record.trace, now)}`,
      ...(sideEffects(record.trace).length > 0 ? [MAY_HAVE_TAKEN_EFFECT] : []),
      `Call check_run with this id (${record.id}) for how it ends; don't start it again.`,
    ].join("\n\n"),
  )
}

/** The answer for a program sent again while its run goes on, or soon after. */
function duplicateAnswer(record: RunRecord): CallToolResult {
  const now = Date.now()
  const again = "To run the same program again on purpose, pass rerun: true."

  if (record.state === "running") {
    return text(
      [
        `This program is already running for this token as ${record.id} (started ${seconds(now - record.startedAt)} ago, ${plural(record.trace.length, "call")} so far), so PCP did not start it again.`,
        `Calls so far:\n${traceLines(record.trace, now)}`,
        ...(sideEffects(record.trace).length > 0
          ? [MAY_HAVE_TAKEN_EFFECT]
          : []),
        `Call check_run with ${record.id} for how it ends. ${again}`,
      ].join("\n\n"),
    )
  }

  return text(
    [
      `This program ran for this token ${seconds(now - (record.endedAt ?? now))} ago as ${record.id}, and ${stateLabel(record.state)}${record.reason ? ` (exit reason: ${reasonLabel(record.reason)})` : ""}, so PCP did not start it again.`,
      ...effectLines(record.trace, now),
      `${record.outcomeId ? `check_run with ${record.id} reads its whole outcome.` : `Its answer was handed back when it ended; check_run with ${record.id} lists its calls.`} ${again}`,
    ].join("\n\n"),
  )
}

/**
 * check_run: how one of the token's runs went. A run still going is waited
 * for up to `waitMs`; an ended one answers with its kept outcome, or, when
 * run_code's own answer carried that, with its state and calls. Another
 * token's run, and one PCP forgot (it restarted), are unknown.
 */
export async function checkRun(
  scope: PermissionScope,
  id: string,
  {
    waitMs = RUN_ANSWER_MS,
    signal,
    progressMs = RUN_PROGRESS_MS,
    progress,
  }: {
    waitMs?: number
    signal?: AbortSignal
    progressMs?: number
    progress?: (progress: RunProgress) => void
  } = {},
): Promise<CallToolResult> {
  const record =
    typeof id === "string" && id.length <= 64
      ? findRun(scope.ctx.vaultId, scope.tokenId, id)
      : null

  if (!record || record.key === "") {
    return text(
      "PCP knows no run by that id for this token. It knows only this token's own runs, and forgets them when it restarts, which also ends a run that was still going: if it may have run, check what it acts on before running it again.",
      true,
    )
  }

  // Waiting until the run ended and its outcome, when it is kept, is.
  await held(record, record.settled, {
    ms: waitMs,
    signal,
    progressMs,
    progress,
  })

  if (record.state === "running") {
    return stillRunning(record)
  }

  const took = seconds((record.endedAt ?? Date.now()) - record.startedAt)
  const head = `Run ${record.id}: ${stateLabel(record.state)}${record.reason ? `. Exit reason: ${reasonLabel(record.reason)}` : ""}, ${took} after it started.`
  const failed = record.state === "failed"

  if (record.outcomeId) {
    const opened = await openResult(scope.ctx, {
      tokenId: scope.tokenId,
      id: record.outcomeId,
    })

    if (opened) {
      return text(
        `${head} Its outcome, as run_code would have answered it (kept as result ${record.outcomeId}):\n\n${opened.text()}`,
        failed,
      )
    }
  }

  return text(
    [
      record.answered
        ? `${head} run_code's own answer carried its outcome.`
        : `${head} Its outcome is no longer kept.`,
      `Calls:\n${traceLines(record.trace)}`,
      ...(record.state === "finished" ? [] : effectLines(record.trace)),
    ].join("\n\n"),
    failed,
  )
}

export type RunOptions = {
  call: CodeCaller
  list?: CodeLister
  /** The request's own: the run stops when it goes away (a wrapper's). */
  signal?: AbortSignal
  executor?: Executor
  timeoutMs?: number
  /** The run's id, when the caller remembers the run; a new one otherwise. */
  runId?: string
  /** Where the run's calls are traced, for a caller that reads it as it goes. */
  trace?: TraceEntry[]
  /**
   * The latest the caller's own run lasts (a run_code program that called
   * a wrapper's tool): the run's calls wait under pacing until whichever
   * of it and the run's own limit comes first.
   */
  deadline?: number
}

/** How one program's run went, before it is put into words. */
export type ProgramRun =
  | {
      id: string
      result: RunResult
      /** Where the owner has to act first, when a call said so. */
      stop: { at: string; result: CallToolResult } | null
      calls: number
      took: number
      state: Exclude<RunState, "running">
      /** Why it ended, when it did not finish. */
      reason: ExitReason | null
      /** Its calls, by server and tool, with no arguments or results. */
      trace: TraceEntry[]
    }
  /** Too many programs run already; nothing ran. */
  | { busy: string }

/** Programs under way in this process, run_code's and wrappers' apart. */
const runningBy = { run_code: 0, wrapper: 0 }

/**
 * Runs a program with the bridge: run_code's, or a wrapper tool's
 * (lib/core/wrappers/run.ts), which is given its arguments as `input` and
 * logs its calls and keeps its values under "wrapper". Each counts against
 * the owner's programs-at-once on its own, so a run_code program calling a
 * wrapper does not wait on itself.
 */
export async function runProgram(
  scope: PermissionScope,
  {
    code,
    input,
    label = "run_code",
  }: { code: string; input?: string; label?: "run_code" | "wrapper" },
  {
    call,
    list,
    signal,
    executor = runJavaScript,
    timeoutMs = RUN_TIMEOUT_MS,
    runId = newRunId(),
    trace = [],
    deadline: outerDeadline,
  }: RunOptions,
): Promise<ProgramRun> {
  const limits = await loadResourceLimits()

  if (runningBy[label] >= limits.programsAtOnce) {
    return {
      busy: `PCP is running ${limits.programsAtOnce} ${limits.programsAtOnce === 1 ? "program" : "programs"} already, as many as the owner's settings allow at once. Try again in a moment.`,
    }
  }

  runningBy[label] += 1

  const controller = new AbortController()
  /** What ended the run from outside the program, when something did. */
  let abortedFor: "time" | "gone" | null = null
  /** When the run's limit ends it, or its caller's run before that. */
  const deadline = Math.min(Date.now() + timeoutMs, outerDeadline ?? Infinity)
  const timer = setTimeout(() => {
    abortedFor ??= "time"
    controller.abort(
      `The run took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`,
    )
  }, timeoutMs)
  const onGone = () => {
    abortedFor ??= "gone"
    controller.abort("The request went away, so the run was stopped.")
  }

  // A request already gone fires no abort event: it is noticed here.
  if (signal?.aborted) {
    onGone()
  } else {
    signal?.addEventListener("abort", onGone, { once: true })
  }

  const started = Date.now()
  const output = new Output()
  let calls = 0
  /** A call was refused for being past MAX_CALLS_PER_RUN. */
  let overCalls = false
  let reads = 0
  let keeps = 0
  let media = 0
  /** Where the owner has to act first, once a call said so. */
  const halt: { stop: { at: string; result: CallToolResult } | null } = {
    stop: null,
  }
  let active = 0
  const queue: Array<() => void> = []

  /** Holds a call until fewer than MAX_PARALLEL_CALLS are under way. */
  async function inSlot<T>(run: () => Promise<T>): Promise<T> {
    if (active >= MAX_PARALLEL_CALLS) {
      await new Promise<void>((resolve) => queue.push(resolve))
    }

    active += 1

    try {
      return await run()
    } finally {
      active -= 1
      queue.shift()?.()
    }
  }

  async function callTool(payload: unknown): Promise<BridgeReply> {
    if (!isRecord(payload)) {
      return refuse("pcp.call takes a server, a tool and its arguments.")
    }

    const { server, tool } = payload
    const args = payload.args ?? {}

    if (
      typeof server !== "string" ||
      typeof tool !== "string" ||
      server === "" ||
      tool === "" ||
      server.length > 200 ||
      tool.length > 200
    ) {
      return refuse(
        'pcp.call names the server and the tool, as in pcp.call("github", "list_issues", { … }).',
      )
    }

    if (!isRecord(args)) {
      return refuse(`The arguments of ${server}/${tool} are an object.`)
    }

    if ((JSON.stringify(args) ?? "").length > limits.answerChars) {
      return refuse(
        `The arguments of ${server}/${tool} are longer than a call takes (${limits.answerChars.toLocaleString("en")} characters of JSON). Keep a long value with pcp.keep and pass its handle.`,
      )
    }

    let shape: AnswerShape

    try {
      shape = {
        fields: readFields(payload.fields ?? undefined),
        decode: readFields(payload.decode ?? undefined, "decode"),
        keep: readFields(payload.keep ?? undefined, "keep"),
      }
    } catch (error) {
      if (isPcpError(error)) {
        return refuse(error.message)
      }

      throw error
    }

    // The step it is made in (pcp.step), for the trace only; the program's
    // own text, so it is cut and kept to one line.
    const step =
      typeof payload.step === "string"
        ? payload.step
            .replace(/[\u0000-\u001f\u007f]+/g, " ")
            .trim()
            .slice(0, MAX_STEP_NAME_CHARS)
        : ""

    if (++calls > MAX_CALLS_PER_RUN) {
      overCalls = true
      return refuse(`A run makes at most ${MAX_CALLS_PER_RUN} calls.`)
    }

    return inSlot(async () => {
      if (halt.stop) {
        return { stop: true }
      }

      if (controller.signal.aborted) {
        return refuse("The run is over.")
      }

      const at = Date.now()
      const entry: TraceEntry = {
        server,
        tool,
        outcome: "running",
        startedAt: at,
        ms: null,
        readOnly: null,
        transit: false,
        ...(step ? { step } : {}),
      }
      trace.push(entry)

      let traced: { outcome: CodeCallOutcome; note: LogNote }

      try {
        // A note of the call's own, for the request it made; the run itself
        // asked the owner too, so it goes on run_code's note as well.
        traced = await withLogNote(async (note) => ({
          outcome: await call({
            server,
            tool,
            args: bareHandles(args) as Record<string, unknown>,
            run: {
              runId,
              signal: controller.signal,
              deadline,
              onRun: (inner) => {
                entry.runId = inner
              },
            },
            lookedUp: (readOnly) => {
              entry.readOnly = readOnly
            },
            ...shape,
          }),
          note,
        }))
      } catch (error) {
        // Nothing says how far it got.
        entry.outcome = "error"
        entry.transit = true
        entry.ms = Date.now() - at
        throw error
      }

      const { outcome, note } = traced
      const owner = "owner" in outcome
      entry.ms = Date.now() - at
      entry.outcome = owner
        ? "asked"
        : outcome.ok
          ? "ok"
          : outcome.refused
            ? "refused"
            : "error"
      entry.transit = !owner && !outcome.ok && outcome.transit === true

      if (note.asked) {
        noteOwnerAsked(note.request)
      }

      void appendRequestLog({
        vaultId: scope.ctx.vaultId,
        tokenId: scope.tokenId,
        tool: label,
        server,
        upstreamTool: tool,
        ok: owner || outcome.ok,
        ms: Date.now() - at,
        ...(!owner && !outcome.ok ? { error: "The call failed." } : {}),
        ...(owner || note.asked ? { asked: true } : {}),
        ...(note.request ? { request: note.request } : {}),
        ...(note.secret ? { secret: note.secret, origin: note.origin } : {}),
      })

      if ("owner" in outcome) {
        halt.stop ??= { at: `${server}/${tool}`, result: outcome.owner }
        return { stop: true }
      }

      // The program is told the value or the error, nothing else; a call
      // pacing refused says so, and when to try again.
      return outcome.ok
        ? { ok: true, value: outcome.value }
        : {
            ok: false,
            error: outcome.error,
            ...(outcome.code === "paced"
              ? { code: "paced", retryAfterMs: outcome.retryAfterMs ?? 0 }
              : {}),
          }
    })
  }

  async function read(payload: unknown): Promise<BridgeReply> {
    const id = isRecord(payload) ? payload.id : undefined
    const as = isRecord(payload) ? (payload.as ?? "text") : undefined

    if (typeof id !== "string" || id === "" || id.length > 64) {
      return refuse("pcp.read takes a handle, or its id: pcp.read(handle).")
    }

    if (as !== "text" && as !== "base64") {
      return refuse('pcp.read reads as "text" (the default) or "base64".')
    }

    if (++reads > MAX_READS_PER_RUN) {
      return refuse(`A run reads at most ${MAX_READS_PER_RUN} kept results.`)
    }

    const opened = await openResult(scope.ctx, { tokenId: scope.tokenId, id })

    if (!opened) {
      return refuse(missingResultMessage())
    }

    if (
      as === "text" &&
      opened.kind === "bytes" &&
      !isTextType(opened.mediaType)
    ) {
      return refuse(
        `Result ${id} is ${bareType(opened.mediaType)}, not text: read its bytes as base64 instead (as: "base64").`,
      )
    }

    try {
      const value =
        as === "base64" ? opened.bytes().toString("base64") : opened.text()

      if (value.length > limits.answerChars) {
        return refuse(
          `Result ${id} is ${value.length.toLocaleString("en")} characters${as === "base64" ? " as base64" : ""}, more than a program reads at once (${limits.answerChars.toLocaleString("en")}). The owner can raise the largest file in PCP's settings, under Resources.`,
        )
      }

      return { ok: true, value }
    } catch (error) {
      if (isPcpError(error)) {
        return refuse(error.message)
      }

      throw error
    }
  }

  async function keep(payload: unknown): Promise<BridgeReply> {
    if (!isRecord(payload) || typeof payload.value !== "string") {
      return refuse(
        "pcp.keep takes a text, or a value to keep as JSON, and optionally { name, type }.",
      )
    }

    const encoding = payload.encoding ?? "text"

    if (encoding !== "text" && encoding !== "base64") {
      return refuse('pcp.keep\'s encoding is "text" (the default) or "base64".')
    }

    const type =
      payload.type ??
      (encoding === "base64" ? "application/octet-stream" : "text/plain")
    const name = payload.name ?? null

    if (
      typeof type !== "string" ||
      type.length > 200 ||
      !MEDIA_TYPE.test(type)
    ) {
      return refuse('pcp.keep\'s type is a media type, like "text/csv".')
    }

    if (name !== null && typeof name !== "string") {
      return refuse("pcp.keep's name is a file name.")
    }

    if (encoding === "base64") {
      return keepFile(payload.value, type, name)
    }

    if (payload.value.length > limits.textChars) {
      return refuse(
        `That is ${payload.value.length.toLocaleString("en")} characters; PCP keeps ${limits.textChars.toLocaleString("en")} of one text at most.`,
      )
    }

    if (++keeps > MAX_KEEPS_PER_RUN) {
      return refuse(`A run keeps at most ${MAX_KEEPS_PER_RUN} values.`)
    }

    const kept = await keepResult(scope.ctx, {
      tokenId: scope.tokenId,
      serverId: null,
      toolName: label,
      text: payload.value,
      mediaType: type,
      name,
    })

    return { ok: true, value: handleOf(kept) }
  }

  /** Bytes sent as base64, kept as a file of the token's. */
  async function keepFile(
    base64: string,
    type: string,
    name: string | null,
  ): Promise<BridgeReply> {
    // Base64 is 4 characters for every 3 bytes; anything longer than the
    // largest file is refused before it is decoded.
    if (base64.length > Math.ceil(limits.fileBytes / 3) * 4 + 4) {
      return refuse(
        `That is more than PCP keeps of one file (${limits.fileBytes.toLocaleString("en")} bytes). The owner can raise that in PCP's settings, under Resources.`,
      )
    }

    const bare = base64.replace(/\s+/g, "")

    if (bare.length % 4 === 1 || !BASE64.test(bare)) {
      return refuse(
        'pcp.keep was told the value is base64, and it is not: only A-Z, a-z, 0-9, "+", "/" and "=" at the end.',
      )
    }

    if (++keeps > MAX_KEEPS_PER_RUN) {
      return refuse(`A run keeps at most ${MAX_KEEPS_PER_RUN} values.`)
    }

    try {
      const kept = await keepBytes(scope.ctx, {
        tokenId: scope.tokenId,
        serverId: null,
        toolName: label,
        bytes: Buffer.from(bare, "base64"),
        mediaType: type,
        name,
      })

      return { ok: true, value: handleOf(kept) }
    } catch (error) {
      if (isPcpError(error)) {
        return refuse(error.message)
      }

      throw error
    }
  }

  /** pcp.image.compress and pcp.video.frames: one of the token's files. */
  async function mediaOp(payload: unknown): Promise<BridgeReply> {
    const kind = isRecord(payload) ? payload.kind : undefined
    const id = isRecord(payload) ? payload.id : undefined
    const options = isRecord(payload) ? payload.options : undefined

    if (kind !== "image" && kind !== "frames") {
      return refuse(
        'PCP works on an image (kind "image") or a video (kind "frames").',
      )
    }

    const what = kind === "image" ? "pcp.image.compress" : "pcp.video.frames"

    if (typeof id !== "string" || id === "" || id.length > 64) {
      return refuse(
        `${what} takes a handle, or its id: ${what}(handle, { … }).`,
      )
    }

    const overMedia = () => ++media > MAX_MEDIA_PER_RUN
    const tooMany = `A run works on at most ${MAX_MEDIA_PER_RUN} images and videos.`

    if (kind === "frames") {
      const video = readFrameOptions(options)

      if (!video.ok) {
        return refuse(video.error)
      }

      return overMedia() ? refuse(tooMany) : frames(id, video.options)
    }

    const image = readImageOptions(options)

    if (!image.ok) {
      return refuse(image.error)
    }

    if (overMedia()) {
      return refuse(tooMany)
    }

    if (++keeps > MAX_KEEPS_PER_RUN) {
      return refuse(`A run keeps at most ${MAX_KEEPS_PER_RUN} values.`)
    }

    const opened = await openResult(scope.ctx, { tokenId: scope.tokenId, id })

    if (!opened) {
      return refuse(missingResultMessage())
    }

    const bytes = opened.bytes()
    const found = mediaKind(bytes, opened.mediaType)

    if (opened.kind !== "bytes" || !found.image) {
      return refuse(
        `Result ${id} is ${opened.kind === "bytes" ? found.type : "a text"}, not an image PCP reads (PNG, JPEG, WebP or GIF)${found.video ? ": take frames from a video with pcp.video.frames" : ""}.`,
      )
    }

    const made = await compressImage(bytes, {
      options: image.options,
      name: opened.name,
      maxBytes: limits.fileBytes,
    })

    if (!made.ok) {
      return refuse(made.error)
    }

    try {
      const kept = await keepBytes(scope.ctx, {
        tokenId: scope.tokenId,
        serverId: null,
        toolName: label,
        bytes: made.image.bytes,
        mediaType: made.image.type,
        name: made.image.name,
      })

      return {
        ok: true,
        value: {
          handle: handleOf(kept),
          width: made.image.width,
          height: made.image.height,
          bytes: made.image.bytes.length,
          type: made.image.type,
        },
      }
    } catch (error) {
      if (isPcpError(error)) {
        return refuse(error.message)
      }

      throw error
    }
  }

  /**
   * Frames from one of the token's videos, taken by ffmpeg in the sandbox:
   * PCP runs sandbox/pcp.py's `frames` there, with a bridge that reads only
   * that video and keeps only JPEGs, through this run's own read and keep.
   */
  async function frames(
    id: string,
    options: FrameOptions,
  ): Promise<BridgeReply> {
    // A program in the sandbox has ffmpeg at hand; the runner, running it,
    // could not take another job for it.
    if (sandboxRuns(bridge)) {
      return refuse(
        "In the sandbox, take frames with the pcp command (pcp frames HANDLE --count 5) or pcp.frames in Python, or with ffmpeg itself.",
      )
    }

    const opened = await openResult(scope.ctx, { tokenId: scope.tokenId, id })

    if (!opened) {
      return refuse(missingResultMessage())
    }

    const found = mediaKind(opened.bytes(), opened.mediaType)

    if (opened.kind !== "bytes" || !found.video) {
      return refuse(
        `Result ${id} is ${opened.kind === "bytes" ? found.type : "a text"}, not a video${found.image ? ": make an image smaller with pcp.image.compress" : ""}.`,
      )
    }

    if (!sandboxLanguages().includes("python")) {
      return refuse(
        "Video needs the sandbox runner (see docs/self-hosting.md), which is not connected to this PCP.",
      )
    }

    const job: Bridge = async (op, payload) => {
      if (
        op === "read" &&
        isRecord(payload) &&
        payload.id === id &&
        payload.as === "base64"
      ) {
        return read(payload)
      }

      if (
        op === "keep" &&
        isRecord(payload) &&
        payload.encoding === "base64" &&
        payload.type === "image/jpeg"
      ) {
        return keep(payload)
      }

      return refuse("Taking frames reads the video and keeps frames, only.")
    }

    const ran = await sandboxExecutor("python")({
      code: framesProgram(id, options),
      bridge: job,
      signal: controller.signal,
    })
    const last = ran.output.trimEnd().split("\n").at(-1) ?? ""
    let answer: unknown = null

    try {
      answer = JSON.parse(last)
    } catch {
      // Not the program's answer: it failed before it could give one.
    }

    if (ran.kind === "done" && isRecord(answer)) {
      if (typeof answer.error === "string") {
        return refuse(answer.error.slice(0, 1_000))
      }

      if (isRecord(answer.value)) {
        return { ok: true, value: answer.value }
      }
    }

    return refuse(
      `Taking frames failed${ran.kind === "error" ? `: ${ran.message}` : ""}${last ? ` (${last.slice(0, 500)})` : ""}.`,
    )
  }

  function tools(payload: unknown): BridgeReply {
    const server = isRecord(payload) ? (payload.server ?? null) : undefined

    if (
      server !== null &&
      (typeof server !== "string" || server === "" || server.length > 200)
    ) {
      return refuse(
        'pcp.tools lists the servers, or with a server\'s name its tools: pcp.tools("github").',
      )
    }

    if (!list) {
      return refuse("PCP cannot list tools here.")
    }

    return list(server)
  }

  const bridge: Bridge = async (op, payload) => {
    switch (op) {
      case "call":
        return callTool(payload)
      case "read":
        return read(payload)
      case "keep":
        return keep(payload)
      case "tools":
        return tools(payload)
      case "media":
        return mediaOp(payload)
      default:
        return refuse(`PCP does not know "${String(op).slice(0, 40)}".`)
    }
  }

  let result: RunResult
  let internal = false

  try {
    result = await executor({
      code,
      ...(input !== undefined ? { input } : {}),
      bridge,
      signal: controller.signal,
      output,
    })
  } catch (error) {
    // A failure of PCP's, not the program's: what it printed so far stays.
    console.error("[run_code] the executor failed", {
      label,
      error: error instanceof Error ? error.message : "unknown",
    })
    internal = true
    result = {
      kind: "error",
      message: "Something went wrong inside PCP while the program ran.",
      output: output.text(),
      dropped: output.dropped,
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onGone)
    runningBy[label] -= 1
    // The run is over: a call it left under way is not waited for.
    controller.abort("The run is over.")
  }

  const state: Exclude<RunState, "running"> =
    result.kind === "done"
      ? "finished"
      : result.kind === "stopped" && halt.stop
        ? "stopped"
        : "failed"
  const reason: ExitReason | null =
    state === "finished"
      ? null
      : state === "stopped"
        ? "owner"
        : internal
          ? "internal"
          : result.kind === "error" && result.reason
            ? result.reason
            : (abortedFor ?? (overCalls ? "calls" : "error"))

  return {
    id: runId,
    result,
    stop: halt.stop,
    calls,
    took: Date.now() - started,
    state,
    reason,
    trace,
  }
}

/** A line in front of a result's first text. */
function withLead(lead: string, result: CallToolResult): CallToolResult {
  const [first, ...rest] = result.content

  return first?.type === "text"
    ? {
        ...result,
        content: [{ ...first, text: `${lead}\n\n${first.text}` }, ...rest],
      }
    : { ...result, content: [{ type: "text", text: lead }, ...result.content] }
}

/** What the program printed, kept whole as a result when it is long. */
async function shownOutput(
  scope: PermissionScope,
  output: string,
  dropped: number,
): Promise<string> {
  const lost =
    dropped > 0
      ? `\n… (${dropped.toLocaleString("en")} more characters it printed were not kept)`
      : ""

  if (output.length <= SHOWN_OUTPUT_CHARS) {
    return output.trimEnd() + lost
  }

  const kept = await keepResult(scope.ctx, {
    tokenId: scope.tokenId,
    serverId: null,
    toolName: "run_code",
    text: output,
    mediaType: "text/plain",
  })

  return `${output.slice(0, SHOWN_OUTPUT_CHARS)}\n${resultNotice(kept)}${lost}`
}

/**
 * What the program returned. A long value is kept as JSON and shown by its
 * handle, so it can be read with read_result or passed on as it is.
 */
async function shownReturn(
  scope: PermissionScope,
  returned: string,
  limits: ResourceLimits,
): Promise<string> {
  if (returned.length <= SHOWN_RETURN_CHARS) {
    return returned
  }

  if (returned.length > limits.textChars) {
    return `(${returned.length.toLocaleString("en")} characters of JSON, more than run_code passes on: ${limits.textChars.toLocaleString("en")}. Return less, or keep it with pcp.keep and return the handle.)`
  }

  const kept = await keepResult(scope.ctx, {
    tokenId: scope.tokenId,
    serverId: null,
    toolName: "run_code",
    text: returned,
    mediaType: "application/json",
  })

  return `${JSON.stringify(handleOf(kept, returned.slice(0, 200)))}\n(PCP kept the value as result ${kept.id}, ${returned.length.toLocaleString("en")} characters of JSON: read it with read_result, or pass {"$result": "${kept.id}"} to a tool.)`
}
