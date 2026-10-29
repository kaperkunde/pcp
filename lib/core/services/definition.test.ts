import { describe, expect, it } from "vitest"

import {
  checkEnvBindings,
  parsePublish,
  parseServiceDefinition,
  reachUrl,
  type ServiceDefinitionInput,
} from "./definition"
import { envFile, pickDigest, runScript, runWords } from "./engine"

// A service's definition and where one runs, checked field by field before
// any of it reaches an engine command, and the commands built from them.

const DIGEST = `sha256:${"a".repeat(64)}`

const BASE: ServiceDefinitionInput = {
  image: `ghcr.io/docling-project/docling-serve@${DIGEST}`,
  source: "ghcr.io/docling-project/docling-serve:latest",
  ports: [{ container: 5001 }],
  env: [
    { name: "DOCLING_API_KEY", required: true },
    { name: "LOG_LEVEL", value: "info" },
  ],
  volumes: [{ name: "models", path: "/opt/app-root/src/.cache" }],
  health: { kind: "http", port: 5001, path: "/health" },
  registers: {
    kind: "openapi",
    port: 5001,
    specPath: "/openapi.json",
    auth: {
      env: "DOCLING_API_KEY",
      header: "X-Api-Key",
      template: "{{secret}}",
    },
  },
}

function withChange(change: Record<string, unknown>) {
  return { ...BASE, ...change }
}

describe("parseServiceDefinition", () => {
  it("takes a full definition and fills in the defaults", () => {
    const definition = parseServiceDefinition(BASE)
    expect(definition.args).toEqual([])
    expect(definition.env[1]).toEqual({
      name: "LOG_LEVEL",
      description: "",
      required: false,
      value: "info",
    })
    expect(definition.registers).toMatchObject({ basePath: "/" })
  })

  it.each([
    ["an image by tag", { image: "nginx:latest" }],
    ["an image with an option's dash", { image: `-v@${DIGEST}` }],
    ["an image with a shell word", { image: `$(id)@${DIGEST}` }],
    ["a short digest", { image: "nginx@sha256:abc" }],
    ["a source with a space", { source: "nginx latest" }],
    ["a port out of range", { ports: [{ container: 70000 }] }],
    ["a port twice", { ports: [{ container: 1 }, { container: 1 }] }],
    ["a variable with a dash", { env: [{ name: "BAD-NAME" }] }],
    ["a variable with a $", { env: [{ name: "A$(id)" }] }],
    ["a fixed value on two lines", { env: [{ name: "A", value: "a\nb" }] }],
    ["a host path as a volume", { volumes: [{ name: "/etc", path: "/x" }] }],
    ["a volume path going up", { volumes: [{ name: "v", path: "/a/../etc" }] }],
    ["a volume path with a colon", { volumes: [{ name: "v", path: "/a:ro" }] }],
    ["a relative mount path", { volumes: [{ name: "v", path: "data" }] }],
    ["an argument with a control character", { args: ["a\u0007"] }],
    [
      "a health check on a port it does not publish",
      { health: { kind: "http", port: 80, path: "/" } },
    ],
    [
      "a health path with a query",
      { health: { kind: "http", port: 5001, path: "/h?x=1" } },
    ],
    ["an unknown key", { privileged: true }],
    [
      "registering an unknown kind",
      { registers: { kind: "exec", port: 5001 } },
    ],
    [
      "an endpoint secret from no variable",
      {
        registers: {
          kind: "openapi",
          port: 5001,
          specPath: "/openapi.json",
          auth: { env: "NOPE", header: "X-Api-Key", template: "{{secret}}" },
        },
      },
    ],
  ])("refuses %s", (_label, change) => {
    expect(() => parseServiceDefinition(withChange(change))).toThrow(
      /definition/,
    )
  })
})

