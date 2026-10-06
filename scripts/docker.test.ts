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

// Next.js listens on :: in the image, IPv6 and IPv4 at once: rootless
// Podman's pasta hands an IPv6 connection to the container as IPv6, which a
// server on 0.0.0.0 resets. docker/start.cjs falls back to 0.0.0.0 where
// the kernel has no IPv6, since Next.js exits when its listen fails.
describe("the Docker image's listen address", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { listenHost } = require("../docker/start.cjs") as {
    listenHost: (hostname: string, ipv6: boolean) => string
  }

  it("is :: through docker/start.cjs", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8")

    expect(dockerfile).toMatch(/^\s+HOSTNAME=:: \\$/m)
    expect(dockerfile).toContain("COPY docker/start.cjs ./start.cjs")
    expect(dockerfile).toContain('CMD ["node", "start.cjs"]')
  })

  it("falls back to IPv4 only when the kernel has no IPv6", () => {
    expect(listenHost("::", true)).toBe("::")
    expect(listenHost("::", false)).toBe("0.0.0.0")
  })

  it("leaves a HOSTNAME the owner set alone", () => {
    expect(listenHost("0.0.0.0", true)).toBe("0.0.0.0")
    expect(listenHost("192.168.1.2", false)).toBe("192.168.1.2")
  })
})
