import { describe, expect, it } from "vitest"

import { isDevBuild, isNewer, normalizeVersion, parseVersion } from "./semver"

describe("versions", () => {
  it("reads MAJOR.MINOR.PATCH, with or without a v", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3, null])
    expect(parseVersion("v0.10.0")).toEqual([0, 10, 0, null])
    expect(normalizeVersion(" v1.2.3 ")).toBe("1.2.3")
  })

  it("reads a build of develop", () => {
    expect(parseVersion("v1.2.3-dev.14")).toEqual([1, 2, 3, 14])
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3, null])
    expect(normalizeVersion("v0.5.0-dev.7")).toBe("0.5.0-dev.7")
    expect(isDevBuild("0.5.0-dev.7")).toBe(true)
    expect(isDevBuild("0.5.0")).toBe(false)
    expect(isDevBuild("garbage")).toBe(false)
  })

  it("reads nothing else as a version", () => {
    for (const text of [
      "",
      "1.2",
      "1.2.3.4",
      "1.2.3-rc.1",
      "1.2.3-dev",
      "1.2.3-dev.01",
      "1.2.3-dev.1.2",
      "1.2.3-dev.1+build",
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

  it("puts a develop build after the release before it and before its own", () => {
    expect(isNewer("0.4.3-dev.1", "0.4.2")).toBe(true)
    expect(isNewer("0.4.3", "0.4.3-dev.99")).toBe(true)
    expect(isNewer("0.4.3-dev.10", "0.4.3-dev.9")).toBe(true)
    expect(isNewer("0.4.3-dev.9", "0.4.3-dev.10")).toBe(false)
    expect(isNewer("0.4.3-dev.9", "0.4.3-dev.9")).toBe(false)
    expect(isNewer("0.4.3-dev.99", "0.4.3")).toBe(false)
    expect(isNewer("0.4.2", "0.4.3-dev.1")).toBe(false)
    expect(isNewer("0.5.0-dev.1", "0.4.3-dev.80")).toBe(true)
  })

  it("never counts garbage as newer", () => {
    expect(isNewer("latest", "0.1.3")).toBe(false)
    expect(isNewer("9.9.9", "dev")).toBe(false)
  })
})
