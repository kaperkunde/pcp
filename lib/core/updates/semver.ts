/**
 * MAJOR.MINOR.PATCH, the only form PCP releases take (scripts/version.mjs
 * makes them). A pre-release or build suffix is not a version PCP knows, so
 * it reads as garbage rather than as something to compare.
 */

export type Version = readonly [number, number, number]

// Up to nine digits a part: more would not stay exact as a number.
const VERSION = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim())

  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** "v1.2.3" and "1.2.3" are the same version; anything else is null. */
export function normalizeVersion(text: string): string | null {
  const version = parseVersion(text)

  return version ? version.join(".") : null
}

/** Whether `candidate` is a later release than `current`; garbage is never later. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)

  if (!a || !b) {
    return false
  }

  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] > b[i]
    }
  }

  return false
}
