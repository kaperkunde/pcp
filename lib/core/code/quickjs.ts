import singleFile from "@jitl/quickjs-singlefile-cjs-release-sync"
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSSyncVariant,
} from "quickjs-emscripten-core"

import {
  MAX_CALLS_PER_RUN,
  MAX_ERROR_CHARS,
  MAX_KEEPS_PER_RUN,
  MAX_READS_PER_RUN,
  RUN_CPU_MS,
  RUN_MEMORY_BYTES,
  RUN_STACK_BYTES,
} from "./limits"
import { Output } from "./output"
import type { BridgeReply, Executor, RunEnd, RunResult } from "./types"

/**
 * run_code's default executor: JavaScript in QuickJS, compiled to
 * WebAssembly. The program runs inside the WebAssembly instance's own
 * memory, with nothing of Node's: no require, no process, no fetch, no
 * timers, no file system. What it can reach is what this file hands it,
 * two functions the prelude below takes off the global object at once and
 * wraps as `pcp` and `console`:
 *
 * - `__pcp_host(op, json)` sends one request to the bridge (run.ts) and
 *   returns a promise of its JSON reply;
 * - `__pcp_print(text)` adds a line to the output.
 *
 * Only strings cross, both ways; the host never holds one of the program's
 * objects. Each run gets a WebAssembly instance of its own, so its memory is
 * gone when it ends and no run can see another's. That memory is made here
 * with a maximum, which the WebAssembly engine enforces: QuickJS's own
 * memory limit counts nothing in these builds (they lack
 * malloc_usable_size), so it is not relied on.
 *
 * The program's time is counted while it computes, not while it waits on a
 * call: an interrupt stops it past RUN_CPU_MS, when the run is aborted, and
 * when the bridge says stop, and none of those can be caught by the
 * program. After a stop nothing of it runs again.
 */

/**
 * The engine's build: the module's default export, which an ES import of a
 * CommonJS package may wrap once more.
 */
const VARIANT = ((singleFile as unknown as { default?: QuickJSSyncVariant })
  .default ?? singleFile) as QuickJSSyncVariant

/** WebAssembly pages are 64 KiB; QuickJS starts with 16 MiB. */
const PAGE_BYTES = 65_536
const INITIAL_PAGES = 256

const PRELUDE = `(() => {
  const host = globalThis.__pcp_host
  const print = globalThis.__pcp_print
  delete globalThis.__pcp_host
  delete globalThis.__pcp_print

  const show = (value) => {
    if (typeof value === "string") return value
    if (value instanceof Error) return value.stack ? value.name + ": " + value.message + "\\n" + value.stack : value.name + ": " + value.message
    try {
      const json = JSON.stringify(value)
      return json === undefined ? String(value) : json
    } catch {
      return String(value)
    }
  }

  const ask = async (op, payload) => {
    const reply = JSON.parse(await host(op, JSON.stringify(payload)))
    if (!reply.ok) throw new Error(reply.error)
    return reply.value
  }

  const idOf = (handle) =>
    typeof handle === "string" ? handle : handle !== null && typeof handle === "object" ? handle.$result : undefined

  const pcp = Object.freeze({
    call: (server, tool, args, options) =>
      ask("call", {
        server,
        tool,
        args: args === undefined ? {} : args,
        fields: options?.fields,
        decode: options?.decode,
        keep: options?.keep,
      }),
    read: (handle) => ask("read", { id: idOf(handle) }),
    keep: (value, options) =>
      ask("keep", {
        value: typeof value === "string" ? value : JSON.stringify(value),
        type: options?.type ?? (typeof value === "string" ? "text/plain" : "application/json"),
        name: options?.name,
      }),
  })
  const log = (...values) => print(values.map(show).join(" "))

  Object.defineProperty(globalThis, "pcp", { value: pcp, enumerable: true })
  Object.defineProperty(globalThis, "console", {
    value: Object.freeze({ log, info: log, warn: log, error: log, debug: log }),
    enumerable: true,
  })
})()`

/**
 * The program as an async function's body, so it can await and return; its
 * value comes back as JSON text, made inside the engine. It starts on the
 * first line, so the line numbers in an error are the program's own.
 */
