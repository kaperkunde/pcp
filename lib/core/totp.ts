import { createHmac } from "node:crypto"

/**
 * One-time codes from a seed (RFC 6238, TOTP over RFC 4226's HOTP), for a
 * `totp` secret: what the browser types for {"$secret": name} is the code
 * of the moment, worked out here from the seed, which never leaves PCP.
 * The seed is what a site shows when two-step sign-in is set up: base32
 * text, or an otpauth://totp/… link (the QR code's) that also names the
 * algorithm, the number of digits and how long a code lasts.
 *
 * This file reads no secret and touches no database.
 */

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512"

export type TotpSeed = {
  key: Buffer
  algorithm: TotpAlgorithm
  digits: number
  /** Seconds a code lasts. */
  period: number
  issuer: string | null
  account: string | null
}

const ALGORITHMS: readonly TotpAlgorithm[] = ["SHA1", "SHA256", "SHA512"]
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
/** RFC 4226 asks for 128 bits at least; 80 is what some sites still hand out. */
const MIN_KEY_BYTES = 10
const MAX_KEY_BYTES = 128
const MIN_DIGITS = 6
const MAX_DIGITS = 8
const MIN_PERIOD = 10
const MAX_PERIOD = 300

/** Bytes from base32 (RFC 4648), spaces and padding aside; null when it is not. */
export function decodeBase32(text: string): Buffer | null {
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase()

  if (!clean || !/^[A-Z2-7]+$/.test(clean)) {
    return null
  }

  const bytes: number[] = []
  let bits = 0
  let value = 0

  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char)
    bits += 5

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }

  return Buffer.from(bytes)
}

function keyProblem(key: Buffer | null): string | null {
  if (!key) {
    return "The seed is base32 (letters A to Z and digits 2 to 7), or an otpauth://totp/ link."
  }

  if (key.length < MIN_KEY_BYTES) {
    return "That seed is too short for one-time codes."
  }

  if (key.length > MAX_KEY_BYTES) {
    return "That seed is too long for one-time codes."
  }

  return null
}

function seedFromLink(value: string): TotpSeed | string {
  let url: URL

  try {
    url = new URL(value)
  } catch {
    return "That otpauth:// link does not read as an address."
  }

  if (url.protocol !== "otpauth:") {
    return "An otpauth link starts with otpauth://totp/."
  }

  if (url.hostname.toLowerCase() !== "totp") {
    return "Only time-based codes (otpauth://totp/) are taken, not counter-based ones (hotp)."
  }

  const params = url.searchParams
  const key = decodeBase32(params.get("secret") ?? "")
  const problem = keyProblem(key)

  if (problem) {
    return problem
  }

  const algorithm = (params.get("algorithm") ?? "SHA1").toUpperCase()

  if (!ALGORITHMS.includes(algorithm as TotpAlgorithm)) {
    return "The link's algorithm is SHA1, SHA256 or SHA512."
  }

  const digits = Number(params.get("digits") ?? "6")

  if (!Number.isInteger(digits) || digits < MIN_DIGITS || digits > MAX_DIGITS) {
    return `The link's codes have ${MIN_DIGITS} to ${MAX_DIGITS} digits.`
  }

  const period = Number(params.get("period") ?? "30")

  if (!Number.isInteger(period) || period < MIN_PERIOD || period > MAX_PERIOD) {
    return `The link's codes last ${MIN_PERIOD} to ${MAX_PERIOD} seconds.`
  }

  let label = ""

  try {
    label = decodeURIComponent(url.pathname.replace(/^\/+/, ""))
  } catch {
    label = ""
  }

  const colon = label.indexOf(":")
  const issuer =
    params.get("issuer")?.trim() ||
    (colon > 0 ? label.slice(0, colon).trim() : "") ||
    null
  const account = (colon >= 0 ? label.slice(colon + 1) : label).trim() || null

  return {
    key: key!,
    algorithm: algorithm as TotpAlgorithm,
    digits,
    period,
    issuer: issuer?.slice(0, 200) ?? null,
    account: account?.slice(0, 200) ?? null,
  }
}

/**
 * A seed as the owner entered it: base32 text, or an otpauth://totp/ link.
 * A string says what is wrong with it.
 */
export function parseTotpSeed(value: string): TotpSeed | string {
  const trimmed = value.trim()

  if (!trimmed) {
    return "Enter the seed: the base32 text, or the otpauth:// link."
  }

  if (/^otpauth:/i.test(trimmed)) {
    return seedFromLink(trimmed)
  }

  const key = decodeBase32(trimmed)
  const problem = keyProblem(key)

  return problem
    ? problem
    : {
        key: key!,
        algorithm: "SHA1",
        digits: 6,
        period: 30,
        issuer: null,
        account: null,
      }
}

/** What is wrong with a seed, or null when it makes codes. */
export function totpSeedProblem(value: string): string | null {
  const seed = parseTotpSeed(value)
  return typeof seed === "string" ? seed : null
}

/** RFC 4226's code for one counter value. */
export function hotp(
  key: Buffer,
  counter: number,
  {
    algorithm = "SHA1",
    digits = 6,
  }: Partial<Pick<TotpSeed, "algorithm" | "digits">> = {},
): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac(algorithm.toLowerCase(), key).update(message).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!

  return String(binary % 10 ** digits).padStart(digits, "0")
}

/** The code of the moment, and how many seconds it has left. */
export function totpCode(
  seed: Pick<TotpSeed, "key" | "algorithm" | "digits" | "period">,
  now = Date.now(),
): { code: string; secondsLeft: number } {
  const seconds = Math.floor(now / 1000)
  const counter = Math.floor(seconds / seed.period)

  return {
    code: hotp(seed.key, counter, seed),
    secondsLeft: seed.period - (seconds % seed.period),
  }
}
