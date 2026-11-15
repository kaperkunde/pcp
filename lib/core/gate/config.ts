import { z } from "zod"

import { invalid } from "../errors"
import {
  GATE_BOUNDS,
  GATE_DEFAULTS,
  type GateClass,
  type GateLimits,
} from "./limits"

/**
 * A server's own limits (lib/core/gate/): only what was set for it, each
 * field of GateLimits or left out; what is left out follows its class's
 * default (limits.ts GATE_DEFAULTS), so a better default reaches it. Kept
 * per server, encrypted (store.ts), the instance's own: never synced or
 * shared. The owner sets them on the server's page; an assistant proposes
 * them (register_server's `limits`, propose_server_limits) and they are
 * written only as the owner saved them.
 */
export type ServerLimits = Partial<GateLimits>

export const LIMIT_FIELDS = [
  "maxConcurrent",
  "minIntervalMs",
  "callsPerMinute",
  "timeoutMs",
  "bytesPerDay",
  "backoffBaseMs",
  "backoffMaxMs",
] as const satisfies ReadonlyArray<keyof GateLimits>

export type LimitField = (typeof LIMIT_FIELDS)[number]

/** Each field's name as an assistant writes it, and its words for people. */
export const LIMIT_WORDS: Record<
  LimitField,
  { arg: string; label: string; unit: "calls" | "ms" | "bytes" }
> = {
  maxConcurrent: {
    arg: "max_concurrent",
    label: "Calls at once",
    unit: "calls",
  },
  minIntervalMs: {
    arg: "min_interval_ms",
    label: "Pause between calls",
    unit: "ms",
  },
  callsPerMinute: {
    arg: "calls_per_minute",
    label: "Calls a minute",
    unit: "calls",
  },
  timeoutMs: { arg: "timeout_ms", label: "Time limit per call", unit: "ms" },
  bytesPerDay: { arg: "bytes_per_day", label: "Answers a day", unit: "bytes" },
  backoffBaseMs: {
    arg: "backoff_base_ms",
    label: "First cool-down",
    unit: "ms",
  },
  backoffMaxMs: {
    arg: "backoff_max_ms",
    label: "Longest cool-down",
    unit: "ms",
  },
}

/** The fields that may be "none" (no cap of their own). */
const NULLABLE: ReadonlySet<LimitField> = new Set([
  "callsPerMinute",
  "bytesPerDay",
])

const bounded = (field: LimitField) =>
  z.number().int().min(GATE_BOUNDS[field].min).max(GATE_BOUNDS[field].max)

const DESCRIPTIONS: Record<LimitField, string> = {
  maxConcurrent: `How many calls may run at once; more wait their turn. ${GATE_BOUNDS.maxConcurrent.min}-${GATE_BOUNDS.maxConcurrent.max}.`,
  minIntervalMs:
    "The least time, in milliseconds, between one call's start and the next one's.",
  callsPerMinute:
    'At most this many calls in any minute, or "none" for no cap of its own.',
  timeoutMs:
    "How long, in milliseconds, PCP waits for one call before it answers timeout.",
  bytesPerDay:
    'At most this many bytes of answers in a day, or "none" for no cap.',
  backoffBaseMs:
    "The first cool-down, in milliseconds, when the server asks PCP to slow down without saying how long; each one soon after is twice as long.",
  backoffMaxMs: "The longest cool-down, in milliseconds.",
}

/**
 * The `limits` an assistant passes (register_server, propose_server_limits):
 * snake_case, each field a number, "none" where a field may have no cap,
 * or "default" for its class's default. Left out: unchanged (a new server:
 * the default).
 */
export const LIMITS_ARG = z
  .strictObject(
    Object.fromEntries(
      LIMIT_FIELDS.map((field) => {
        const value = NULLABLE.has(field)
          ? z.union([bounded(field), z.enum(["none", "default"])])
          : z.union([bounded(field), z.literal("default")])

        return [
          LIMIT_WORDS[field].arg,
          value.optional().describe(DESCRIPTIONS[field]),
        ]
      }),
    ) as Record<string, z.ZodOptional<z.ZodType>>,
  )
  .describe(
    "Limits on how PCP calls this server, from its documentation or what you saw it do. The owner sees them beside the approval, may change them, and saves them with it; left out, PCP's defaults for its kind apply.",
  )

/** `limits` as LIMITS_ARG parsed it: its values are checked there. */
export type LimitsArg = Record<string, unknown>

/** A change to a server's limits: a value, null for none, "default" to unset. */
export type LimitsChange = Partial<
  Record<LimitField, number | null | "default">
>

/** An assistant's `limits`, as a change. */
export function limitsChangeOf(arg: LimitsArg | undefined): LimitsChange {
  const change: LimitsChange = {}

  for (const field of LIMIT_FIELDS) {
    const value = arg?.[LIMIT_WORDS[field].arg]

    if (value === "none") {
      change[field] = null
    } else if (value === "default" || typeof value === "number") {
      change[field] = value
    }
  }

  return change
}

