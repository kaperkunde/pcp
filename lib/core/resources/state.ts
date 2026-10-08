import { statfsSync } from "node:fs"
import os from "node:os"

import { dataDir } from "../data-dir"
import { invalid } from "../errors"
import { getHostJson, setHostJson } from "../host-settings"
import {
  AUTO_FILE_MB,
  AUTO_FILE_SHARE,
  AUTO_KEPT_DISK_SHARE,
  AUTO_KEPT_MB,
  AUTO_PROGRAM_MEMORY_MB,
  AUTO_PROGRAM_MEMORY_SHARE,
  AUTO_PROGRAMS_AT_ONCE,
  AUTO_PROGRAMS_MEMORY_SHARE,
  type Bound,
  FALLBACK_KEPT_MB,
  MAX_PROGRAMS_MEMORY_SHARE,
  MB,
  MIN_RESOLVED_CHARS,
  MIN_SANDBOX_MESSAGE_BYTES,
  MIN_SANDBOX_REQUEST_BYTES,
  MIN_TEXT_CHARS,
  RESOURCE_BOUNDS,
  RESOURCES_TTL_MS,
} from "./limits"

/**
 * How much of the machine PCP may use for what assistants hand it: the
 * memory and number of run_code programs, the largest file it keeps (and so
 * what a program reads of one), and what one token's kept results may hold.
 *
 * Each is picked from the machine (its memory, as the container allows it,
 * its processors, the free disk where PCP keeps its data) unless the owner
 * set it in Settings. A host setting, `resources.config`: it is the
 * machine's, read with no credential, and nothing of the vault is in it.
 *
 * The rest of lib/core reads the limits with `resourceLimits()`, which is
 * synchronous and answers from what was last read; `loadResourceLimits()`
 * reads again when that is more than a minute old, and is called where the
 * limits matter (a run starting, a result being kept).
 */

export const RESOURCES_CONFIG_KEY = "resources.config"

const FIELDS = [
  "programMemoryMb",
  "programsAtOnce",
  "fileMb",
  "keptMb",
] as const

export type ResourceField = (typeof FIELDS)[number]

/** The owner's choice: null for "let PCP pick". */
export type ResourceConfig = Record<ResourceField, number | null>

/** What is used, each in its setting's unit. */
export type ResourceChoice = Record<ResourceField, number>

export type Machine = {
  /** Memory this process may use: the machine's, or its container's limit. */
  memoryBytes: number
  processors: number
  /** Where PCP keeps its data; null when it cannot be read. */
  disk: { freeBytes: number; totalBytes: number } | null
}

/** The limits as the code uses them. */
export type ResourceLimits = {
  /** One run_code program's memory (QuickJS's WebAssembly memory). */
  programMemoryBytes: number
  /** run_code programs at once, every token's together. */
  programsAtOnce: number
  /** The largest file kept; a larger one is refused, not cut. */
  fileBytes: number
  /** The most kept of one text; past it the rest is dropped and said so. */
  textChars: number
  /**
   * The most of one answer, or one read, a program is handed, and of one
   * call's arguments, in characters of JSON: the largest file as base64.
   */
  answerChars: number
  /** One token's kept results together. */
  keptBytesPerToken: number
  /** One message between PCP and the sandbox's runner. */
  sandboxMessageBytes: number
  /** One request a sandboxed program sends its runner. */
  sandboxRequestBytes: number
  /** What all the handles in one call's arguments may add up to. */
  resolvedChars: number
}

export const EMPTY_CONFIG: ResourceConfig = {
  programMemoryMb: null,
  programsAtOnce: null,
  fileMb: null,
  keptMb: null,
}

function clamp(value: number, { min, max }: Bound): number {
  return Math.min(max, Math.max(min, value))
}

/** What the machine has, read now. */
export function readMachine(): Machine {
  const total = os.totalmem()
  // A container's memory limit, where the process has one (cgroups).
  const constrained =
    typeof process.constrainedMemory === "function"
      ? process.constrainedMemory()
      : 0
  const memoryBytes =
    constrained > 0 && constrained < total ? constrained : total
  let disk: Machine["disk"] = null

  try {
    const stats = statfsSync(dataDir())
    disk = {
      freeBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
    }
  } catch {
    // The folder is not there yet, or the system does not say.
  }

  return {
    memoryBytes,
    processors: Math.max(1, os.availableParallelism()),
    disk,
  }
}