describe("parsePublish", () => {
  const definition = parseServiceDefinition(BASE)

  it("takes one host port per port, on an IP address", () => {
    expect(
      parsePublish(
        { address: "0.0.0.0", ports: [{ container: 5001, host: 15001 }] },
        definition,
      ),
    ).toEqual({ address: "0.0.0.0", ports: [{ container: 5001, host: 15001 }] })
    expect(
      parsePublish(
        { address: "[::1]", ports: [{ container: 5001, host: 15001 }] },
        definition,
      ).address,
    ).toBe("::1")
  })

  it.each([
    [
      "a host name",
      { address: "box.example", ports: [{ container: 5001, host: 1 }] },
    ],
    [
      "a shell word",
      { address: "$(id)", ports: [{ container: 5001, host: 1 }] },
    ],
    ["a missing port", { address: "0.0.0.0", ports: [] }],
    [
      "a port the service lacks",
      {
        address: "0.0.0.0",
        ports: [
          { container: 5001, host: 1 },
          { container: 22, host: 2 },
        ],
      },
    ],
  ])("refuses %s", (_label, publish) => {
    expect(() => parsePublish(publish, definition)).toThrow()
  })

  it("reaches a port on every address at the SSH server's own", () => {
    const publish = {
      address: "0.0.0.0",
      ports: [{ container: 5001, host: 15001 }],
    }
    expect(reachUrl(publish, "box.lan", 5001)).toBe("http://box.lan:15001")
    expect(
      reachUrl({ ...publish, address: "127.0.0.1" }, "box.lan", 5001),
    ).toBeNull()
    expect(
      reachUrl({ ...publish, address: "127.0.0.1" }, "127.0.0.1", 5001),
    ).toBe("http://127.0.0.1:15001")
  })
})

describe("checkEnvBindings", () => {
  const definition = parseServiceDefinition(BASE)

  it("needs every required variable bound", () => {
    expect(() => checkEnvBindings({}, definition)).toThrow(/DOCLING_API_KEY/)
    expect(checkEnvBindings({ DOCLING_API_KEY: "s1" }, definition)).toEqual({
      DOCLING_API_KEY: "s1",
    })
  })

  it("refuses a variable the service does not have", () => {
    expect(() =>
      checkEnvBindings({ DOCLING_API_KEY: "s1", PATH: "s2" }, definition),
    ).toThrow(/no variable called PATH/)
  })
})

describe("engine commands", () => {
  const definition = parseServiceDefinition({
    ...BASE,
    args: ["--workers", "it's $(id)"],
  })
  const spec = {
    serviceId: "svc1",
    containerName: "pcp-docling",
    definition,
    publish: { address: "0.0.0.0", ports: [{ container: 5001, host: 15001 }] },
  }

  it("runs the image by digest with its label, ports, named volumes and env file", () => {
    const words = runWords("docker", spec)
    expect(words.slice(0, 9)).toEqual([
      "docker",
      "run",
      "--detach",
      "--name",
      "pcp-docling",
      "--label",
      "pcp.service=svc1",
      "--restart",
      "unless-stopped",
    ])
    expect(words).toContain("0.0.0.0:15001:5001")
    expect(words).toContain("pcp-docling-models:/opt/app-root/src/.cache")
    // The image's arguments come after it, never as the engine's options.
    expect(words.slice(-3)).toEqual([
      definition.image,
      "--workers",
      "it's $(id)",
    ])
  })

  it("names no value on the command line: the env file is read from standard input", () => {
    const script = runScript("podman", spec)
    expect(script).toContain('cat > "$f"')
    expect(script).toContain('--env-file "$f"')
    expect(script).toContain("umask 077")
    expect(script).toMatch(/^podman run /m)
    expect(script).toContain(`'it'\\''s $(id)'`)
  })

  it("refuses a container name PCP would not give", () => {
    expect(() =>
      runWords("docker", { ...spec, containerName: "web; rm -rf /" }),
    ).toThrow(/pcp-<name>/)
  })

  it("writes values one a line, and refuses one with a line break", () => {
    expect(
      envFile({ values: { A: "1", B: "two words" }, redact: [] }).toString(),
    ).toBe("A=1\nB=two words\n")
    expect(() =>
      envFile({ values: { A: "x\nB=injected" }, redact: [] }),
    ).toThrow(/line break/)
    expect(() => envFile({ values: { "A B": "x" }, redact: [] })).toThrow()
  })

  it("picks the digest of the image's own repository", () => {
    expect(
      pickDigest(
        JSON.stringify([`ghcr.io/org/app@sha256:${"c".repeat(64)}`]),
        "ghcr.io/org/app:latest",
      ),
    ).toBe(`ghcr.io/org/app@sha256:${"c".repeat(64)}`)
    expect(
      pickDigest(
        JSON.stringify([`nginx@sha256:${"d".repeat(64)}`]),
        "nginx:1.27",
      ),
    ).toBe(`nginx@sha256:${"d".repeat(64)}`)
    expect(() => pickDigest("[]", "nginx:1.27")).toThrow(/digest/)
  })
})
