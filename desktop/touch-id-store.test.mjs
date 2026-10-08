import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  forgetDeviceKey,
  isDeviceKey,
  isPcpPage,
  KEYCHAIN,
  readDeviceKey,
  touchIdAnswers,
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
    expect(isPcpPage("http://127.0.0.1:3000/login", 3000)).toBe(true)
    expect(isPcpPage("http://127.0.0.1:3000/settings?x=1#y", 3000)).toBe(true)

    expect(isPcpPage("http://127.0.0.1:3001/login", 3000)).toBe(false)
    expect(isPcpPage("https://127.0.0.1:3000/login", 3000)).toBe(false)
    expect(isPcpPage("http://localhost:3000/login", 3000)).toBe(false)
    expect(isPcpPage("http://[::1]:3000/login", 3000)).toBe(false)
    expect(isPcpPage("http://127.0.0.1.example.com:3000/", 3000)).toBe(false)
    expect(isPcpPage("https://accounts.google.com/signin", 3000)).toBe(false)
    expect(isPcpPage("about:blank", 3000)).toBe(false)
    expect(isPcpPage("not a url", 3000)).toBe(false)
  })
})

// --- touchIdAnswers ---------------------------------------------------

const CANCELLED = -128

/** A keychain module that keeps its item in memory, like native/keychain. */
function fakeKeychain({ entitled = true, biometrics = true } = {}) {
  const keychain = {
    item: null,
    stale: false,
    readAnswer: null,
    reasons: [],
    status: () => ({
      biometrics,
      entitled,
      saved: keychain.item !== null,
      stale: keychain.item !== null && keychain.stale,
      code: keychain.item !== null ? 0 : KEYCHAIN.NOT_FOUND,
    }),
    store: vi.fn((key) => {
      keychain.item = key
      keychain.stale = false
      return KEYCHAIN.OK
    }),
    read: vi.fn(async (reason) => {
      keychain.reasons.push(reason)
      if (keychain.readAnswer) return keychain.readAnswer
      return keychain.item === null
        ? { code: KEYCHAIN.NOT_FOUND }
        : { code: KEYCHAIN.OK, key: keychain.item }
    }),
    remove: vi.fn(() => {
      keychain.item = null
      return KEYCHAIN.OK
    }),
  }
  return keychain
}

/** The safeStorage file, in memory. */
function fakeFile({ usable = true, key = null } = {}) {
  const file = {
    key,
    usable: () => usable,
    exists: () => file.key !== null,
    read: () => file.key,
    write: vi.fn((value) => {
      file.key = value
    }),
    forget: vi.fn(() => {
      file.key = null
    }),
  }
  return file
}

