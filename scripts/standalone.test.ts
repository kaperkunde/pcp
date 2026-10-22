import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

import nextConfig, { patchrightBrowsersJson, sharpWasm } from "../next.config"

// The standalone output (the Docker image, the desktop app) holds only the
// files Next's tracing finds. patchright-core requires its browsers.json by
// a path it works out at runtime, which the tracing cannot follow; without
// the file, every import of patchright-core throws, so the browser never
// starts and installing Chromium says there is no build for the system.
// sharp (run_code's pcp.image) reads its WebAssembly the same way.

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

  it("carries sharp's WebAssembly, which its loader reads by path", () => {
    const included = nextConfig.outputFileTracingIncludes?.["/**"] ?? []

    expect(included).toContain(sharpWasm)
    expect(sharpWasm).toMatch(/sharp-wasm32-[\d.]+\.node\.wasm$/)
    expect(existsSync(path.join(root, sharpWasm))).toBe(true)
    expect(realpathSync(path.join(root, sharpWasm))).toBe(
      path.join(root, sharpWasm),
    )
  })

  it("leaves sharp's native builds out, so sharp runs as WebAssembly", async () => {
    const sharp = (await import("sharp")).default

    // Only the WebAssembly build says which Emscripten made it.
    expect(sharp.versions).toHaveProperty("emscripten")
  })
})
