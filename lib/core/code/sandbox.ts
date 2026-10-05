import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import path from "node:path"

import {
  MAX_ERROR_CHARS,
  MAX_OUTPUT_CHARS,
  MAX_SANDBOX_MESSAGE_BYTES,
  RUN_TIMEOUT_MS,
  SANDBOX_STOP_GRACE_MS,
} from "./limits"
import type { Bridge, Executor, RunResult } from "./types"

/**
 * run_code's second executor: a sandbox container with a real shell (bash,
 * jq, Python), for installs that run PCP in Docker or Podman and add the
 * sandbox beside it (docker-compose.sandbox.yaml, sandbox/). The container
 * has no network at all; the one thing it shares with PCP is a volume with
 * a Unix socket in it, which PCP listens on. PCP never touches the Docker
 * socket and starts nothing: the runner in the container connects, says
 * which languages it has, and takes one program at a time.
 *
 * Over the socket go lines of JSON:
 *
 *   runner → PCP  {"type":"hello","protocol":1,"languages":["bash","python"]}
 *   PCP → runner  {"type":"run","job","language","code","timeoutMs","maxOutput"}
 *   runner → PCP  {"type":"request","job","seq","op","payload"}   (a bridge request)
 *   PCP → runner  {"type":"reply","job","seq","reply"}
 *   PCP → runner  {"type":"stop","job"}                          (stop it now)
 *   runner → PCP  {"type":"done","job","exit","output","dropped","reason"}
 *
 * A request is handed to the same bridge the QuickJS executor uses
 * (run.ts), so a program in the container has exactly the rights it would
 * have in QuickJS: the token's own tools at the token's levels. A request
 * for any job but the one running is ignored. What the runner sends is
 * checked as untrusted: it runs beside the programs it runs.
 *
 * Nothing listens unless PCP_SANDBOX_SOCKET names the socket, which only
 * the compose file for the sandbox sets.
 */

export const SANDBOX_LANGUAGES = ["bash", "python"] as const
export type SandboxLanguage = (typeof SANDBOX_LANGUAGES)[number]

const PROTOCOL = 1

type Job = {
  id: string
  bridge: Bridge
  /** The bridge said stop: the owner has to act first. */
  stopped: boolean
  finish: (result: RunResult) => void
}

type Runner = {
  socket: Socket
  languages: SandboxLanguage[]
}

type State = {
  server: Server | null
  runner: Runner | null
  job: Job | null
  /** Runs take turns: the runner runs one program at a time. */
  lane: Promise<unknown>
}

const STATE = Symbol.for("pcp.sandbox")

/**
 * One per process, on globalThis like the browser's runtime: the boot code
 * that listens and the gateway that runs programs are bundled apart, and
 * would otherwise each have their own copy of this module.
 */
function state(): State {
  const holder = globalThis as unknown as { [STATE]?: State }

  holder[STATE] ??= {
    server: null,
    runner: null,
    job: null,
    lane: Promise.resolve(),
  }

  return holder[STATE]
}

/** The socket PCP listens on, when the sandbox is set up. */
export function sandboxSocketPath(): string | null {
  return process.env.PCP_SANDBOX_SOCKET?.trim() || null
}

/** The languages the connected runner has; none while none is. */
export function sandboxLanguages(): SandboxLanguage[] {
  const { runner } = state()

  return runner ? [...runner.languages] : []
}