/** Own limits with a change made. */
export function applyLimitsChange(
  own: ServerLimits,
  change: LimitsChange,
): ServerLimits {
  const next: ServerLimits = { ...own }

  for (const field of LIMIT_FIELDS) {
    if (!(field in change)) {
      continue
    }

    const value = change[field]

    if (value === "default" || value === undefined) {
      delete next[field]
    } else {
      ;(next as Record<LimitField, number | null>)[field] = value
    }
  }

  return checkLimits(next)
}

/**
 * Own limits checked: each field within the machine's bounds, "none" only
 * where a field may have no cap, the first cool-down no longer than the
 * longest. What the owner saves and what is read back pass here.
 */
export function checkLimits(input: unknown): ServerLimits {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalid("Limits are a set of numbers.")
  }

  const out: ServerLimits = {}
  const record = input as Record<string, unknown>

  for (const key of Object.keys(record)) {
    if (!(LIMIT_FIELDS as readonly string[]).includes(key)) {
      throw invalid(`There is no limit called ${key}.`)
    }
  }

  for (const field of LIMIT_FIELDS) {
    const value = record[field]

    if (value === undefined) {
      continue
    }

    const { label } = LIMIT_WORDS[field]

    if (value === null) {
      if (!NULLABLE.has(field)) {
        throw invalid(`${label} needs a number.`)
      }

      ;(out as Record<LimitField, number | null>)[field] = null
      continue
    }

    const { min, max } = GATE_BOUNDS[field]

    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < min ||
      value > max
    ) {
      throw invalid(
        `${label} is a whole number from ${showValue(field, min)} to ${showValue(field, max)}.`,
      )
    }

    ;(out as Record<LimitField, number | null>)[field] = value
  }

  const base = out.backoffBaseMs
  const most = out.backoffMaxMs

  if (base !== undefined && most !== undefined && base > most) {
    throw invalid("The first cool-down cannot be longer than the longest.")
  }

  return out
}

/** A class's defaults with a server's own limits over them. */
export function effectiveLimits(
  gateClass: GateClass,
  own: ServerLimits | null,
): GateLimits {
  const limits = { ...GATE_DEFAULTS[gateClass], ...(own ?? {}) }

  // A first cool-down set above the longest (one changed without the
  // other) is held to it.
  limits.backoffBaseMs = Math.min(limits.backoffBaseMs, limits.backoffMaxMs)
  return limits
}

/** Limits as an assistant reads them: snake_case, "none" for no cap. */
export function limitsArgOf(
  limits: ServerLimits,
): Record<string, number | "none"> {
  const out: Record<string, number | "none"> = {}

  for (const field of LIMIT_FIELDS) {
    const value = limits[field]

    if (value !== undefined) {
      out[LIMIT_WORDS[field].arg] = value === null ? "none" : value
    }
  }

  return out
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`
}

/** A duration in the largest unit it fits. */
export function showDuration(ms: number): string {
  if (ms === 0) return "none"
  if (ms % 3_600_000 === 0) return plural(ms / 3_600_000, "hour")
  if (ms % 60_000 === 0) return plural(ms / 60_000, "minute")
  if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000} s`
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)} s`
  return `${ms} ms`
}

/** A size in the largest unit that keeps it readable. */
export function showBytes(bytes: number): string {
  const units = ["bytes", "KiB", "MiB", "GiB", "TiB"]
  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }

  return unit === 0
    ? plural(bytes, "byte")
    : `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`
}

/** One limit's value in people's words. */
export function showValue(field: LimitField, value: number | null): string {
  if (value === null) {
    return "no cap"
  }

  switch (LIMIT_WORDS[field].unit) {
    case "ms":
      return showDuration(value)
    case "bytes":
      return showBytes(value)
    default:
      return value.toLocaleString("en")
  }
}

/**
 * The lines a change shows the owner, one per field it touches: what it is
 * now (the server's own, or the default) and what it would be.
 */
export function limitsChangeLines(
  gateClass: GateClass,
  before: ServerLimits,
  after: ServerLimits,
): string[] {
  const now = effectiveLimits(gateClass, before)
  const next = effectiveLimits(gateClass, after)
  const lines: string[] = []

  for (const field of LIMIT_FIELDS) {
    const was = field in before
    const will = field in after

    if (was === will && before[field] === after[field]) {
      continue
    }

    const from = `${showValue(field, now[field])}${was ? "" : " (PCP's default)"}`
    const to = `${showValue(field, next[field])}${will ? "" : " (PCP's default)"}`
    lines.push(`${LIMIT_WORDS[field].label}: ${from} → ${to}`)
  }

  return lines
}

/** Whether two sets of own limits are the same. */
export function sameLimits(a: ServerLimits, b: ServerLimits): boolean {
  return LIMIT_FIELDS.every(
    (field) => field in a === field in b && a[field] === b[field],
  )
}