/** The owner's choice where they made one, PCP's own pick for the rest. */
export function chooseResources(
  config: ResourceConfig,
  machine: Machine,
): ResourceChoice {
  const memoryMb = machine.memoryBytes / MB
  const programMemoryMb =
    config.programMemoryMb ??
    clamp(
      Math.floor((memoryMb * AUTO_PROGRAM_MEMORY_SHARE) / 64) * 64,
      AUTO_PROGRAM_MEMORY_MB,
    )
  const programsAtOnce =
    config.programsAtOnce ??
    clamp(
      Math.min(
        machine.processors,
        Math.floor((memoryMb * AUTO_PROGRAMS_MEMORY_SHARE) / programMemoryMb),
      ),
      AUTO_PROGRAMS_AT_ONCE,
    )
  const fileMb =
    config.fileMb ??
    clamp(Math.floor(programMemoryMb * AUTO_FILE_SHARE), AUTO_FILE_MB)
  const keptMb =
    config.keptMb ??
    Math.max(
      fileMb,
      machine.disk
        ? clamp(
            Math.floor((machine.disk.freeBytes / MB) * AUTO_KEPT_DISK_SHARE),
            AUTO_KEPT_MB,
          )
        : FALLBACK_KEPT_MB,
    )

  return { programMemoryMb, programsAtOnce, fileMb, keptMb }
}

/** What PCP would pick for each setting, given the owner's other ones. */
export function automaticResources(
  config: ResourceConfig,
  machine: Machine,
): ResourceChoice {
  return Object.fromEntries(
    FIELDS.map((field) => [
      field,
      chooseResources({ ...config, [field]: null }, machine)[field],
    ]),
  ) as ResourceChoice
}

export function limitsOf(choice: ResourceChoice): ResourceLimits {
  const fileBytes = choice.fileMb * MB
  // A file's bytes as base64, with room for the JSON around them.
  const answerChars = Math.max(
    MIN_TEXT_CHARS,
    Math.ceil(fileBytes / 3) * 4 + 64 * 1024,
  )

  return {
    programMemoryBytes: choice.programMemoryMb * MB,
    programsAtOnce: choice.programsAtOnce,
    fileBytes,
    textChars: Math.max(MIN_TEXT_CHARS, fileBytes),
    answerChars,
    keptBytesPerToken: choice.keptMb * MB,
    // JSON may escape a text's characters to twice their length.
    sandboxMessageBytes: Math.max(
      MIN_SANDBOX_MESSAGE_BYTES,
      answerChars * 2 + MB,
    ),
    sandboxRequestBytes: Math.max(MIN_SANDBOX_REQUEST_BYTES, answerChars + MB),
    resolvedChars: Math.max(MIN_RESOLVED_CHARS, answerChars * 2),
  }
}

const LABELS: Record<ResourceField, string> = {
  programMemoryMb: "A program's memory",
  programsAtOnce: "Programs at once",
  fileMb: "The largest file",
  keptMb: "Kept results per token",
}

function megabytes(mb: number): string {
  return mb >= 1024 && mb % 1024 === 0
    ? `${(mb / 1024).toLocaleString("en")} GB`
    : `${mb.toLocaleString("en")} MB`
}

/**
 * The owner's choice as it may be saved on this machine, or why not: each
 * within its bounds, programs together within most of the machine's memory,
 * and kept results within the disk and room for the largest file.
 */