function send(target: Runner | null, message: Record<string, unknown>) {
  if (target && !target.socket.destroyed) {
    target.socket.write(`${JSON.stringify(message)}\n`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Splits what a socket sends into lines, refusing one that is too long. */
function lines(socket: Socket, onLine: (line: string) => void): void {
  let pending: Buffer[] = []
  let size = 0

  socket.on("data", (chunk: Buffer) => {
    let start = 0
    let at = chunk.indexOf(10)

    while (at !== -1) {
      pending.push(chunk.subarray(start, at))
      const line = Buffer.concat(pending).toString("utf8")
      pending = []
      size = 0
      onLine(line)
      start = at + 1
      at = chunk.indexOf(10, start)
    }

    const rest = chunk.subarray(start)
    size += rest.length

    if (size > MAX_SANDBOX_MESSAGE_BYTES) {
      socket.destroy()
      return
    }

    if (rest.length > 0) {
      pending.push(rest)
    }
  })
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/** What the runner said when a program ended, as a run's result. */
function resultOf(message: Record<string, unknown>, current: Job): RunResult {
  const output = typeof message.output === "string" ? message.output : ""
  const kept = clip(output, MAX_OUTPUT_CHARS)
  const dropped =
    (typeof message.dropped === "number" && message.dropped > 0
      ? Math.floor(message.dropped)
      : 0) +
    (output.length - kept.length)
  const shown = { output: kept, dropped }

  if (current.stopped) {
    return { kind: "stopped", ...shown }
  }

  if (message.reason === "timeout") {
    return {
      kind: "error",
      message: `The run took longer than ${Math.round(RUN_TIMEOUT_MS / 1000)} seconds and was stopped.`,
      ...shown,
    }
  }

  if (typeof message.error === "string") {
    return {
      kind: "error",
      message: clip(message.error, MAX_ERROR_CHARS),
      ...shown,
    }
  }

  const exit = typeof message.exit === "number" ? message.exit : null

  return exit === 0
    ? { kind: "done", returned: null, ...shown }
    : {
        kind: "error",
        message:
          exit === null
            ? "The program was killed."
            : `The program exited with status ${exit}.`,
        ...shown,
      }
}

function onMessage(from: Runner | null, socket: Socket, line: string) {
  const st = state()
  let message: unknown

  try {
    message = JSON.parse(line)
  } catch {
    socket.destroy()
    return
  }

  if (!isRecord(message)) {
    return
  }

  if (message.type === "hello") {
    const languages = Array.isArray(message.languages)
      ? SANDBOX_LANGUAGES.filter((language) =>
          (message.languages as unknown[]).includes(language),
        )
      : []

    // One runner at a time: the first that said hello keeps the place
    // until it goes away.
    if (
      message.protocol !== PROTOCOL ||
      languages.length === 0 ||
      (st.runner && st.runner.socket !== socket && !st.runner.socket.destroyed)
    ) {
      socket.destroy()
      return
    }

    st.runner = { socket, languages }
    console.log(`[sandbox] runner connected (${languages.join(", ")})`)
    return
  }

  // Everything else comes only from the runner that said hello, about the
  // job it is running.
  if (!from || from.socket !== socket || !st.job || message.job !== st.job.id) {
    return
  }

  const current = st.job

  if (message.type === "request") {
    const seq = message.seq

    if (typeof seq !== "number" || typeof message.op !== "string") {
      return
    }

    void current
      .bridge(message.op, message.payload)
      .catch(() => ({
        ok: false as const,
        error: "Something went wrong inside PCP.",
      }))
      .then((reply) => {
        if (st.job !== current) {
          return
        }

        if ("stop" in reply) {
          current.stopped = true
          send(from, { type: "stop", job: current.id })
          return
        }

        send(from, { type: "reply", job: current.id, seq, reply })
      })
    return
  }

  if (message.type === "done") {
    current.finish(resultOf(message, current))
  }
}

/**
 * Starts listening for the runner, when the sandbox is set up; does
 * nothing otherwise, and nothing the second time.
 */
export async function startSandbox(
  socketPath = sandboxSocketPath(),
): Promise<void> {
  const st = state()

  if (!socketPath || st.server) {
    return
  }

  mkdirSync(path.dirname(socketPath), { recursive: true })

  // A socket left by an earlier PCP; nothing else is kept there.
  if (existsSync(socketPath)) {
    rmSync(socketPath, { force: true })
  }

  const listening = createServer((socket) => {
    lines(socket, (line) => onMessage(st.runner, socket, line))
    socket.on("error", () => socket.destroy())
    socket.on("close", () => {
      if (st.runner?.socket !== socket) {
        return
      }

      st.runner = null
      console.log("[sandbox] runner disconnected")
      st.job?.finish({
        kind: "error",
        message: "The sandbox went away while the program ran.",
        output: "",
        dropped: 0,
      })
    })
  })

  await new Promise<void>((resolve, reject) => {
    listening.once("error", reject)
    listening.listen(socketPath, () => {
      listening.off("error", reject)
      resolve()
    })
  })

  // The runner reaches it through the shared volume as PCP's group.
  chmodSync(socketPath, 0o660)
  st.server = listening
  console.log(`[sandbox] waiting for the runner on ${socketPath}`)
}

/** Stops listening and lets the runner go; for tests and shutdown. */
export async function stopSandbox(): Promise<void> {
  const st = state()
  const closing = st.server
  st.server = null
  st.runner?.socket.destroy()
  st.runner = null

  if (closing) {
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  }
}

async function runInSandbox(
  language: SandboxLanguage,
  { code, bridge, signal }: Parameters<Executor>[0],
): Promise<RunResult> {
  const failed = (message: string): RunResult => ({
    kind: "error",
    message,
    output: "",
    dropped: 0,
  })

  if (signal.aborted) {
    return failed(
      typeof signal.reason === "string"
        ? signal.reason
        : "The run was stopped.",
    )
  }

  const st = state()
  const target = st.runner

  if (!target || !target.languages.includes(language)) {
    return failed(
      `The sandbox that runs ${language} is not connected to PCP. JavaScript runs without it.`,
    )
  }

  return new Promise<RunResult>((resolve) => {
    const id = randomUUID()
    let grace: ReturnType<typeof setTimeout> | null = null

    const onAbort = () => {
      send(target, { type: "stop", job: id })
      // The runner says when the program has ended; one that does not is
      // not waited for past the grace.
      grace = setTimeout(
        () =>
          current.finish(
            failed(
              typeof signal.reason === "string"
                ? signal.reason
                : "The run was stopped.",
            ),
          ),
        SANDBOX_STOP_GRACE_MS,
      )
    }

    const current: Job = {
      id,
      bridge,
      stopped: false,
      finish: (result) => {
        if (st.job !== current) {
          return
        }

        st.job = null
        signal.removeEventListener("abort", onAbort)

        if (grace) {
          clearTimeout(grace)
        }

        resolve(
          signal.aborted && result.kind !== "stopped"
            ? {
                ...result,
                kind: "error",
                message:
                  typeof signal.reason === "string"
                    ? signal.reason
                    : "The run was stopped.",
              }
            : result,
        )
      },
    }

    st.job = current
    signal.addEventListener("abort", onAbort, { once: true })
    send(target, {
      type: "run",
      job: id,
      language,
      code,
      timeoutMs: RUN_TIMEOUT_MS,
      maxOutput: MAX_OUTPUT_CHARS,
    })
  })
}

/** The executor for one of the sandbox's languages. */
export function sandboxExecutor(language: SandboxLanguage): Executor {
  return (input) => {
    // One program at a time, in the order they came.
    const st = state()
    const turn = st.lane.then(() => runInSandbox(language, input))
    st.lane = turn.catch(() => {})
    return turn
  }
}
