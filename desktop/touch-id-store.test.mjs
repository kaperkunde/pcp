import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  forgetDeviceKey,
  isDeviceKey,
  isPcpPage,
  readDeviceKey,
  writeDeviceKey,
} from "./touch-id-store.mjs"

const KEY = `pcp_device_${"a1B2-_".repeat(7)}x`

// A stand-in for safeStorage: reversible, and visibly not the plain text.
const encrypt = (plain) => Buffer.from([...plain].reverse().join(""), "utf8")
const decrypt = (encrypted) =>
  [...encrypted.toString("utf8")].reverse().join("")

let folder
let file

beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), "pcp-touch-id-"))
  file = path.join(folder, "touch-id.bin")
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

describe("the Touch ID key's file", () => {
  it("keeps the key encrypted, for this user alone, and reads it back", () => {
    expect(readDeviceKey(file, decrypt)).toBeNull()

    writeDeviceKey(file, KEY, encrypt)
    expect(readDeviceKey(file, decrypt)).toBe(KEY)
    expect(readDeviceKey(file, (bytes) => bytes.toString("utf8"))).toBeNull()
    expect(existsSync(`${file}.partial`)).toBe(false)
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }

    forgetDeviceKey(file)
    expect(readDeviceKey(file, decrypt)).toBeNull()
    forgetDeviceKey(file)
  })

  it("counts a file it cannot decrypt, or that holds no key, as no key", () => {
    writeFileSync(file, "garbage")
    expect(readDeviceKey(file, decrypt)).toBeNull()
    expect(
      readDeviceKey(file, () => {
        throw new Error("The keychain said no.")
      }),
    ).toBeNull()
  })

  it("keeps nothing that is not a Touch ID key", () => {
    for (const value of [
      "",
      "a password",
      `pcp_recovery_${"a".repeat(43)}`,
      `pcp_${"a".repeat(43)}`,
      KEY.slice(0, -1),
      `${KEY}a`,
      `${KEY}\n`,
      null,
      42,
    ]) {
      expect(isDeviceKey(value)).toBe(false)
    }

    expect(isDeviceKey(KEY)).toBe(true)
    expect(() => writeDeviceKey(file, "a password", encrypt)).toThrow()
    expect(existsSync(file)).toBe(false)
  })
})

describe("isPcpPage", () => {
  it("is PCP's own pages in the window, and nothing else", () => {
    expect(isPcpPage("http://localhost:3000/login", 3000)).toBe(true)
    expect(isPcpPage("http://localhost:3000/settings?x=1#y", 3000)).toBe(true)

    expect(isPcpPage("http://localhost:3001/login", 3000)).toBe(false)
    expect(isPcpPage("https://localhost:3000/login", 3000)).toBe(false)
    expect(isPcpPage("http://127.0.0.1:3000/login", 3000)).toBe(false)
    expect(isPcpPage("http://localhost.example.com:3000/", 3000)).toBe(false)
    expect(isPcpPage("https://accounts.google.com/signin", 3000)).toBe(false)
    expect(isPcpPage("about:blank", 3000)).toBe(false)
    expect(isPcpPage("not a url", 3000)).toBe(false)
  })
})
