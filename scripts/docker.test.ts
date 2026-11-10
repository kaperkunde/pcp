import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

// The Chromium in the Docker image is the build the app's patchright-core
// drives: Playwright pins one Chromium per version, and another may not
// speak the same protocol. patchright-core follows Playwright's releases
// number for number, and @playwright/test (the e2e suite, and CI's
// Chromium) stays on the same one, so a bump of either is a bump of both
// and of the Dockerfile.

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

    expect(installed).toBe(pkg.dependencies["patchright-core"])
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

  // kaperkunde/pcp#38: a site's check read only Playwright's test fonts and
  // SwiftShader's WebGL.
  it("has a desktop's fonts, indexed once", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8")
    const install = dockerfile.match(
      /apt-get install -y --no-install-recommends xvfb([^&]*)&&/,
    )?.[1]

    for (const font of [
      "fontconfig",
      "fonts-dejavu-core",
      "fonts-noto-core",
      "fonts-cantarell",
    ]) {
      expect(install?.split(/\s+/)).toContain(font)
    }
    expect(dockerfile).toMatch(/&& fc-cache -f \\/)
  })

  it("has Mesa's Vulkan drivers for a GPU the container is given, without its software one", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8")
    const install = dockerfile.match(
      /apt-get install -y --no-install-recommends xvfb([^&]*)&&/,
    )?.[1]

    expect(install?.split(/\s+/)).toEqual(
      expect.arrayContaining(["mesa-vulkan-drivers", "libvulkan1"]),
    )
    // Lavapipe would be picked on a card Mesa has no driver for, and
    // Chromium blocks it as software: no WebGL at all instead of
    // SwiftShader's.
    expect(dockerfile).toContain(
      "&& rm -f /usr/share/vulkan/icd.d/lvp_icd.*.json \\",
    )
  })

  it("is the full Chromium only: PCP never launches the headless shell", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8")

    expect(dockerfile).toMatch(
      /patchright-core@\$\{PLAYWRIGHT_VERSION\} install --with-deps --no-shell chromium/,
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

// #100: what PCP's browser keeps in /tmp while it runs (downloads,
// Chromium's folders, its shared memory under --disable-dev-shm-usage) is in
// memory only, as install.sh does it (install.test.ts).
describe("the compose file's /tmp", () => {
  it("is a tmpfs with a size, for the pcp service", () => {
    const compose = parse(
      readFileSync(path.join(root, "docker-compose.yaml"), "utf8"),
    ) as { services: { pcp: { tmpfs?: string[] } } }
    const install = readFileSync(path.join(root, "install.sh"), "utf8")
    const tmpfs = "/tmp:rw,nosuid,nodev,noexec,mode=1777,size=1g"

    expect(compose.services.pcp.tmpfs).toEqual([tmpfs])
    expect(install).toContain(`TMPFS="${tmpfs}"`)
  })
})

// install.sh's update reads the installer out of the image it pulled and runs
// it in place of the copy it saved at install time, so an existing install
// gets the unit the new version's installer writes (kaperkunde/pcp#38: the
// graphics card). install.test.ts covers the reading.
describe("the Docker image's installer", () => {
  it("is install.sh, root's and read-only, where install.sh reads it", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8")
    const runner = dockerfile.slice(dockerfile.indexOf("FROM base AS runner"))
    const installer = readFileSync(path.join(root, "install.sh"), "utf8")

    expect(runner).toMatch(/^WORKDIR \/app$/m)
    expect(runner).toMatch(/^COPY --chmod=0644 install\.sh \.\/install\.sh$/m)
    expect(installer).toContain('IMAGE_INSTALLER="/app/install.sh"')
    expect(installer).toMatch(/^# pcp-installer-format: 1$/m)
  })

  it("is not left out of the build context", () => {
    const ignored = readFileSync(path.join(root, ".dockerignore"), "utf8")

    expect(ignored.split("\n")).not.toContain("install.sh")
  })
})

// #98: the images are signed by the workflow that builds them, keyless with
// GitHub's OIDC, and install.sh accepts only that workflow's signature. The
// identity install.sh checks has to be the file that signs.
describe("the images' signatures", () => {
  type Step = {
    id?: string
    uses?: string
    run?: string
    with?: Record<string, unknown>
  }
  type Workflow = {
    permissions?: Record<string, string>
    on: { workflow_call?: { outputs?: Record<string, { value: string }> } }
    jobs: Record<
      string,
      {
        permissions?: Record<string, string>
        outputs?: Record<string, string>
        steps?: Step[]
        with?: Record<string, unknown>
      }
    >
  }
  const workflow = (name: string) =>
    parse(
      readFileSync(path.join(root, ".github", "workflows", name), "utf8"),
    ) as Workflow
  const images = workflow("build-images.yml")
  const steps = images.jobs.image!.steps!

  it("are made in build-images.yml for both digests, with every platform's", () => {
    expect(images.permissions).toMatchObject({
      "id-token": "write",
      attestations: "write",
    })
    const sign = steps.find((s) => s.run?.includes("cosign sign"))
    expect(sign?.run).toContain("cosign sign --yes --recursive")
    const env = (sign as { env?: Record<string, string> }).env
    expect(env).toMatchObject({
      DIGEST: "${{ steps.pcp.outputs.digest }}",
      SANDBOX_DIGEST: "${{ steps.sandbox.outputs.digest }}",
    })
    expect(steps.find((s) => s.id === "pcp")?.uses).toMatch(
      /^docker\/build-push-action@[0-9a-f]{40}$/,
    )
    expect(steps.find((s) => s.id === "sandbox")?.uses).toMatch(
      /^docker\/build-push-action@[0-9a-f]{40}$/,
    )
  })

  it("come with GitHub's provenance attestations, pushed to the registry", () => {
    const attest = steps.filter((s) =>
      s.uses?.startsWith("actions/attest-build-provenance@"),
    )
    expect(attest.map((s) => s.with?.["subject-digest"])).toEqual([
      "${{ steps.pcp.outputs.digest }}",
      "${{ steps.sandbox.outputs.digest }}",
    ])
    for (const step of attest) {
      expect(step.with?.["push-to-registry"]).toBe(true)
    }
  })

  it("use actions pinned by their full commit", () => {
    for (const step of steps) {
      if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/)
    }
  })

  it("are allowed by both callers, which publish the digests", () => {
    for (const name of ["release.yml", "develop.yml"]) {
      const caller = workflow(name)
      expect(caller.jobs.image!.permissions, name).toMatchObject({
        "id-token": "write",
        attestations: "write",
        packages: "write",
      })
      const publish = caller.jobs.publish!.steps!.find((s) =>
        s.run?.includes("--draft=false"),
      ) as Step & { env?: Record<string, string> }
      expect(publish.env, name).toMatchObject({
        DIGEST: "${{ needs.image.outputs.digest }}",
        SANDBOX_DIGEST: "${{ needs.image.outputs.sandbox-digest }}",
      })
      expect(publish.run, name).toContain("## Container images")
    }
    expect(images.on.workflow_call?.outputs?.digest?.value).toBe(
      "${{ jobs.image.outputs.digest }}",
    )
  })

  it("are checked right after signing, the way install.sh checks them", () => {
    const sign = steps.findIndex((s) => s.run?.includes("cosign sign"))
    const check = steps.findIndex((s) =>
      s.run?.includes("install.sh verify-image"),
    )
    expect(check).toBeGreaterThan(sign)
    const attest = steps.findIndex((s) =>
      s.uses?.startsWith("actions/attest-build-provenance@"),
    )
    // After the attestations too: a referrer beside the image must not
    // confuse the signature's check.
    expect(check).toBeGreaterThan(attest)
    const run = steps[check]!.run!
    expect(run).toContain('sh install.sh verify-image "$IMAGE@$DIGEST"')
    expect(run).toContain(
      'sh install.sh verify-image "$IMAGE-sandbox@$SANDBOX_DIGEST"',
    )
  })

  it("are made only by a release run from main", () => {
    const release = workflow("release.yml") as Workflow & {
      jobs: Record<string, { if?: string }>
    }
    expect(release.jobs.release!.if).toBe("github.ref == 'refs/heads/main'")
  })

  it("are what install.sh checks: that workflow, on main or develop", () => {
    const installer = readFileSync(path.join(root, "install.sh"), "utf8")
    const signer = installer.match(/^IMAGE_SIGNER='(.*)'$/m)?.[1]
    const pattern = new RegExp(signer!)

    for (const branch of ["main", "develop"]) {
      expect(
        pattern.test(
          `https://github.com/kaperkunde/pcp/.github/workflows/build-images.yml@refs/heads/${branch}`,
        ),
      ).toBe(true)
    }
    for (const other of [
      "https://github.com/kaperkunde/pcp/.github/workflows/build-images.yml@refs/heads/feature",
      "https://github.com/kaperkunde/pcp/.github/workflows/ci.yml@refs/heads/main",
      "https://github.com/someone/pcp/.github/workflows/build-images.yml@refs/heads/main",
      "https://github.com/kaperkunde/pcp/.github/workflows/build-images.yml@refs/tags/v1.0.0",
      "https://githubXcom/kaperkunde/pcp/.github/workflows/build-images.yml@refs/heads/main",
    ]) {
      expect(pattern.test(other), other).toBe(false)
    }
    expect(installer).toMatch(
      /^COSIGN_IMAGE="ghcr\.io\/sigstore\/cosign\/cosign:v[\d.]+@sha256:[0-9a-f]{64}"$/m,
    )
  })
})

// The app's own server entries stamp the connecting address into x-pcp-peer
// before Next handles a request (docker/peer-stamp.cjs), so a client cannot
// name itself and lib/server/client-ip.ts can tell a proxy from a client.
describe("the peer stamp", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { stampPeer, install } = require("../docker/peer-stamp.cjs") as {
    stampPeer: (
      req: {
        headers: Record<string, string>
        socket: { remoteAddress?: string }
      },
      name: string,
    ) => void
    install: (http: typeof import("node:http")) => void
  }

  it("overwrites a header the client sent with the socket's address", () => {
    const req = {
      headers: { "x-pcp-peer": "6.6.6.6" },
      socket: { remoteAddress: "172.18.0.2" },
    }

    stampPeer(req, "x-pcp-peer")
    expect(req.headers["x-pcp-peer"]).toBe("172.18.0.2")
  })

  it("stamps a sentinel, never nothing, when the socket has no address", () => {
    const req = { headers: { "x-pcp-peer": "6.6.6.6" }, socket: {} }

    stampPeer(req, "x-pcp-peer")
    expect(req.headers["x-pcp-peer"]).toBe("unknown")
  })

  it("marks only the requests whose client sent forwarded headers", () => {
    const sent = (headers: Record<string, string>) => {
      const req = { headers, socket: { remoteAddress: "192.168.1.5" } }

      stampPeer(req, "x-pcp-peer")
      // What Next does next (base-server.js): fills it from the socket.
      req.headers["x-forwarded-for"] ??= req.socket.remoteAddress

      return req.headers["x-pcp-forwarded"]
    }

    expect(sent({})).toBeUndefined()
    expect(sent({ "x-pcp-forwarded": "1" })).toBeUndefined()
    expect(sent({ "x-forwarded-for": "6.6.6.6" })).toBe("1")
    expect(sent({ "x-real-ip": "6.6.6.6" })).toBe("1")
  })

  it("stamps every request a Node http server handles", async () => {
    const http = await import("node:http")
    const seen = await new Promise<string | undefined>((resolve) => {
      install(http)
      const server = http.createServer((req, res) => {
        res.end()
        server.close()
        resolve(req.headers["x-pcp-peer"] as string | undefined)
      })

      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number }

        http.get(
          { port, host: "127.0.0.1", headers: { "x-pcp-peer": "6.6.6.6" } },
          (res) => res.resume(),
        )
      })
    })

    expect(seen).toBe("127.0.0.1")
  })

  it("is wired into the image and the desktop's staged server", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8")
    const start = readFileSync(path.join(root, "docker/start.cjs"), "utf8")
    const entry = readFileSync(
      path.join(root, "desktop/server-entry.cjs"),
      "utf8",
    )
    const stage = readFileSync(
      path.join(root, "desktop/scripts/stage.mjs"),
      "utf8",
    )
    const main = readFileSync(path.join(root, "desktop/main.mjs"), "utf8")

    expect(dockerfile).toContain("COPY docker/peer-stamp.cjs ./peer-stamp.cjs")
    expect(start).toContain('require("./peer-stamp.cjs")')
    expect(entry).toContain('require("./peer-stamp.cjs")')
    expect(stage).toContain("peer-stamp.cjs")
    expect(main).toContain("server-entry.cjs")
  })
})