export function checkResourceConfig(
  config: ResourceConfig,
  machine: Machine,
): ResourceConfig {
  const checked = { ...EMPTY_CONFIG }

  for (const field of FIELDS) {
    const value = config[field]

    if (value === null) {
      continue
    }

    const { min, max } = RESOURCE_BOUNDS[field]

    if (!Number.isInteger(value) || value < min || value > max) {
      throw invalid(
        `${LABELS[field]} is a whole number from ${min.toLocaleString("en")} to ${max.toLocaleString("en")}.`,
      )
    }

    checked[field] = value
  }

  const chosen = chooseResources(checked, machine)
  const together = chosen.programMemoryMb * chosen.programsAtOnce
  const allowed = Math.floor(
    (machine.memoryBytes / MB) * MAX_PROGRAMS_MEMORY_SHARE,
  )

  if (together > allowed) {
    throw invalid(
      `${chosen.programsAtOnce} programs of ${megabytes(chosen.programMemoryMb)} could hold ${megabytes(together)} together, more than this machine can spare (${megabytes(allowed)} of its ${megabytes(Math.floor(machine.memoryBytes / MB))}). Give each less memory, or run fewer at once.`,
    )
  }

  if (chosen.keptMb < chosen.fileMb) {
    throw invalid(
      `Kept results per token (${megabytes(chosen.keptMb)}) have to hold at least the largest file (${megabytes(chosen.fileMb)}).`,
    )
  }

  if (
    checked.keptMb !== null &&
    machine.disk &&
    checked.keptMb > machine.disk.totalBytes / MB
  ) {
    throw invalid(
      `Kept results per token (${megabytes(checked.keptMb)}) cannot be more than the whole disk (${megabytes(Math.floor(machine.disk.totalBytes / MB))}).`,
    )
  }

  return checked
}

/** The owner's choice, with what is missing or no longer allowed as PCP's pick. */
export async function getResourceConfig(): Promise<ResourceConfig> {
  const stored =
    await getHostJson<Partial<Record<ResourceField, unknown>>>(
      RESOURCES_CONFIG_KEY,
    )
  const config = { ...EMPTY_CONFIG }

  for (const field of FIELDS) {
    const value = stored?.[field]
    const { min, max } = RESOURCE_BOUNDS[field]

    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= min &&
      value <= max
    ) {
      config[field] = value
    }
  }

  return config
}

type Cache = {
  config: ResourceConfig
  machine: Machine
  limits: ResourceLimits
  /** When the settings were read; 0 for never. */
  at: number
}

const CACHE = Symbol.for("pcp.resources")

/**
 * Kept on globalThis: instrumentation.ts, the gateway's routes and the
 * Server Actions are bundled apart and would each have their own copy.
 */
function holder(): { [CACHE]?: Cache } {
  return globalThis as unknown as { [CACHE]?: Cache }
}

/**
 * Uses a choice at once, as saving does, without the database (tests of
 * code that reads the limits and touches no database).
 */
export function useResourceConfig(config: ResourceConfig): ResourceLimits {
  return remember(config, Date.now()).limits
}

function remember(config: ResourceConfig, at: number): Cache {
  const machine = readMachine()
  const cache = {
    config,
    machine,
    limits: limitsOf(chooseResources(config, machine)),
    at,
  }
  holder()[CACHE] = cache

  return cache
}

/**
 * The limits in force, from what was last read. Before the settings were
 * ever read, PCP's own picks for this machine.
 */
export function resourceLimits(): ResourceLimits {
  return (holder()[CACHE] ?? remember(EMPTY_CONFIG, 0)).limits
}

/** The limits, read again when what was read is more than a minute old. */
export async function loadResourceLimits(
  now = Date.now(),
): Promise<ResourceLimits> {
  const cache = holder()[CACHE]

  if (cache && cache.at > 0 && now - cache.at < RESOURCES_TTL_MS) {
    return cache.limits
  }

  return remember(await getResourceConfig(), now).limits
}

export async function saveResourceConfig(
  config: ResourceConfig,
): Promise<void> {
  const checked = checkResourceConfig(config, readMachine())
  await setHostJson(RESOURCES_CONFIG_KEY, checked)
  remember(checked, Date.now())
}

/** Drops what was read, so the next read is fresh (a new database in tests). */
export function forgetResourceLimits(): void {
  delete holder()[CACHE]
}

/** What the settings page shows. */
export type ResourcesOverview = {
  config: ResourceConfig
  chosen: ResourceChoice
  automatic: ResourceChoice
  machine: Machine
  limits: ResourceLimits
  bounds: typeof RESOURCE_BOUNDS
  maxProgramsMemoryMb: number
}

export async function resourcesOverview(): Promise<ResourcesOverview> {
  const config = await getResourceConfig()
  const { machine, limits } = remember(config, Date.now())

  return {
    config,
    chosen: chooseResources(config, machine),
    automatic: automaticResources(config, machine),
    machine,
    limits,
    bounds: RESOURCE_BOUNDS,
    maxProgramsMemoryMb: Math.floor(
      (machine.memoryBytes / MB) * MAX_PROGRAMS_MEMORY_SHARE,
    ),
  }
}
