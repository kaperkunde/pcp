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

  it("has a virtual display to run with windows on", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8")

    // display.ts starts it where PCP_CONTAINER is set, as the image sets.
    expect(dockerfile).toMatch(
      /apt-get install -y --no-install-recommends xvfb/,
    )
    expect(dockerfile).toMatch(/PCP_CONTAINER=1/)
  })

  it("is the full Chromium only: PCP never launches the headless shell", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8")

    expect(dockerfile).toMatch(
      /playwright-core@\$\{PLAYWRIGHT_VERSION\} install --with-deps --no-shell chromium/,
    )
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

// Port 3000 is plain HTTP. With PCP's own HTTPS on, it is published on
// 127.0.0.1 only: a published port skips the host's firewall (ufw), and the
// session cookie is not Secure over http. install.sh does the same
// (install.test.ts).
describe("the compose files' ports", () => {
  it("publish 3000 on every interface without HTTPS", () => {
    const compose = readFileSync(path.join(root, "docker-compose.yaml"), "utf8")

    expect(compose).toMatch(/^\s+- "3000:3000"$/m)
    expect(compose).not.toContain("127.0.0.1")
  })

  it("publish 3000 on 127.0.0.1 only, beside 80 and 443, with HTTPS", () => {
    const https = readFileSync(
      path.join(root, "docker-compose.https.yaml"),
      "utf8",
    )
    const ports = https.match(/^\s+ports: !override\n((?:\s+- ".*"\n?)+)/m)?.[1]

    // !override: a plain list would be added to the base file's 3000:3000.
    expect(ports?.match(/"(.*)"/g)).toEqual([
      '"127.0.0.1:3000:3000"',
      '"80:8080"',
      '"443:8443"',
    ])
    expect(https).not.toMatch(/"3000:3000"/)
  })
})
