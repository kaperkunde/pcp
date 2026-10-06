import { randomBytes } from "node:crypto"
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
  MAX_RANDOM_BYTES,
  MAX_READS_PER_RUN,
  RUN_CPU_MS,
  RUN_STACK_BYTES,
} from "./limits"
import { resourceLimits } from "../resources/state"
import { Output } from "./output"
import type { BridgeReply, Executor, RunEnd, RunResult } from "./types"

/**
 * run_code's default executor: JavaScript in QuickJS, compiled to
 * WebAssembly. The program runs inside the WebAssembly instance's own
 * memory, with nothing of Node's: no require, no process, no fetch, no
 * timers, no file system. What it can reach is what this file hands it,
 * three functions the prelude below takes off the global object at once and
 * wraps as `pcp`, `console` and `crypto`:
 *
 * - `__pcp_host(op, json)` sends one request to the bridge (run.ts) and
 *   returns a promise of its JSON reply;
 * - `__pcp_print(text)` adds a line to the output;
 * - `__pcp_random(count)` returns that many random bytes, as hex.
 *
 * The prelude also gives the program what the language lacks and the web
 * has (atob, btoa, TextEncoder, TextDecoder), written in JavaScript inside
 * the engine, so a program can read and build a file's bytes.
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
  const random = globalThis.__pcp_random
  delete globalThis.__pcp_host
  delete globalThis.__pcp_print
  delete globalThis.__pcp_random

  const U8 = Uint8Array
  const isView = ArrayBuffer.isView
  const fromCodes = (codes) => String.fromCharCode.apply(null, codes)
  const CHUNK = 8192

  const named = (name, message) => {
    const error = new Error(message)
    error.name = name
    return error
  }

  const asBytes = (value, what) => {
    if (value instanceof ArrayBuffer) return new U8(value)
    if (isView(value)) return new U8(value.buffer, value.byteOffset, value.byteLength)
    throw new TypeError(what + " takes bytes: a Uint8Array, another typed array or an ArrayBuffer.")
  }

  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  const CODES = []
  const INDEX = new Int16Array(128).fill(-1)
  for (let i = 0; i < 64; i++) {
    CODES.push(ALPHABET.charCodeAt(i))
    INDEX[ALPHABET.charCodeAt(i)] = i
  }

  const encode64 = (bytes) => {
    const parts = []
    let codes = []
    for (let i = 0; i < bytes.length; i += 3) {
      const rest = bytes.length - i
      const n = (bytes[i] << 16) | (rest > 1 ? bytes[i + 1] << 8 : 0) | (rest > 2 ? bytes[i + 2] : 0)
      codes.push(CODES[n >> 18], CODES[(n >> 12) & 63], rest > 1 ? CODES[(n >> 6) & 63] : 61, rest > 2 ? CODES[n & 63] : 61)
      if (codes.length >= CHUNK) {
        parts.push(fromCodes(codes))
        codes = []
      }
    }
    parts.push(fromCodes(codes))
    return parts.join("")
  }

  const decode64 = (text) => {
    let clean = String(text).replace(/[\\t\\n\\f\\r ]+/g, "")
    if (clean.length % 4 === 0) clean = clean.replace(/={1,2}$/, "")
    if (clean.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(clean)) {
      throw named("InvalidCharacterError", "That is not base64.")
    }
    const out = new U8(Math.floor((clean.length * 3) / 4))
    let at = 0
    for (let i = 0; i < clean.length; i += 4) {
      const rest = clean.length - i
      const n =
        (INDEX[clean.charCodeAt(i)] << 18) |
        (INDEX[clean.charCodeAt(i + 1)] << 12) |
        (rest > 2 ? INDEX[clean.charCodeAt(i + 2)] << 6 : 0) |
        (rest > 3 ? INDEX[clean.charCodeAt(i + 3)] : 0)
      out[at++] = n >> 16
      if (rest > 2) out[at++] = (n >> 8) & 255
      if (rest > 3) out[at++] = n & 255
    }
    return out
  }

  const latin1 = (bytes) => {
    const parts = []
    for (let i = 0; i < bytes.length; i += CHUNK) parts.push(fromCodes(bytes.subarray(i, i + CHUNK)))
    return parts.join("")
  }

  const btoa = (value) => {
    const text = String(value)
    const bytes = new U8(text.length)
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code > 255) throw named("InvalidCharacterError", "btoa takes characters up to U+00FF; encode other text with TextEncoder first.")
      bytes[i] = code
    }
    return encode64(bytes)
  }

  const atob = (value) => latin1(decode64(value))

  class TextEncoder {
    get encoding() {
      return "utf-8"
    }
    encode(input = "") {
      const text = String(input)
      const out = []
      for (let i = 0; i < text.length; i++) {
        let code = text.charCodeAt(i)
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
          const next = text.charCodeAt(i + 1)
          if (next >= 0xdc00 && next <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
            i++
          } else {
            code = 0xfffd
          }
        } else if (code >= 0xd800 && code <= 0xdfff) {
          code = 0xfffd
        }
        if (code < 0x80) out.push(code)
        else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63))
        else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
        else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
      }
      return new U8(out)
    }
  }

  class TextDecoder {
    #fatal
    #ignoreBOM
    constructor(label = "utf-8", options = {}) {
      if (!["utf-8", "utf8", "unicode-1-1-utf-8"].includes(String(label).trim().toLowerCase())) {
        throw new RangeError("TextDecoder here decodes UTF-8 only.")
      }
      this.#fatal = Boolean(options?.fatal)
      this.#ignoreBOM = Boolean(options?.ignoreBOM)
    }
    get encoding() {
      return "utf-8"
    }
    get fatal() {
      return this.#fatal
    }
    get ignoreBOM() {
      return this.#ignoreBOM
    }
    decode(input) {
      const bytes = input === undefined ? new U8(0) : asBytes(input, "TextDecoder.decode")
      const parts = []
      let codes = []
      const bad = () => {
        if (this.#fatal) throw new TypeError("Those bytes are not UTF-8.")
        codes.push(0xfffd)
      }
      let i = !this.#ignoreBOM && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
      while (i < bytes.length) {
        const lead = bytes[i]
        let need = 0
        let code = 0
        let lower = 0x80
        let upper = 0xbf
        if (lead < 0x80) {
          codes.push(lead)
          i++
        } else {
          if (lead >= 0xc2 && lead <= 0xdf) {
            need = 1
            code = lead & 0x1f
          } else if (lead >= 0xe0 && lead <= 0xef) {
            need = 2
            code = lead & 0x0f
            if (lead === 0xe0) lower = 0xa0
            if (lead === 0xed) upper = 0x9f
          } else if (lead >= 0xf0 && lead <= 0xf4) {
            need = 3
            code = lead & 0x07
            if (lead === 0xf0) lower = 0x90
            if (lead === 0xf4) upper = 0x8f
          }
          let seen = 1
          for (; seen <= need; seen++) {
            const next = bytes[i + seen]
            if (next === undefined || next < (seen === 1 ? lower : 0x80) || next > (seen === 1 ? upper : 0xbf)) break
            code = (code << 6) | (next & 0x3f)
          }
          if (need === 0 || seen <= need) {
            bad()
            i += seen
          } else {
            i += need + 1
            if (code >= 0x10000) {
              code -= 0x10000
              codes.push(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff))
            } else {
              codes.push(code)
            }
          }
        }
        if (codes.length >= CHUNK) {
          parts.push(fromCodes(codes))
          codes = []
        }
      }
      parts.push(fromCodes(codes))
      return parts.join("")
    }
  }

  const getRandomValues = (array) => {
    if (!isView(array) || array instanceof DataView || array instanceof Float32Array || array instanceof Float64Array) {
      throw new TypeError("crypto.getRandomValues fills an integer typed array, such as a Uint8Array.")
    }
    if (array.byteLength > ${MAX_RANDOM_BYTES}) {
      throw named("QuotaExceededError", "crypto.getRandomValues fills ${MAX_RANDOM_BYTES} bytes at most at once.")
    }
    const hex = random(array.byteLength)
    const view = new U8(array.buffer, array.byteOffset, array.byteLength)
    for (let i = 0; i < view.length; i++) view[i] = parseInt(hex.substr(i * 2, 2), 16)
    return array
  }

  const randomUUID = () => {
    const bytes = getRandomValues(new U8(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20)
  }

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
    read: async (handle, options) => {
      const as = options?.as ?? "text"
      if (as === "bytes") return decode64(await ask("read", { id: idOf(handle), as: "base64" }))
      return ask("read", { id: idOf(handle), as })
    },
    keep: (value, options) => {
      if (value instanceof ArrayBuffer || isView(value)) {
        return ask("keep", {
          value: encode64(asBytes(value, "pcp.keep")),
          encoding: "base64",
          type: options?.type ?? "application/octet-stream",
          name: options?.name,
        })
      }
      if (options?.encoding === "base64") {
        return ask("keep", { value: String(value), encoding: "base64", type: options?.type, name: options?.name })
      }
      return ask("keep", {
        value: typeof value === "string" ? value : JSON.stringify(value),
        type: options?.type ?? (typeof value === "string" ? "text/plain" : "application/json"),
        name: options?.name,
      })
    },
    tools: (server) => ask("tools", { server: server ?? null }),
  })
  const log = (...values) => print(values.map(show).join(" "))

  Object.defineProperty(globalThis, "pcp", { value: pcp, enumerable: true })
  Object.defineProperty(globalThis, "console", {
    value: Object.freeze({ log, info: log, warn: log, error: log, debug: log }),
    enumerable: true,
  })
  Object.defineProperty(globalThis, "crypto", {
    value: Object.freeze({ getRandomValues, randomUUID }),
    enumerable: true,
  })
  for (const [name, value] of Object.entries({ atob, btoa, TextEncoder, TextDecoder })) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  }
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
 * ones to reach them quickly. Its memory is otherwise the owner's resource
 * setting (lib/core/resources/), read as each run starts.
 */
