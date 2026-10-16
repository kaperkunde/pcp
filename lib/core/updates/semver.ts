/**
 * MAJOR.MINOR.PATCH, the form PCP's releases take, and MAJOR.MINOR.PATCH-dev.N,
 * a build of develop on its way to that release (scripts/version.mjs makes
 * both). Any other pre-release or build suffix is not a version PCP knows, so
 * it reads as garbage rather than as something to compare.
 */

/** The three numbers, and the develop build's number (null for a release). */
export type Version = readonly [number, number, number, number | null]

// Up to nine digits a part: more would not stay exact as a number.
const PART = "(0|[1-9]\\d{0,8})"
const VERSION = new RegExp(`^v?${PART}\\.${PART}\\.${PART}(?:-dev\\.${PART})?$`)

export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim())

  return match
    ? [
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        match[4] === undefined ? null : Number(match[4]),
      ]
    : null
}

/** "v1.2.3" and "1.2.3" are the same version; anything else is null. */
export function normalizeVersion(text: string): string | null {
  const version = parseVersion(text)

  if (!version) {
    return null
  }

  const [major, minor, patch, dev] = version
  const release = `${major}.${minor}.${patch}`

  return dev === null ? release : `${release}-dev.${dev}`
}

/** A build of develop rather than a release. */
export function isDevBuild(text: string): boolean {
  const version = parseVersion(text)

  return version !== null && version[3] !== null
}

/**
 * Whether `candidate` is later than `current`; garbage is never later. A
 * develop build comes before the release it leads to (1.2.3-dev.9 < 1.2.3)
 * and after the one before (1.2.2 < 1.2.3-dev.1).
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)

  if (!a || !b) {
    return false
  }

  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i]! > b[i]!
    }
  }

  const [devA, devB] = [a[3], b[3]]

  if (devA === devB) {
    return false
  }

  return devA === null || (devB !== null && devA > devB)
}
