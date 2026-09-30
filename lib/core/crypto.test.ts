import { describe, expect, it } from "vitest"

import {
  CryptoError,
  decrypt,
  decryptString,
  deriveKek,
  encrypt,
  encryptString,
  generateDek,
  newHkdfParams,
  newScryptParams,
  parseKdfParams,
  randomSecret,
  safeEqual,
  sha256Hex,
  unwrapDek,
  wrapDek,
} from "./crypto"

describe("envelope encryption", () => {
  it("round-trips a value under the data key", () => {
    const dek = generateDek()
    const blob = encryptString(dek, "hunter2", "secret:1")

    expect(decryptString(dek, blob, "secret:1")).toBe("hunter2")
    // Random nonce: the same value never encrypts to the same bytes.
    expect(encryptString(dek, "hunter2", "secret:1").equals(blob)).toBe(false)
  })

  it("refuses the wrong key, the wrong row and tampering", () => {
    const dek = generateDek()
    const blob = encryptString(dek, "hunter2", "secret:1")

    expect(() => decrypt(generateDek(), blob, "secret:1")).toThrow(CryptoError)
    expect(() => decrypt(dek, blob, "secret:2")).toThrow(CryptoError)

    const tampered = Buffer.from(blob)
    tampered[tampered.length - 1] ^= 0x01
    expect(() => decrypt(dek, tampered, "secret:1")).toThrow(CryptoError)
    expect(() => decrypt(dek, Buffer.alloc(4), "secret:1")).toThrow(CryptoError)
  })

  it("handles empty and binary plaintext", () => {
    const dek = generateDek()
    expect(decrypt(dek, encrypt(dek, Buffer.alloc(0), "x"), "x")).toHaveLength(
      0,
    )
    const bytes = Buffer.from([0, 255, 1, 254, 10, 13])
    expect(decrypt(dek, encrypt(dek, bytes, "x"), "x").equals(bytes)).toBe(true)
  })
})

describe("key grants", () => {
  it("wraps the data key under a password and unwraps it with the same one", async () => {
    const dek = generateDek()
    const params = newScryptParams()
    const kek = await deriveKek("correct horse battery staple", params)
    const wrapped = wrapDek(dek, kek, "grant-1")

    const again = await deriveKek(
      "correct horse battery staple",
      parseKdfParams(JSON.stringify(params)),
    )
    expect(unwrapDek(wrapped, again, "grant-1").equals(dek)).toBe(true)

    const wrong = await deriveKek("correct horse battery stable", params)
    expect(() => unwrapDek(wrapped, wrong, "grant-1")).toThrow(CryptoError)
    // A grant's wrapped key is bound to that grant's id.
    expect(() => unwrapDek(wrapped, again, "grant-2")).toThrow(CryptoError)
  })

  it("wraps the data key under a random credential through HKDF", async () => {
    const dek = generateDek()
    const token = randomSecret()
    const params = newHkdfParams()
    const wrapped = wrapDek(dek, await deriveKek(token, params), "grant-3")

    expect(
      unwrapDek(wrapped, await deriveKek(token, params), "grant-3").equals(dek),
    ).toBe(true)
    expect(() => unwrapDek(wrapped, Buffer.alloc(32), "grant-3")).toThrow(
      CryptoError,
    )
    // Different salt, different key: the same token cannot open another
    // grant's wrapping by accident.
    const otherParams = newHkdfParams()
    await expect(
      (async () =>
        unwrapDek(wrapped, await deriveKek(token, otherParams), "grant-3"))(),
    ).rejects.toThrow(CryptoError)
  })

  it("rejects malformed kdf parameters", () => {
    expect(() => parseKdfParams('{"kdf":"argon2"}')).toThrow(CryptoError)
    expect(() => parseKdfParams('{"kdf":"scrypt","salt":"x"}')).toThrow(
      CryptoError,
    )
  })
})

describe("helpers", () => {
  it("hashes and compares in constant time", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
    expect(safeEqual("a", "a")).toBe(true)
    expect(safeEqual("a", "b")).toBe(false)
    expect(safeEqual("a", "ab")).toBe(false)
  })

  it("makes URL-safe secrets with 256 bits of entropy", () => {
    const secret = randomSecret()
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomSecret()).not.toBe(secret)
  })
})
