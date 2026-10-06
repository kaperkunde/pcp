import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// The Chromium in the Docker image is the build the app's playwright-core
// drives: Playwright pins one Chromium per version, and another may not
// speak the same protocol.

const root = path.resolve(__dirname, "..")

describe("the Docker image's Chromium", () => {
  it("is installed by the same Playwright version the app depends on", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8")
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    const installed = dockerfile.match(/ARG PLAYWRIGHT_VERSION=(\S+)/)?.[1]

    expect(installed).toBe(pkg.dependencies["playwright-core"])
    expect(pkg.devDependencies["@playwright/test"]).toContain(installed)
  })
})
