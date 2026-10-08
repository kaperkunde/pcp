import type { CallToolResult } from "@modelcontextprotocol/server"

import { readFields, type AnswerShape } from "../answers"
import { isConnectResult } from "../connect"
import { isPcpError } from "../errors"
import { bareType, isTextType } from "../media-types"
import type { CodeCallOutcome, PermissionScope } from "../permissions"
import { appendRequestLog, noteOwnerAsked, withLogNote } from "../request-log"
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
  MAX_CALLS_PER_RUN,
  MAX_CODE_CHARS,
  MAX_KEEPS_PER_RUN,
  MAX_PARALLEL_CALLS,
  MAX_READS_PER_RUN,
  RUN_TIMEOUT_MS,
} from "./limits"
import { runJavaScript } from "./quickjs"
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
 *
 * Files move as handles: a file in an answer is kept and the program gets
 * its handle, and passes the handle on; it reads the bytes only when it
 * asks to (`read` as base64).
 *
 * Nothing here reads a secret or opens a connection, and the program's text
 * is not logged or kept.
 */

/** How the gateway runs a program's call: by name, at the token's level. */
export type CodeCaller = (
  input: {
    server: string
    tool: string
    args: Record<string, unknown>
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

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

/**
 * Runs one program for the token. The answer says what it printed and
 * returned, or why it failed or stopped; a long part is kept as a result
 * of the token's and shown cut, with a notice naming it.
 */
export async function runCode(
  scope: PermissionScope,
  input: {
    code: string
    /** A shell program has no value to return, only output and a status. */
    returns?: boolean
  },
  options: RunOptions,
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

  const limits = await loadResourceLimits()
  const run = await runProgram(scope, { code: input.code }, options)

  if ("busy" in run) {
    return text(run.busy, true)
  }

  const { result, stop, calls, took } = run
  const did = `${seconds(took)}, ${plural(calls, "call")}`
  const output = await shownOutput(scope, result.output, result.dropped)

  if (result.kind === "stopped" && stop) {
    return withLead(
      [
        `The program stopped at ${stop.at} after ${did}: the owner has to act before that call can run, and nothing of the program ran after it. Calls before it did run.`,
        ...(output ? [`It printed:\n${output}`] : []),
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
        `The program finished in ${did}.`,
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
      result.kind === "error" ? result.message : "It was stopped.",
      ...(output ? [`It printed:\n${output}`] : []),
    ].join("\n\n"),
    true,
  )
}

export type RunOptions = {
  call: CodeCaller
  list?: CodeLister
  /** The request's own: the run stops when it goes away. */
  signal?: AbortSignal
  executor?: Executor
  timeoutMs?: number
}

/** How one program's run went, before it is put into words. */
export type ProgramRun =
  | {
      result: RunResult
      /** Where the owner has to act first, when a call said so. */
      stop: { at: string; result: CallToolResult } | null
      calls: number
      took: number
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
  const timer = setTimeout(
    () =>
      controller.abort(
        `The run took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`,
      ),
    timeoutMs,
  )
  const onGone = () =>
    controller.abort("The request went away, so the run was stopped.")
  signal?.addEventListener("abort", onGone, { once: true })

  const started = Date.now()
  let calls = 0
  let reads = 0
  let keeps = 0
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

    if (++calls > MAX_CALLS_PER_RUN) {
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
      // A note of the call's own, for the request it made; the run itself
      // asked the owner too, so it goes on run_code's note as well.
      const { outcome, note } = await withLogNote(async (note) => ({
        outcome: await call({
          server,
          tool,
          args: bareHandles(args) as Record<string, unknown>,
          ...shape,
        }),
        note,
      }))
      const owner = "owner" in outcome

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
      })

      if ("owner" in outcome) {
        halt.stop ??= { at: `${server}/${tool}`, result: outcome.owner }
        return { stop: true }
      }

      return outcome
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
      return refuse(missingResultMessage(id))
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
      default:
        return refuse(`PCP does not know "${String(op).slice(0, 40)}".`)
    }
  }

  try {
    const result = await executor({
      code,
      ...(input !== undefined ? { input } : {}),
      bridge,
      signal: controller.signal,
    })

    return { result, stop: halt.stop, calls, took: Date.now() - started }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onGone)
    runningBy[label] -= 1
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
