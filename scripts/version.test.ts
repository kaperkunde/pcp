import { describe, expect, it } from "vitest"

import { bump, nextRelease } from "./version.mjs"

describe("nextRelease", () => {
  it("releases the package version when nothing has been released", () => {
    expect(nextRelease("0.1.0", [])).toBe("0.1.0")
  })

  it("raises the patch of the latest release", () => {
    expect(nextRelease("0.1.0", ["v0.1.0"])).toBe("0.1.1")
    expect(nextRelease("0.1.0", ["v0.1.0", "v0.1.1", "v0.1.2"])).toBe("0.1.3")
  })

  it("orders releases by number, not by text", () => {
    expect(nextRelease("0.1.0", ["v0.1.10", "v0.1.9", "v0.1.2"])).toBe("0.1.11")
  })

  it("releases a manual bump as written", () => {
    expect(nextRelease("0.2.0", ["v0.1.0", "v0.1.4"])).toBe("0.2.0")
    expect(nextRelease("1.0.0", ["v0.9.12"])).toBe("1.0.0")
  })

  it("continues from the bump once it is released", () => {
    expect(nextRelease("0.2.0", ["v0.1.4", "v0.2.0"])).toBe("0.2.1")
  })

  it("ignores tags that are not releases", () => {
    expect(
      nextRelease("0.1.0", ["v0.1.0", "v2", "v9.9.9-rc.1", "latest", "1.0.0"]),
    ).toBe("0.1.1")
  })

  it("refuses a package version that is not MAJOR.MINOR.PATCH", () => {
    expect(() => nextRelease("0.1.0.0", [])).toThrow()
  })
})

describe("bump", () => {
  it("raises minor and resets patch", () => {
    expect(bump("0.1.7", "minor")).toBe("0.2.0")
  })

  it("raises major and resets the rest", () => {
    expect(bump("0.4.3", "major")).toBe("1.0.0")
  })

  it("leaves patch to the release workflow", () => {
    expect(() => bump("0.1.0", "patch")).toThrow(/release workflow/)
    expect(() => bump("0.1.0", "huge")).toThrow()
  })
})