export function javaScriptExecutor({
  cpuMs = RUN_CPU_MS,
  memoryBytes,
}: { cpuMs?: number; memoryBytes?: number } = {}): Executor {
  return (input) =>
    runInQuickJs(input, {
      cpuMs,
      memoryBytes: memoryBytes ?? resourceLimits().programMemoryBytes,
    })
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
    // Dumping a thrown object runs its getters and toJSON, which are the
    // program's code: on its CPU budget, so one that never returns is
    // interrupted rather than holding the process.
    let value: unknown
    try {
      value = inGuest(() => vm.dump(thrown))
    } catch {
      value = undefined
    }
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

  const random = vm.newFunction("__pcp_random", (countHandle) => {
    const count =
      vm.typeof(countHandle) === "number" ? vm.getNumber(countHandle) : -1

    if (!Number.isInteger(count) || count < 0 || count > MAX_RANDOM_BYTES) {
      throw new RangeError(
        `Random bytes come ${MAX_RANDOM_BYTES} at most at once.`,
      )
    }

    return vm.newString(randomBytes(count).toString("hex"))
  })

  vm.setProp(vm.global, "__pcp_host", host)
  vm.setProp(vm.global, "__pcp_print", print)
  vm.setProp(vm.global, "__pcp_random", random)
  host.dispose()
  print.dispose()
  random.dispose()

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
        // The wrapper returns the program's value as JSON text, or null. Only
        // a string is read: dumping anything else (a program can replace
        // JSON.stringify) would run its code outside the CPU budget.
        const returned =
          vm.typeof(state.value) === "string" ? vm.getString(state.value) : null
        state.value.dispose()

        return ended({ kind: "done", returned })
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
