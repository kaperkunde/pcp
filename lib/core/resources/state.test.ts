import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getHostJson } from "../host-settings"
import { scratchDatabase } from "../test-db"
import { MB } from "./limits"
import {
  automaticResources,
  checkResourceConfig,
  chooseResources,
  EMPTY_CONFIG,
  getResourceConfig,
  limitsOf,
  loadResourceLimits,
  type Machine,
  RESOURCES_CONFIG_KEY,
  resourceLimits,
  saveResourceConfig,
} from "./state"

// Limits picked from the machine unless the owner set them, and never so
// large that PCP could take the machine down.

const GB = 1024 * MB
const laptop: Machine = {
  memoryBytes: 16 * GB,
  processors: 8,
  disk: { freeBytes: 200 * GB, totalBytes: 500 * GB },
}
const tiny: Machine = {
  memoryBytes: 1 * GB,
  processors: 1,
  disk: { freeBytes: 2 * GB, totalBytes: 8 * GB },
}

describe("what PCP picks itself", () => {
  it("follows the machine: memory, processors and free disk", () => {
    expect(chooseResources(EMPTY_CONFIG, laptop)).toEqual({
      programMemoryMb: 1024,
      programsAtOnce: 8,
      fileMb: 128,
      keptMb: 4096,
      browserIdleMinutes: 60,
    })
    expect(chooseResources(EMPTY_CONFIG, tiny)).toEqual({
      programMemoryMb: 128,
      programsAtOnce: 1,
      fileMb: 16,
      keptMb: 102,
      browserIdleMinutes: 60,
    })
  })

  it("picks the rest around what the owner set", () => {
    const config = { ...EMPTY_CONFIG, programMemoryMb: 2048 }

    expect(chooseResources(config, laptop)).toMatchObject({
      programMemoryMb: 2048,
      programsAtOnce: 4,
      fileMb: 256,
    })
    // What PCP would pick for the memory itself, with the rest as set.
    expect(automaticResources(config, laptop).programMemoryMb).toBe(1024)
  })

  it("keeps room for a file in a token's results, and guesses without a disk", () => {
    expect(
      chooseResources({ ...EMPTY_CONFIG, fileMb: 900 }, { ...tiny, disk: null })
        .keptMb,
    ).toBe(900)
  })

  it("passes no less than PCP always allowed, and the largest file as base64", () => {
    const small = limitsOf({
      programMemoryMb: 128,
      programsAtOnce: 1,
      fileMb: 1,
      keptMb: 10,
      browserIdleMinutes: 5,
    })
    expect(small).toMatchObject({
      textChars: 4_000_000,
      answerChars: 4_000_000,
      sandboxMessageBytes: 24 * MB,
      sandboxRequestBytes: 8 * MB,
      resolvedChars: 16_000_000,
    })

    const large = limitsOf({
      programMemoryMb: 1024,
      programsAtOnce: 2,
      fileMb: 100,
      keptMb: 1000,
      browserIdleMinutes: 60,
    })
    expect(large.answerChars).toBeGreaterThan(
      Buffer.alloc(100 * MB).toString("base64").length,
    )
    expect(large.sandboxMessageBytes).toBeGreaterThan(large.answerChars * 2)
  })

  it("keeps the browser open an hour idle, whatever the machine", () => {
    expect(limitsOf(chooseResources(EMPTY_CONFIG, tiny)).browserIdleMs).toBe(
      60 * 60_000,
    )
    expect(
      limitsOf(
        chooseResources({ ...EMPTY_CONFIG, browserIdleMinutes: 240 }, laptop),
      ).browserIdleMs,
    ).toBe(240 * 60_000)
    expect(
      automaticResources({ ...EMPTY_CONFIG, browserIdleMinutes: 240 }, laptop)
        .browserIdleMinutes,
    ).toBe(60)
  })
})

describe("what the owner may set", () => {
  it("holds each setting to its bounds", () => {
    expect(() =>
      checkResourceConfig({ ...EMPTY_CONFIG, programMemoryMb: 32 }, laptop),
    ).toThrow(/whole number from 64/)
    expect(() =>
      checkResourceConfig({ ...EMPTY_CONFIG, fileMb: 1.5 }, laptop),
    ).toThrow(/whole number/)
  })

  it("keeps the browser's idle close from 5 minutes to 8 hours", () => {
    for (const minutes of [5, 60, 480]) {
      expect(
        checkResourceConfig(
          { ...EMPTY_CONFIG, browserIdleMinutes: minutes },
          tiny,
        ).browserIdleMinutes,
      ).toBe(minutes)
    }
    for (const minutes of [0, 4, 481, 10.5]) {
      expect(() =>
        checkResourceConfig(
          { ...EMPTY_CONFIG, browserIdleMinutes: minutes },
          laptop,
        ),
      ).toThrow(/idle close \(minutes\) is a whole number from 5 to 480/)
    }
  })

  it("refuses programs that could hold most of the machine's memory together", () => {
    expect(() =>
      checkResourceConfig(
        { ...EMPTY_CONFIG, programMemoryMb: 4000, programsAtOnce: 4 },
        laptop,
      ),
    ).toThrow(/more than this machine can spare/)
    expect(
      checkResourceConfig(
        { ...EMPTY_CONFIG, programMemoryMb: 4000, programsAtOnce: 3 },
        laptop,
      ),
    ).toMatchObject({ programMemoryMb: 4000, programsAtOnce: 3 })
  })

  it("refuses kept results smaller than a file, or larger than the disk", () => {
    expect(() =>
      checkResourceConfig(
        { ...EMPTY_CONFIG, fileMb: 200, keptMb: 100 },
        laptop,
      ),
    ).toThrow(/at least the largest file/)
    expect(() =>
      checkResourceConfig({ ...EMPTY_CONFIG, keptMb: 9000 }, tiny),
    ).toThrow(/more than the whole disk/)
  })
})

describe("the settings", () => {
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ cleanup } = await scratchDatabase())
  })

  afterEach(async () => {
    await cleanup()
  })

  it("are saved as a host setting and used at once", async () => {
    await saveResourceConfig({
      ...EMPTY_CONFIG,
      fileMb: 3,
      keptMb: 50,
      browserIdleMinutes: 30,
    })

    expect(await getHostJson(RESOURCES_CONFIG_KEY)).toEqual({
      ...EMPTY_CONFIG,
      fileMb: 3,
      keptMb: 50,
      browserIdleMinutes: 30,
    })
    expect(resourceLimits()).toMatchObject({
      fileBytes: 3 * MB,
      keptBytesPerToken: 50 * MB,
      browserIdleMs: 30 * 60_000,
    })
  })

  it("read again after a minute, and drop what is no longer allowed", async () => {
    const { setHostJson } = await import("../host-settings")
    const before = await loadResourceLimits()

    await setHostJson(RESOURCES_CONFIG_KEY, {
      fileMb: 7,
      programsAtOnce: 999,
      browserIdleMinutes: 2,
    })

    expect(await loadResourceLimits()).toEqual(before)
    expect(await getResourceConfig()).toEqual({ ...EMPTY_CONFIG, fileMb: 7 })
    const later = await loadResourceLimits(Date.now() + 61_000)
    expect(later.fileBytes).toBe(7 * MB)
    expect(later.browserIdleMs).toBe(60 * 60_000)
  })
})
