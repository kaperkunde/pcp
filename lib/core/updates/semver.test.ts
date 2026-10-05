import { describe, expect, it } from "vitest"

import { isNewer, normalizeVersion, parseVersion } from "./semver"

describe("versions", () => {
  it("reads MAJOR.MINOR.PATCH, with or without a v", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3])
    expect(parseVersion("v0.10.0")).toEqual([0, 10, 0])
    expect(normalizeVersion(" v1.2.3 ")).toBe("1.2.3")
  })

  it("reads nothing else as a version", () => {
    for (const text of [
      "",
      "1.2",
      "1.2.3.4",
      "1.2.3-rc.1",
      "1.2.3+build",
      "01.2.3",
      "latest",
      "1.2.x",
      "9999999999.0.0",
      "v v1.2.3",
    ]) {
      expect(parseVersion(text)).toBeNull()
    }
  })

  it("orders by number, not by text", () => {
    expect(isNewer("0.1.10", "0.1.9")).toBe(true)
    expect(isNewer("0.2.0", "0.1.99")).toBe(true)
    expect(isNewer("1.0.0", "0.99.99")).toBe(true)
    expect(isNewer("0.1.9", "0.1.10")).toBe(false)
  })

  it("does not count the same version, or a build ahead of it, as newer", () => {
    expect(isNewer("0.1.3", "0.1.3")).toBe(false)
    expect(isNewer("0.1.3", "0.2.0")).toBe(false)
  })

  it("never counts garbage as newer", () => {
    expect(isNewer("latest", "0.1.3")).toBe(false)
    expect(isNewer("9.9.9", "dev")).toBe(false)
  })
})