function wrap(code: string): string {
  return `(async () => { const value = await (async () => {${code}\n})(); const json = JSON.stringify(value); return json === undefined ? null : json })()`
}

/** Requests one run may send, of every kind together. */
const MAX_REQUESTS = MAX_CALLS_PER_RUN + MAX_KEEPS_PER_RUN + MAX_READS_PER_RUN

function clip(text: string): string {
  return text.length > MAX_ERROR_CHARS
    ? `${text.slice(0, MAX_ERROR_CHARS)}… (cut short)`
    : text
}

/** What the program threw, as text: an error's name, message and stack. */
export function describeThrown(value: unknown): string {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { message?: unknown }).message === "string"
  ) {
    const { name, message, stack } = value as {
      name?: unknown
      message: string
      stack?: unknown
    }
    const head = `${typeof name === "string" ? name : "Error"}: ${message}`
    const trace = typeof stack === "string" ? stack.trimEnd() : ""

    return clip(trace ? `${head}\n${trace}` : head)
  }

  let shown: string

  try {
    shown = typeof value === "string" ? value : String(JSON.stringify(value))
  } catch {
    shown = String(value)
  }

  return clip(`Uncaught ${shown}`)
}

/**
 * The executor, with the limits it holds a program to; tests pass smaller
 * ones to reach them quickly.
 */
export function javaScriptExecutor({
  cpuMs = RUN_CPU_MS,
  memoryBytes = RUN_MEMORY_BYTES,
}: { cpuMs?: number; memoryBytes?: number } = {}): Executor {
  return (input) => runInQuickJs(input, { cpuMs, memoryBytes })
}

export const runJavaScript: Executor = javaScriptExecutor()

