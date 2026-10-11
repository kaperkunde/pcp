import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import nextConfig, { patchrightBrowsersJson } from "../next.config"

// The standalone output (the Docker image, the desktop app) holds only the
// files Next's tracing finds. patchright-core requires its browsers.json by
// a path it works out at runtime, which the tracing cannot follow; without
// the file, every import of patchright-core throws, so the browser never
// starts and installing Chromium says there is no build for the system.

const root = path.resolve(__dirname, "..")

describe("the standalone output", () => {
  it("carries patchright-core's browsers.json for every route", () => {
    const included = nextConfig.outputFileTracingIncludes?.["/**"] ?? []

    expect(included).toContain(patchrightBrowsersJson)
    expect(existsSync(path.join(root, patchrightBrowsersJson))).toBe(true)
    // By its real path: through pnpm's link, the tracing would put a folder
    // with only this file where patchright-core should be.
    expect(realpathSync(path.join(root, patchrightBrowsersJson))).toBe(
      path.join(root, patchrightBrowsersJson),
    )
  })
})
