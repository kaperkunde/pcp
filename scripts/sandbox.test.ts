import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

// run_code's sandbox container is only as safe as the compose file that
// starts it: no network, a read-only file system, every capability dropped
// but changing user, an init that reaps, limits; and PCP and the runner
// agreeing on where the socket is, in a directory only PCP's group reaches.

const root = path.resolve(__dirname, "..")
const read = (file: string) => readFileSync(path.join(root, file), "utf8")

type Service = {
  environment?: Record<string, string>
  volumes?: string[]
  network_mode?: string
  read_only?: boolean
  user?: string
  cap_drop?: string[]
  cap_add?: string[]
  security_opt?: string[]
  init?: boolean
  pids_limit?: number
  mem_limit?: string
  depends_on?: string[]
}

const compose = parse(read("docker-compose.sandbox.yaml")) as {
  services: { pcp: Service; sandbox: Service }
}
const { pcp, sandbox } = compose.services

describe("docker-compose.sandbox.yaml", () => {
  it("walls the sandbox in", () => {
    expect(sandbox).toMatchObject({
      network_mode: "none",
      read_only: true,
      init: true,
      user: "0:1001",
      cap_drop: ["ALL"],
      cap_add: ["SETUID", "SETGID"],
      security_opt: ["no-new-privileges:true"],
      depends_on: ["pcp"],
    })
    expect(sandbox.pids_limit).toBeGreaterThan(0)
    expect(sandbox.mem_limit).toBeTruthy()
  })

  it("puts PCP's socket and the runner's on the same volume", () => {
    const socket = pcp.environment!.PCP_SANDBOX_SOCKET!
    const pcpMount = pcp.volumes!.find((volume) =>
      volume.startsWith("pcp-sandbox:"),
    )!
    const sandboxMount = sandbox.volumes!.find((volume) =>
      volume.startsWith("pcp-sandbox:"),
    )!

    expect(path.dirname(socket)).toBe(pcpMount.split(":")[1])

    const runnerSocket = read("sandbox/Dockerfile").match(
      /PCP_SANDBOX_SOCKET=(\S+)/,
    )![1]!
    expect(path.dirname(runnerSocket)).toBe(sandboxMount.split(":")[1])
    expect(path.basename(runnerSocket)).toBe(path.basename(socket))
  })

  it("gives the socket's directory to PCP's group alone, in both images", () => {
    expect(read("Dockerfile")).toMatch(
      /chown pcp:nodejs \/data \/run\/pcp-sandbox[\s\S]*chmod 0770 \/run\/pcp-sandbox/,
    )
    expect(read("sandbox/Dockerfile")).toMatch(
      /chown 1001:1001 \/run\/pcp[\s\S]*chmod 0770 \/run\/pcp/,
    )
  })

  it("speaks the protocol PCP speaks", () => {
    const pcpProtocol = read("lib/core/code/sandbox.ts").match(
      /const PROTOCOL = (\d+)/,
    )![1]
    const runnerProtocol =
      read("sandbox/runner.py").match(/PROTOCOL = (\d+)/)![1]

    expect(runnerProtocol).toBe(pcpProtocol)
  })
})
