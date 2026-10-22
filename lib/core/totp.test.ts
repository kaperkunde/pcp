import { describe, expect, it } from "vitest"

import {
  decodeBase32,
  hotp,
  parseTotpSeed,
  totpCode,
  totpSeedProblem,
  type TotpAlgorithm,
} from "./totp"

// RFC 6238, Appendix B: the seeds are ASCII digits, 20, 32 and 64 bytes
// long for SHA1, SHA256 and SHA512, and the codes have eight digits.
const KEYS: Record<TotpAlgorithm, Buffer> = {
  SHA1: Buffer.from("12345678901234567890"),
  SHA256: Buffer.from("12345678901234567890123456789012"),
  SHA512: Buffer.from(
    "1234567890123456789012345678901234567890123456789012345678901234",
  ),
}

const VECTORS: Array<[number, TotpAlgorithm, string]> = [
  [59, "SHA1", "94287082"],
  [59, "SHA256", "46119246"],
  [59, "SHA512", "90693936"],
  [1111111109, "SHA1", "07081804"],
  [1111111109, "SHA256", "68084774"],
  [1111111109, "SHA512", "25091201"],
  [1111111111, "SHA1", "14050471"],
  [1111111111, "SHA256", "67062674"],
  [1111111111, "SHA512", "99943326"],
  [1234567890, "SHA1", "89005924"],
  [1234567890, "SHA256", "91819424"],
  [1234567890, "SHA512", "93441116"],
  [2000000000, "SHA1", "69279037"],
  [2000000000, "SHA256", "90698825"],
  [2000000000, "SHA512", "38618901"],
  [20000000000, "SHA1", "65353130"],
  [20000000000, "SHA256", "77737706"],
  [20000000000, "SHA512", "47863826"],
]

describe("totpCode", () => {
  it.each(VECTORS)(
    "at %i with %s gives %s (RFC 6238)",
    (time, algorithm, code) => {
      expect(
        totpCode(
          { key: KEYS[algorithm], algorithm, digits: 8, period: 30 },
          time * 1000,
        ).code,
      ).toBe(code)
    },
  )

  it("says how long the code has left", () => {
    const seed = {
      key: KEYS.SHA1,
      algorithm: "SHA1" as const,
      digits: 6,
      period: 30,
    }
    expect(totpCode(seed, 59_000).secondsLeft).toBe(1)
    expect(totpCode(seed, 60_000).secondsLeft).toBe(30)
  })
})

describe("hotp", () => {
  // RFC 4226, Appendix D.
  it("matches the HOTP vectors", () => {
    const key = Buffer.from("12345678901234567890")
    expect([0, 1, 2, 3, 9].map((counter) => hotp(key, counter))).toEqual([
      "755224",
      "287082",
      "359152",
      "969429",
      "520489",
    ])
  })
})

describe("parseTotpSeed", () => {
  // "12345678901234567890" in base32.
  const BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

  it("reads base32 in any case, with spaces and padding", () => {
    expect(decodeBase32("gezd gnbv gy3t qojq====")?.toString()).toBe(
      "1234567890",
    )
    const seed = parseTotpSeed(BASE32.toLowerCase().replace(/(.{4})/g, "$1 "))
    expect(seed).toMatchObject({ algorithm: "SHA1", digits: 6, period: 30 })
    expect(typeof seed !== "string" && seed.key.toString()).toBe(
      "12345678901234567890",
    )
  })

  it("reads an otpauth link: issuer, account, digits, period and algorithm", () => {
    const seed = parseTotpSeed(
      `otpauth://totp/Example%20Co:ada%40example.com?secret=${BASE32}&issuer=Example%20Co&algorithm=SHA256&digits=8&period=60`,
    )

    expect(seed).toMatchObject({
      algorithm: "SHA256",
      digits: 8,
      period: 60,
      issuer: "Example Co",
      account: "ada@example.com",
    })
  })

  it("takes the issuer from the label when the link has none", () => {
    expect(
      parseTotpSeed(`otpauth://totp/Shop:me?secret=${BASE32}`),
    ).toMatchObject({ issuer: "Shop", account: "me", algorithm: "SHA1" })
  })

  it("refuses what makes no codes", () => {
    expect(totpSeedProblem("")).toMatch(/Enter the seed/)
    expect(totpSeedProblem("not base32!")).toMatch(/base32/)
    expect(totpSeedProblem("GEZDGNBV")).toMatch(/too short/)
    expect(totpSeedProblem(`otpauth://hotp/x?secret=${BASE32}`)).toMatch(
      /time-based/,
    )
    expect(
      totpSeedProblem(`otpauth://totp/x?secret=${BASE32}&algorithm=MD5`),
    ).toMatch(/algorithm/)
    expect(
      totpSeedProblem(`otpauth://totp/x?secret=${BASE32}&digits=4`),
    ).toMatch(/digits/)
    expect(
      totpSeedProblem(`otpauth://totp/x?secret=${BASE32}&period=0`),
    ).toMatch(/seconds/)
    expect(totpSeedProblem("otpauth://totp/x")).toMatch(/base32/)
    expect(totpSeedProblem(BASE32)).toBeNull()
  })
})