async function runInQuickJs(
  { code, bridge, signal }: Parameters<Executor>[0],
  { cpuMs, memoryBytes }: { cpuMs: number; memoryBytes: number },
): Promise<RunResult> {
  const output = new Output()
  const memory = new WebAssembly.Memory({
    initial: INITIAL_PAGES,
    maximum: Math.max(INITIAL_PAGES, Math.floor(memoryBytes / PAGE_BYTES)),
  })
  const engine = await newQuickJSWASMModuleFromVariant(
    newVariant(VARIANT, { wasmMemory: memory }),
  )
  const runtime = engine.newRuntime()
  const vm = runtime.newContext()

  let cpu = 0
  let enteredAt: number | null = null
  let overCpu = false
  let stopped = false
  /** Set when PCP could not hand the program a reply: its memory is full. */
  let broken: string | null = null
  let finished = false
  let requests = 0
  const waiting = new Set<Promise<void>>()
  const deferreds = new Set<QuickJSDeferredPromise>()

  runtime.setMaxStackSize(RUN_STACK_BYTES)
  runtime.setInterruptHandler(() => {
    if (stopped || broken || signal.aborted) {
      return true
    }

    if (enteredAt !== null && cpu + (Date.now() - enteredAt) > cpuMs) {
      overCpu = true
      return true
    }

    return false
  })

  /** Runs the program's code, counting the time it takes. */
  function inGuest<T>(run: () => T): T {
    enteredAt = Date.now()

    try {
      return run()
    } finally {
      cpu += Date.now() - enteredAt
      enteredAt = null
    }
  }

  const ended = (end: RunEnd): RunResult => ({
    ...end,
    output: output.text(),
    dropped: output.dropped,
  })

  /** Why the program stopped when the engine interrupted it or it threw. */
  function failure(thrown: QuickJSHandle): RunResult {
    const value: unknown = vm.dump(thrown)
    thrown.dispose()

    if (stopped) {
      return ended({ kind: "stopped" })
    }

    if (signal.aborted) {
      return ended({ kind: "error", message: abortMessage(signal) })
    }

    if (broken) {
      return ended({ kind: "error", message: broken })
    }

    if (overCpu) {
      return ended({
        kind: "error",
        message: `The program computed for more than ${cpuMs / 1000} seconds and was stopped.`,
      })
    }

    return ended({ kind: "error", message: describeThrown(value) })
  }

  const print = vm.newFunction("__pcp_print", (text) => {
    if (vm.typeof(text) === "string") {
      output.write(vm.getString(text))
    }
  })

  const host = vm.newFunction("__pcp_host", (opHandle, payloadHandle) => {
    if (
      vm.typeof(opHandle) !== "string" ||
      vm.typeof(payloadHandle) !== "string"
    ) {
      throw new TypeError("PCP's bridge takes two strings.")
    }

    if (++requests > MAX_REQUESTS) {
      throw new Error(
        `A run may ask PCP for at most ${MAX_REQUESTS} things (calls, reads and keeps together).`,
      )
    }

    const op = vm.getString(opHandle)
    const text = vm.getString(payloadHandle)
    const deferred = vm.newPromise()
    deferreds.add(deferred)

    const work = (async (): Promise<BridgeReply> => {
      let payload: unknown

      try {
        payload = JSON.parse(text)
      } catch {
        return { ok: false, error: "That request is not JSON." }
      }

      try {
        return await bridge(op, payload)
      } catch {
        return { ok: false, error: "Something went wrong inside PCP." }
      }
    })().then((reply) => {
      if (finished) {
        return
      }

      if ("stop" in reply) {
        stopped = true
        return
      }

      let text = JSON.stringify(reply)

      // A reply that cannot fit is an error the program sees, rather than
      // an allocation that fails inside the engine.
      if (Buffer.byteLength(text) > memoryBytes / 4) {
        text = JSON.stringify({
          ok: false,
          error: `That answer is ${Buffer.byteLength(text).toLocaleString("en")} bytes, too large for the program's memory (${megabytes(memoryBytes)} MB). Ask for less: fields, or fewer items.`,
        })
      }

      try {
        const json = vm.newString(text)
        deferred.resolve(json)
        json.dispose()
        deferreds.delete(deferred)
      } catch {
        // A failed allocation traps the instance, which is then unusable:
        // nothing touches it again.
        broken = `The program ran out of memory (${megabytes(memoryBytes)} MB) taking in an answer, and was stopped.`
      }
    })

    waiting.add(work)
    void work.finally(() => waiting.delete(work))

    return deferred.handle
  })

  vm.setProp(vm.global, "__pcp_host", host)
  vm.setProp(vm.global, "__pcp_print", print)
  host.dispose()
  print.dispose()

  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
    } else {
      signal.addEventListener("abort", () => resolve(), { once: true })
    }
  })

  let promise: QuickJSHandle | null = null

  try {
    const prelude = inGuest(() => vm.evalCode(PRELUDE, "pcp.js"))

    if (prelude.error) {
      return failure(prelude.error)
    }

    prelude.value.dispose()

    const started = inGuest(() => vm.evalCode(wrap(code), "code.js"))

    if (started.error) {
      return failure(started.error)
    }

    promise = started.value

    for (;;) {
      const jobs = inGuest(() => runtime.executePendingJobs())

      if (jobs.error) {
        return failure(jobs.error)
      }

      if (stopped) {
        return ended({ kind: "stopped" })
      }

      if (broken) {
        return ended({ kind: "error", message: broken })
      }

      const state = vm.getPromiseState(promise)

      if (state.type === "fulfilled") {
        const returned: unknown = vm.dump(state.value)
        state.value.dispose()

        return ended({
          kind: "done",
          returned: typeof returned === "string" ? returned : null,
        })
      }

      if (state.type === "rejected") {
        return failure(state.error)
      }

      if (signal.aborted) {
        return ended({ kind: "error", message: abortMessage(signal) })
      }

      if (waiting.size === 0) {
        return ended({
          kind: "error",
          message:
            "The program is waiting on a promise that nothing will settle (PCP has no timers), so it was stopped.",
        })
      }

      await Promise.race([...waiting, aborted])

      if (broken) {
        return ended({ kind: "error", message: broken })
      }
    }
  } finally {
    finished = true

    // A trapped instance is left alone; it goes with its memory either way.
    if (!broken) {
      try {
        for (const deferred of deferreds) {
          deferred.dispose()
        }

        promise?.dispose()
        vm.dispose()
        runtime.dispose()
      } catch {
        // Dropped all the same.
      }
    }
  }
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1024 / 1024)
}

/** What the run's abort reason says, for the assistant. */
function abortMessage(signal: AbortSignal): string {
  return typeof signal.reason === "string"
    ? signal.reason
    : "The run was stopped."
}
