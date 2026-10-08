/**
 * The bounds the owner's resource settings (lib/core/resources/) are held
 * to, and how PCP picks them itself from the machine it runs on. PCP is one
 * person's, on their own machine: its limits follow what that machine has,
 * and the owner can move them, but never so far that PCP could take the
 * machine down with it.
 */

export const MB = 1024 * 1024

/** What one setting may be, in its own unit. */
export type Bound = { min: number; max: number }

export const RESOURCE_BOUNDS = {
  /** Memory one run_code program may hold, in MB. WebAssembly's is 4 GiB at most. */
  programMemoryMb: { min: 64, max: 4000 },
  /** Programs running at once, every token's together. */
  programsAtOnce: { min: 1, max: 32 },
  /** The largest file PCP keeps, and so what a program reads of one, in MB. */
  fileMb: { min: 1, max: 2048 },
  /** What one token's kept results may hold together, in MB. */
  keptMb: { min: 10, max: 1_000_000 },
} satisfies Record<string, Bound>

/**
 * The most of the machine's memory the owner may give programs together
 * (each one's memory times how many run at once); the rest is PCP's own
 * and everything else on the machine.
 */
export const MAX_PROGRAMS_MEMORY_SHARE = 0.75

/** What PCP picks itself: */
/** each program gets a sixteenth of the machine's memory, */
export const AUTO_PROGRAM_MEMORY_SHARE = 1 / 16
export const AUTO_PROGRAM_MEMORY_MB: Bound = { min: 128, max: 1024 }
/** programs together half of it, and no more than one per processor, */
export const AUTO_PROGRAMS_MEMORY_SHARE = 0.5
export const AUTO_PROGRAMS_AT_ONCE: Bound = { min: 1, max: 8 }
/** a file an eighth of a program's memory (as base64, decoded, and copied), */
export const AUTO_FILE_SHARE = 1 / 8
export const AUTO_FILE_MB: Bound = { min: 10, max: 256 }
/** and a token's kept results a twentieth of the free disk. */
export const AUTO_KEPT_DISK_SHARE = 1 / 20
export const AUTO_KEPT_MB: Bound = { min: 50, max: 4096 }
/** When the disk cannot be read. */
export const FALLBACK_KEPT_MB = 500

/**
 * Below what the larger limits never go, whatever the file size: what PCP
 * always allowed for one text and one answer.
 */
export const MIN_TEXT_CHARS = 4_000_000
export const MIN_SANDBOX_MESSAGE_BYTES = 24 * MB
export const MIN_SANDBOX_REQUEST_BYTES = 8 * MB
export const MIN_RESOLVED_CHARS = 16_000_000

/** How long PCP trusts what it read of the settings and the machine. */
export const RESOURCES_TTL_MS = 60_000