describe("touchIdAnswers, with the keychain item", () => {
  it("is chosen when the app is signed for it, and drops a file an earlier build kept", () => {
    const keychain = fakeKeychain()
    const file = fakeFile({ key: KEY })
    const answers = touchIdAnswers({ keychain, file, prompt: vi.fn() })

    expect(answers.mode).toBe("keychain")
    expect(file.forget).toHaveBeenCalled()
    expect(answers.status()).toEqual({ available: true, saved: false })
  })

  it("saves only after the owner's finger opened what it stored, and unlocks by reading it", async () => {
    const keychain = fakeKeychain()
    const prompt = vi.fn()
    const answers = touchIdAnswers({ keychain, file: fakeFile(), prompt })

    expect(await answers.save(KEY)).toBe(true)
    expect(keychain.reasons).toEqual(["turn on Touch ID for PCP"])
    expect(answers.status()).toEqual({ available: true, saved: true })

    expect(await answers.unlock("unlock")).toBe(KEY)
    expect(await answers.unlock("confirm")).toBe(KEY)
    expect(await answers.unlock("anything else")).toBe(KEY)
    expect(keychain.reasons.slice(1)).toEqual([
      "unlock PCP",
      "confirm it is you in PCP",
      "unlock PCP",
    ])
    // The keychain read is the Touch ID check: the app asks nothing itself.
    expect(prompt).not.toHaveBeenCalled()

    answers.forget()
    expect(answers.status().saved).toBe(false)
    expect(await answers.unlock("unlock")).toBeNull()
  })

  it("keeps the item when the owner cancels, and drops it once macOS voided it", async () => {
    const keychain = fakeKeychain()
    const answers = touchIdAnswers({
      keychain,
      file: fakeFile(),
      prompt: vi.fn(),
    })
    await answers.save(KEY)

    keychain.readAnswer = { code: CANCELLED }
    expect(await answers.unlock("unlock")).toBeNull()
    expect(keychain.remove).not.toHaveBeenCalled()
    expect(answers.status().saved).toBe(true)

    keychain.readAnswer = { code: KEYCHAIN.NOT_FOUND }
    expect(await answers.unlock("unlock")).toBeNull()
    expect(keychain.remove).toHaveBeenCalled()
    expect(answers.status().saved).toBe(false)
  })

  it("forgets the key once the fingerprints have changed", async () => {
    const keychain = fakeKeychain()
    const answers = touchIdAnswers({
      keychain,
      file: fakeFile(),
      prompt: vi.fn(),
    })
    await answers.save(KEY)

    keychain.stale = true
    expect(answers.status()).toEqual({ available: true, saved: false })
    expect(keychain.remove).toHaveBeenCalled()
    expect(await answers.unlock("unlock")).toBeNull()
    expect(keychain.read).toHaveBeenCalledTimes(1)
  })

  it("keeps nothing it cannot prove, and nothing that is not a key", async () => {
    const keychain = fakeKeychain()
    const answers = touchIdAnswers({
      keychain,
      file: fakeFile(),
      prompt: vi.fn(),
    })

    expect(await answers.save("a password")).toBe(false)
    expect(keychain.store).not.toHaveBeenCalled()

    keychain.readAnswer = { code: CANCELLED }
    expect(await answers.save(KEY)).toBe(false)
    expect(keychain.item).toBeNull()

    keychain.readAnswer = null
    keychain.store.mockReturnValueOnce(-34018)
    expect(await answers.save(KEY)).toBe(false)
    expect(keychain.read).toHaveBeenCalledTimes(1)
  })

  it("offers nothing while Touch ID cannot be used (the lid is closed)", async () => {
    const keychain = fakeKeychain({ biometrics: false })
    keychain.item = KEY
    const answers = touchIdAnswers({
      keychain,
      file: fakeFile(),
      prompt: vi.fn(),
    })

    expect(answers.status()).toEqual({ available: false, saved: false })
    expect(await answers.unlock("unlock")).toBeNull()
    expect(await answers.save(KEY)).toBe(false)
    expect(keychain.read).not.toHaveBeenCalled()
  })

  it("asks one question at a time", async () => {
    const keychain = fakeKeychain()
    keychain.item = KEY
    let release
    keychain.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ code: KEYCHAIN.OK, key: KEY })
        }),
    )
    const answers = touchIdAnswers({
      keychain,
      file: fakeFile(),
      prompt: vi.fn(),
    })

    const first = answers.unlock("unlock")
    expect(await answers.unlock("unlock")).toBeNull()
    expect(await answers.save(KEY)).toBe(false)
    release()
    expect(await first).toBe(KEY)
  })
})

describe("touchIdAnswers, with the file", () => {
  it("is chosen when the app is not signed for the keychain item, or has no module", () => {
    for (const keychain of [fakeKeychain({ entitled: false }), null]) {
      const file = fakeFile({ key: KEY })
      const answers = touchIdAnswers({ keychain, file, prompt: vi.fn() })
      expect(answers.mode).toBe("file")
      expect(file.forget).not.toHaveBeenCalled()
      expect(answers.status()).toEqual({ available: true, saved: true })
    }
  })

  it("hands the key over only after the app's own Touch ID prompt", async () => {
    const keychain = fakeKeychain({ entitled: false })
    const file = fakeFile()
    const prompt = vi.fn(async () => true)
    const answers = touchIdAnswers({ keychain, file, prompt })

    expect(await answers.save(KEY)).toBe(true)
    expect(file.key).toBe(KEY)
    expect(await answers.unlock("confirm")).toBe(KEY)
    expect(prompt.mock.calls).toEqual([
      ["turn on Touch ID for PCP"],
      ["confirm it is you in PCP"],
    ])
    expect(keychain.store).not.toHaveBeenCalled()
    expect(keychain.read).not.toHaveBeenCalled()

    prompt.mockResolvedValueOnce(false)
    expect(await answers.unlock("unlock")).toBeNull()
    expect(file.key).toBe(KEY)

    answers.forget()
    expect(answers.status().saved).toBe(false)
  })

  it("forgets a file it cannot read, and offers nothing where it cannot be used", async () => {
    const file = fakeFile({ key: KEY })
    file.read = () => null
    const answers = touchIdAnswers({
      keychain: null,
      file,
      prompt: vi.fn(async () => true),
    })
    expect(await answers.unlock("unlock")).toBeNull()
    expect(file.forget).toHaveBeenCalled()

    const unusable = touchIdAnswers({
      keychain: null,
      file: fakeFile({ usable: false, key: KEY }),
      prompt: vi.fn(async () => true),
    })
    expect(unusable.status()).toEqual({ available: false, saved: false })
    expect(await unusable.unlock("unlock")).toBeNull()
    expect(await unusable.save(KEY)).toBe(false)
  })
})
