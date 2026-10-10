import { execFileSync } from "node:child_process"
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

// The launcher's `clean` removes what a program leaves in the container's IPC
// namespace, which a process dying does not. The test makes its objects in an
// IPC namespace of its own (`unshare`), so removing "the program's" objects
// never reaches anything of the machine it runs on.

function canUnshare(): boolean {
  try {
    execFileSync(
      "unshare",
      ["--user", "--map-root-user", "--ipc", "python3", "-c", "import ctypes"],
      { stdio: "ignore" },
    )
    return true
  } catch {
    return false
  }
}

const IPC_SCRIPT = `
import ctypes, os, sys
sys.path.insert(0, sys.argv[1])
import launcher

libc = ctypes.CDLL(None, use_errno=True)
IPC_CREAT = 0o1000
made = {
    "shm": libc.shmget(0, 4096, IPC_CREAT | 0o600),
    "sem": libc.semget(0, 1, IPC_CREAT | 0o600),
    "msg": libc.msgget(0, IPC_CREAT | 0o600),
}
assert all(i >= 0 for i in made.values()), made


def listed():
    found = {}
    for table, column, _ in launcher.SYSV:
        with open(table) as lines:
            header = lines.readline().split()
            ids = {int(line.split()[header.index(column)]) for line in lines}
        found[table.rsplit("/", 1)[1]] = ids
    return found


def left():
    now = listed()
    return sorted(kind for kind, i in made.items() if i in now[kind])


assert left() == ["msg", "sem", "shm"], left()
launcher.PROGRAM_UID = 12345
launcher.remove_sysv_ipc()
assert left() == ["msg", "sem", "shm"], "removed another user's: %s" % left()
launcher.PROGRAM_UID = os.getuid()
launcher.remove_sysv_ipc()
assert left() == [], "left behind: %s" % left()
print("ok")
`

describe("sandbox/launcher.py", () => {
  it.skipIf(!canUnshare())(
    "removes the program user's System V shared memory, semaphores and message queues",
    () => {
      const out = execFileSync(
        "unshare",
        [
          "--user",
          "--map-root-user",
          "--ipc",
          "python3",
          "-c",
          IPC_SCRIPT,
          path.join(root, "sandbox"),
        ],
        { encoding: "utf8" },
      )
      expect(out.trim()).toBe("ok")
    },
  )

  it("cleans the POSIX message queues and the System V objects", () => {
    const launcher = read("sandbox/launcher.py")
    expect(launcher).toMatch(/SCRATCH = \[[^\]]*"\/dev\/mqueue"/)
    expect(launcher).toMatch(/remove_sysv_ipc\(\)\n\n\ndef main/)
  })
})
