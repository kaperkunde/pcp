// install.sh against fake runtimes: a temp directory with shims for docker,
// podman, systemctl and the rest on a PATH that holds nothing else, so the
// real Docker on this machine (or CI's) is invisible and every call the
// script makes is written to a log the tests read.

import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

const INSTALL_SH = fileURLToPath(new URL("../install.sh", import.meta.url))
const IMAGE = "ghcr.io/kaperkunde/pcp:latest"
const RUN = `run -d --name pcp --restart unless-stopped -p 3000:3000 -e PCP_HOST_UPDATER=2 -v pcp-data:/data ${IMAGE}`

/** The real programs the script needs besides the ones a host fakes. */
const TOOLS = [
  "awk",
  "cat",
  "chmod",
  "cp",
  "date",
  "dirname",
  "mkdir",
  "mv",
  "readlink",
  "rm",
  "rmdir",
  "sleep",
]

const UNIT = `# PCP. Written by install.sh; running the installer again rewrites it.
# Logs: journalctl --user -u pcp -f
[Unit]
Description=PCP

[Container]
Image=${IMAGE}
ContainerName=pcp
PublishPort=3000:3000
Volume=pcp-data:/data
Environment=PCP_HOST_UPDATER=2

[Service]
Restart=always

[Install]
WantedBy=default.target
`

type Host = {
  /** Absent, a daemon that answers, one that is down, one this user may not use, or Podman's docker shim. */
  docker?: "absent" | "works" | "down" | "denied" | "podman"
  /** Podman's version, or absent. */
  podman?: string
  /** Whether `systemctl --user` reaches a manager. */
  session?: boolean
  /** What `id -u` answers. */
  uid?: number
  /** What `uname -s` answers. */
  system?: string
  /** What `inspect` says about the container after it was started. */
  state?: "running" | "exited"
  /** Whether the health check answers. */
  healthy?: boolean
  /** net.ipv4.ip_unprivileged_port_start: the first port a user without root may open. */
  portStart?: number
  /** Whether a compose checkout's container is running. */
  compose?: boolean
  /** What `image inspect` says the image's id is; nothing when absent. */
  image?: string
  /** What PCP left in /data/install-request; absent when there is no file. */
  signal?: string
  /** What `timedatectl show -p Timezone --value` answers; no such program when absent. */
  timedatectl?: string
  /** Accounts in /etc/passwd; `pcp` puts this installer's Quadlet unit in the home. */
  users?: { name: string; uid: number; pcp?: boolean }[]
  /** Whether root reaches those users' systemd managers (lingering or logged in). */
  userSession?: boolean
  /**
   * The host's /dev/dri: a render node with what `ls -l` says of it
   * (mode, group id and name), or a card with no render node. Absent when
   * there is none.
   */
  dri?: { mode: string; gid: number; group: string } | "card only"
  /** What `id -G` answers. */
  groups?: number[]
  /** Podman's OCI runtime, as `podman info` names it. */
  ociRuntime?: string
  /** Whether the Docker daemon runs without root. */
  dockerRootless?: boolean
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
  roots.length = 0
})

function find(tool: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const file = join(dir, tool)
    if (existsSync(file)) {
      return file
    }
  }
  throw new Error(`${tool} is not on PATH`)
}

function host({
  docker = "absent",
  podman,
  session = true,
  uid = 1000,
  system = "Linux",
  state = "running",
  healthy = true,
  portStart = 1024,
  compose = false,
  image,
  signal,
  timedatectl,
  users = [],
  userSession = true,
  dri,
  groups = [1000],
  ociRuntime = "crun",
  dockerRootless = false,
}: Host = {}) {
  const root = mkdtempSync(join(tmpdir(), "pcp-install-"))
  roots.push(root)
  const bin = join(root, "bin")
  const tools = join(root, "tools")
  const home = join(root, "home")
  // Stands for / when the script runs as root (PCP_ROOT_PREFIX), which the
  // tests may not write to.
  const sys = join(root, "sys")
  const log = join(root, "log")
  for (const dir of [bin, tools, home]) {
    mkdirSync(dir)
  }
  for (const tool of TOOLS) {
    symlinkSync(find(tool), join(tools, tool))
  }

  // Logged shims: what the script does to the machine.
  const shim = (name: string, body: string) => {
    const file = join(bin, name)
    writeFileSync(
      file,
      `#!/bin/sh\nprintf '%s\\n' "${name} $*" >>"$SHIM_LOG"\n${body}\nexit 0\n`,
    )
    chmodSync(file, 0o755)
  }
  // Quiet shims: what the script asks about the machine.
  const answer = (name: string, body: string) => {
    const file = join(bin, name)
    writeFileSync(file, `#!/bin/sh\n${body}\nexit 0\n`)
    chmodSync(file, 0o755)
  }
  const ps = compose ? "echo 0123456789ab" : ""
  const imageId = image ? `echo "${image}"` : ":"
  const request = signal === undefined ? "exit 1" : `printf '%s\\n' '${signal}'`

  if (docker !== "absent") {
    const version =
      docker === "podman"
        ? "podman version 5.2.2"
        : "Docker version 27.0.1, build 1234567"
    const info = {
      works: "exit 0",
      podman: "exit 0",
      down: 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1',
      denied:
        'echo "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock" >&2; exit 1',
    }[docker]
    shim(
      "docker",
      `case "$1" in
  --version) echo "${version}" ;;
  info) ${dockerRootless ? 'echo "[name=seccomp,profile=builtin name=rootless name=cgroupns]"; ' : ""}${info} ;;
  inspect) echo "${state}" ;;
  image) ${imageId} ;;
  exec) ${request} ;;
  ps) ${ps} ;;
esac`,
    )
  }
  if (podman !== undefined) {
    shim(
      "podman",
      `case "$1" in
  --version) echo "podman version ${podman}" ;;
  info) echo "${ociRuntime}" ;;
  inspect) echo "${state}" ;;
  image) ${imageId} ;;
  exec) ${request} ;;
  ps) ${ps} ;;
esac`,
    )
  }
  shim(
    "systemctl",
    `case "$*" in
  *show-environment*) exit ${session ? 0 : 1} ;;
esac`,
  )
  shim("loginctl", "")
  shim("curl", `exit ${healthy ? 0 : 22}`)
  answer("uname", `echo "${system}"`)
  answer(
    "id",
    `case "$1" in -u) echo ${uid} ;; -un) echo pat ;; -G) echo "${groups.join(" ")}" ;; esac`,
  )
  answer("hostname", 'echo "192.168.1.20 10.0.0.5"')
  answer("sysctl", `echo ${portStart}`)
  if (timedatectl !== undefined) {
    answer("timedatectl", `echo "${timedatectl}"`)
  }
  shim(
    "runuser",
    `case "$*" in
  *show-environment*) exit ${userSession ? 0 : 1} ;;
esac`,
  )
  answer("systemd-run", "")
  const homes = join(root, "homes")
  const passwd = ["root:x:0:0:root:/root:/bin/sh"]
  for (const { name, uid, pcp } of users) {
    const userHome = join(homes, name)
    const units = join(userHome, ".config", "containers", "systemd")
    mkdirSync(units, { recursive: true })
    if (pcp) {
      writeFileSync(join(units, "pcp.container"), UNIT)
    }
    passwd.push(`${name}:x:${uid}:${uid}::${userHome}:/bin/sh`)
  }
  if (dri) {
    const devices = join(sys, "dev", "dri")
    mkdirSync(devices, { recursive: true })
    writeFileSync(join(devices, "card0"), "")
    if (dri !== "card only") {
      writeFileSync(join(devices, "renderD128"), "")
      answer(
        "ls",
        `case "$1" in
  -ln) echo "${dri.mode} 1 0 ${dri.gid} 226, 128 Oct 23 02:00 $2" ;;
  -l) echo "${dri.mode} 1 root ${dri.group} 226, 128 Oct 23 02:00 $2" ;;
esac`,
      )
    }
  }
  mkdirSync(join(sys, "etc"), { recursive: true })
  writeFileSync(join(sys, "etc", "passwd"), passwd.join("\n") + "\n")

  return {
    unit: join(home, ".config", "containers", "systemd", "pcp.container"),
    conf: join(home, ".config", "pcp", "install.conf"),
    timer: join(home, ".config", "systemd", "user", "pcp-update.timer"),
    service: join(home, ".config", "systemd", "user", "pcp-update.service"),
    watchTimer: join(
      home,
      ".config",
      "systemd",
      "user",
      "pcp-update-request.timer",
    ),
    watchService: join(
      home,
      ".config",
      "systemd",
      "user",
      "pcp-update-request.service",
    ),
    updater: join(home, ".local", "share", "pcp", "install.sh"),
    handled: join(home, ".local", "state", "pcp", "install-request"),
    home,
    /** Root's files: the same names under PCP_ROOT_PREFIX. */
    sys: {
      unit: join(sys, "etc", "containers", "systemd", "pcp.container"),
      conf: join(sys, "etc", "pcp", "install.conf"),
      timer: join(sys, "etc", "systemd", "system", "pcp-update.timer"),
      service: join(sys, "etc", "systemd", "system", "pcp-update.service"),
      updater: join(sys, "usr", "local", "lib", "pcp", "install.sh"),
      watchTimer: join(
        sys,
        "etc",
        "systemd",
        "system",
        "pcp-update-request.timer",
      ),
      handled: join(sys, "var", "lib", "pcp", "install-request"),
      /** Where the script looks for the host's time zone. */
      timezone: join(sys, "etc", "timezone"),
      localtime: join(sys, "etc", "localtime"),
    },
    run(args: string[] = [], env: Record<string, string> = {}) {
      writeFileSync(log, "")
      const result = spawnSync("/bin/sh", [INSTALL_SH, ...args], {
        env: {
          // Next's types make it required; the script does not read it.
          NODE_ENV: "test",
          PATH: `${bin}${delimiter}${tools}`,
          HOME: home,
          PCP_ROOT_PREFIX: sys,
          SHIM_LOG: log,
          ...env,
        },
        encoding: "utf8",
      })
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
      }
    },
  }
}

const started = (calls: string[]) =>
  calls.some((call) => / (run|pull) /.test(call))

describe("install.sh: choosing a runtime", () => {
  it("uses Docker when its daemon answers, even with Podman installed", () => {
    const result = host({ docker: "works", podman: "5.2.2" }).run()
    expect(result.status).toBe(0)
    expect(result.calls).toContain(`docker ${RUN}`)
    expect(result.calls.some((call) => call.startsWith("podman "))).toBe(false)
  })

  it("uses Podman when Docker is installed but its daemon is off (Bazzite)", () => {
    const machine = host({ docker: "down", podman: "5.2.2" })
    const result = machine.run()
    expect(result.status).toBe(0)
    expect(existsSync(machine.unit)).toBe(true)
    expect(result.calls.some((call) => call.startsWith("docker run"))).toBe(
      false,
    )
  })

  it("treats a docker that is Podman's shim as Podman", () => {
    const machine = host({ docker: "podman", podman: "5.2.2" })
    const result = machine.run()
    expect(result.status).toBe(0)
    expect(existsSync(machine.unit)).toBe(true)
  })

  it("obeys PCP_RUNTIME over the discovery", () => {
    const machine = host({ docker: "works", podman: "5.2.2" })
    const result = machine.run([], { PCP_RUNTIME: "podman" })
    expect(result.status).toBe(0)
    expect(existsSync(machine.unit)).toBe(true)
    expect(result.calls.some((call) => call.startsWith("docker "))).toBe(false)
  })

  it("says how to allow Docker when this user may not use it", () => {
    const result = host({ docker: "denied" }).run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("sudo usermod -aG docker pat")
    expect(started(result.calls)).toBe(false)
  })

  it("says how to start Docker when its daemon is off and there is no Podman", () => {
    const result = host({ docker: "down" }).run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("sudo systemctl enable --now docker")
    expect(started(result.calls)).toBe(false)
  })

  it("says how to install a runtime when there is none", () => {
    const result = host().run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("https://get.docker.com")
    expect(result.stderr).toContain("podman")
  })

  it("refuses a setting or an argument it does not understand", () => {
    const machine = host({ docker: "works" })
    expect(machine.run([], { PCP_RUNTIME: "lxc" }).status).toBe(2)
    expect(machine.run([], { PCP_PORT: "abc" }).status).toBe(2)
    expect(machine.run([], { PCP_HTTPS: "yes" }).status).toBe(2)
    expect(machine.run(["frobnicate"]).status).toBe(2)
    expect(started(machine.run(["frobnicate"]).calls)).toBe(false)
  })

  it("runs on Linux only", () => {
    const result = host({ docker: "works", system: "Darwin" }).run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("PCP app")
  })
})

describe("install.sh with Docker", () => {
  it("pulls before it replaces the container, then says where PCP answers", () => {
    const result = host({ docker: "works" }).run()
    expect(result.status).toBe(0)
    const pull = result.calls.indexOf(`docker pull ${IMAGE}`)
    const remove = result.calls.indexOf("docker rm -f pcp")
    const run = result.calls.indexOf(`docker ${RUN}`)
    expect(pull).toBeGreaterThanOrEqual(0)
    expect(remove).toBeGreaterThan(pull)
    expect(run).toBeGreaterThan(remove)
    expect(result.calls).toContain(
      "curl -fs -o /dev/null --max-time 3 http://127.0.0.1:3000/api/health",
    )
    expect(result.stdout).toContain("http://localhost:3000")
    expect(result.stdout).toContain("http://192.168.1.20:3000")
    expect(result.stdout).toContain("docker logs -f pcp")
    expect(result.stdout).toContain("PCP_HTTPS=1")
  })

  it("passes the settings through", () => {
    const result = host({ docker: "works" }).run([], {
      PCP_PORT: "8080",
      PCP_HTTPS: "1",
      PCP_VERSION: "v1.2.3",
      PCP_IMAGE: "example.com/pcp",
      PCP_DATA_VOLUME: "vault",
    })
    expect(result.status).toBe(0)
    expect(result.calls).toContain("docker pull example.com/pcp:1.2.3")
    expect(result.calls).toContain(
      "docker run -d --name pcp --restart unless-stopped -p 127.0.0.1:8080:3000 -p 80:8080 -p 443:8443 -v vault:/data example.com/pcp:1.2.3",
    )
    expect(result.calls).toContain(
      "curl -fs -o /dev/null --max-time 3 http://127.0.0.1:8080/api/health",
    )
    expect(result.stdout).toContain("http://localhost:8080")
    expect(result.stdout).not.toContain("PCP_HTTPS=1")
    // The plain-HTTP port answers on this computer only, so it is not offered
    // as an address for other devices.
    expect(result.stdout).not.toContain("http://192.168.1.20:8080")
  })

  it("remembers the settings for the next run", () => {
    const machine = host({ docker: "works" })
    expect(machine.run([], { PCP_PORT: "8080", PCP_HTTPS: "1" }).status).toBe(0)
    expect(readFileSync(machine.conf, "utf8")).toBe(
      "PCP_PORT=8080\nPCP_HTTPS=1\nPCP_RUNTIME=docker\nPCP_DATA_VOLUME=pcp-data\nPCP_AUTO_UPDATE=0\nPCP_UPDATE_BUTTON=1\nPCP_CHANNEL=stable\nPCP_GPU=1\n",
    )

    const again = machine.run()
    expect(again.status).toBe(0)
    expect(again.calls).toContain(
      `docker run -d --name pcp --restart unless-stopped -p 127.0.0.1:8080:3000 -p 80:8080 -p 443:8443 -e PCP_HOST_UPDATER=2 -v pcp-data:/data ${IMAGE}`,
    )

    const without = machine.run([], { PCP_HTTPS: "0" })
    expect(without.status).toBe(0)
    expect(without.calls).toContain(
      `docker run -d --name pcp --restart unless-stopped -p 8080:3000 -e PCP_HOST_UPDATER=2 -v pcp-data:/data ${IMAGE}`,
    )
  })

  it("follows develop's builds with PCP_CHANNEL=develop, and remembers it", () => {
    const machine = host({ docker: "works" })
    const result = machine.run([], { PCP_CHANNEL: "develop" })
    expect(result.status).toBe(0)
    expect(result.calls).toContain("docker pull ghcr.io/kaperkunde/pcp:develop")
    expect(result.calls).toContain(
      "docker run -d --name pcp --restart unless-stopped -p 3000:3000 -e PCP_HOST_UPDATER=2 -v pcp-data:/data ghcr.io/kaperkunde/pcp:develop",
    )
    expect(result.stdout).toContain("develop's builds")
    expect(readFileSync(machine.conf, "utf8")).toContain(
      "PCP_CHANNEL=develop\n",
    )

    expect(machine.run().calls).toContain(
      "docker pull ghcr.io/kaperkunde/pcp:develop",
    )
    const back = machine.run([], { PCP_CHANNEL: "stable" })
    expect(back.calls).toContain(`docker pull ${IMAGE}`)

    expect(machine.run([], { PCP_CHANNEL: "nightly" }).status).toBe(2)
  })

  it("refuses to run beside a compose checkout", () => {
    const result = host({ docker: "works", compose: true }).run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("docker compose down")
    expect(result.stderr).toContain("PCP_DATA_VOLUME=pcp_pcp-data")
    expect(started(result.calls)).toBe(false)
  })

  it("fails when the container stops right after starting", () => {
    const result = host({
      docker: "works",
      state: "exited",
      healthy: false,
    }).run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("docker logs -f pcp")
  })

  it("removes the container on uninstall and keeps the volume", () => {
    const machine = host({ docker: "works" })
    expect(machine.run().status).toBe(0)
    const result = machine.run(["uninstall"])
    expect(result.status).toBe(0)
    expect(result.calls).toContain("docker rm -f pcp")
    expect(started(result.calls)).toBe(false)
    expect(result.stdout).toContain("docker volume rm pcp-data")
    expect(existsSync(machine.conf)).toBe(false)
  })
})

describe("install.sh with Podman", () => {
  it("writes a Quadlet unit and starts it with the user's systemd", () => {
    const machine = host({ podman: "5.2.2" })
    const result = machine.run()
    expect(result.status).toBe(0)
    expect(readFileSync(machine.unit, "utf8")).toBe(UNIT)
    expect(result.calls).toContain(`podman pull ${IMAGE}`)
    expect(result.calls).toContain("systemctl --user daemon-reload")
    expect(result.calls).toContain("systemctl --user restart pcp.service")
    expect(result.calls).toContain("loginctl enable-linger")
    expect(result.calls.some((call) => call.startsWith("podman run"))).toBe(
      false,
    )
    expect(result.stdout).toContain("journalctl --user -u pcp -f")
    expect(readFileSync(machine.conf, "utf8")).toContain("PCP_RUNTIME=podman\n")
  })

  it("publishes the HTTPS ports in the unit when the system allows them", () => {
    const machine = host({ podman: "5.2.2", portStart: 80 })
    expect(machine.run([], { PCP_HTTPS: "1" }).status).toBe(0)
    expect(readFileSync(machine.unit, "utf8")).toContain(
      "PublishPort=127.0.0.1:3000:3000\nPublishPort=80:8080\nPublishPort=443:8443\n",
    )
  })

  it("refuses HTTPS ports a Podman without root may not open", () => {
    const machine = host({ podman: "5.2.2", portStart: 1024 })
    const result = machine.run([], { PCP_HTTPS: "1" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("net.ipv4.ip_unprivileged_port_start=80")
    expect(started(result.calls)).toBe(false)
    expect(existsSync(machine.unit)).toBe(false)
  })

  it("falls back to podman run on Podman older than 4.4", () => {
    const machine = host({ podman: "4.3.1" })
    const result = machine.run()
    expect(result.status).toBe(0)
    expect(result.calls).toContain(`podman ${RUN}`)
    expect(existsSync(machine.unit)).toBe(false)
    expect(result.stderr).toContain("4.4")
    expect(result.stdout).toContain("podman logs -f pcp")
  })

  it("falls back to podman run without a systemd session", () => {
    const machine = host({ podman: "5.2.2", session: false })
    const result = machine.run()
    expect(result.status).toBe(0)
    expect(result.calls).toContain(`podman ${RUN}`)
    expect(existsSync(machine.unit)).toBe(false)
    expect(result.stderr).toContain("systemd session")
  })

  it("removes the unit and the container on uninstall", () => {
    const machine = host({ podman: "5.2.2" })
    expect(machine.run().status).toBe(0)
    expect(existsSync(machine.unit)).toBe(true)
    const result = machine.run(["uninstall"])
    expect(result.status).toBe(0)
    expect(result.calls).toContain("systemctl --user stop pcp.service")
    expect(result.calls).toContain("systemctl --user daemon-reload")
    expect(result.calls).toContain("podman rm -f pcp")
    expect(existsSync(machine.unit)).toBe(false)
    expect(result.stdout).toContain("podman volume rm pcp-data")
  })
})

describe("install.sh updating PCP by itself", () => {
  it("sets up a daily timer under Docker that runs a copy of the installer", () => {
    const machine = host({ docker: "works" })
    const result = machine.run([], { PCP_AUTO_UPDATE: "1" })
    expect(result.status).toBe(0)
    expect(result.calls).toContain(
      `docker run -d --name pcp --restart unless-stopped -p 3000:3000 -e PCP_AUTO_UPDATE=1 -e PCP_HOST_UPDATER=2 -v pcp-data:/data ${IMAGE}`,
    )
    expect(readFileSync(machine.updater, "utf8")).toBe(
      readFileSync(INSTALL_SH, "utf8"),
    )
    expect(readFileSync(machine.service, "utf8")).toContain(
      `ExecStart=/bin/sh "${machine.updater}" update`,
    )
    expect(readFileSync(machine.timer, "utf8")).toContain("OnCalendar=daily")
    expect(result.calls).toContain("systemctl --user daemon-reload")
    expect(result.calls).toContain(
      "systemctl --user enable --now pcp-update.timer",
    )
    expect(result.calls).toContain("loginctl enable-linger")
    expect(readFileSync(machine.conf, "utf8")).toContain("PCP_AUTO_UPDATE=1\n")
    expect(result.stdout).toContain("by itself, once a day")
  })

  it("keeps it on the next run, and takes it away with PCP_AUTO_UPDATE=0", () => {
    const machine = host({ docker: "works" })
    expect(machine.run([], { PCP_AUTO_UPDATE: "1" }).status).toBe(0)

    const again = machine.run()
    expect(again.status).toBe(0)
    expect(again.calls).toContain(
      `docker run -d --name pcp --restart unless-stopped -p 3000:3000 -e PCP_AUTO_UPDATE=1 -e PCP_HOST_UPDATER=2 -v pcp-data:/data ${IMAGE}`,
    )
    expect(existsSync(machine.timer)).toBe(true)

    const off = machine.run([], { PCP_AUTO_UPDATE: "0" })
    expect(off.status).toBe(0)
    expect(off.calls).toContain(`docker ${RUN}`)
    expect(off.calls).toContain(
      "systemctl --user disable --now pcp-update.timer",
    )
    expect(existsSync(machine.timer)).toBe(false)
    expect(existsSync(machine.service)).toBe(false)
    // "Install and restart" still runs the copy.
    expect(existsSync(machine.updater)).toBe(true)
    expect(off.stdout).toContain("PCP_AUTO_UPDATE=1 does it daily")

    const neither = machine.run([], { PCP_UPDATE_BUTTON: "0" })
    expect(neither.status).toBe(0)
    expect(existsSync(machine.updater)).toBe(false)
  })

  it("leaves it to Podman's own timer under Quadlet", () => {
    const machine = host({ podman: "5.2.2" })
    const result = machine.run([], { PCP_AUTO_UPDATE: "1" })
    expect(result.status).toBe(0)
    expect(readFileSync(machine.unit, "utf8")).toContain(
      "Environment=PCP_AUTO_UPDATE=1\nLabel=io.containers.autoupdate=registry\n",
    )
    expect(result.calls).toContain(
      "systemctl --user enable --now podman-auto-update.timer",
    )
    expect(existsSync(machine.timer)).toBe(false)
    expect(result.stdout).toContain("by itself, once a day")
  })

  it("takes Podman's auto-update label away with PCP_AUTO_UPDATE=0", () => {
    const machine = host({ podman: "5.2.2" })
    expect(machine.run([], { PCP_AUTO_UPDATE: "1" }).status).toBe(0)
    expect(readFileSync(machine.unit, "utf8")).toContain(
      "io.containers.autoupdate",
    )

    expect(machine.run([], { PCP_AUTO_UPDATE: "0" }).status).toBe(0)
    expect(readFileSync(machine.unit, "utf8")).not.toContain(
      "io.containers.autoupdate",
    )
  })

  it("gives the crontab line when there is no systemd session", () => {
    const machine = host({ podman: "5.2.2", session: false })
    const result = machine.run([], { PCP_AUTO_UPDATE: "1" })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain("crontab -e")
    expect(result.stderr).toContain(`/bin/sh "${machine.updater}" update`)
    expect(existsSync(machine.updater)).toBe(true)
    expect(existsSync(machine.timer)).toBe(false)
    expect(result.stdout).toContain("with the crontab line above")
  })

  it("refuses a value it does not understand", () => {
    const result = host({ docker: "works" }).run([], { PCP_AUTO_UPDATE: "yes" })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("PCP_AUTO_UPDATE must be 0 or 1")
  })

  it("removes the timer and the copy on uninstall", () => {
    const machine = host({ docker: "works" })
    expect(machine.run([], { PCP_AUTO_UPDATE: "1" }).status).toBe(0)
    const result = machine.run(["uninstall"])
    expect(result.status).toBe(0)
    expect(existsSync(machine.timer)).toBe(false)
    expect(existsSync(machine.updater)).toBe(false)
  })
})

describe("install.sh update", () => {
  it("leaves PCP running when the image did not change", () => {
    const machine = host({ docker: "works", image: "sha256:abc" })
    expect(machine.run().status).toBe(0)

    const result = machine.run(["update"])
    expect(result.status).toBe(0)
    expect(result.calls).toContain(`docker pull -q ${IMAGE}`)
    expect(result.calls).not.toContain("docker rm -f pcp")
    expect(result.calls.some((call) => call.startsWith("docker run"))).toBe(
      false,
    )
    expect(result.stdout).toContain("PCP is up to date")
  })

  it("starts PCP again from a new image, with the remembered settings", () => {
    const machine = host({ docker: "works" })
    expect(machine.run([], { PCP_PORT: "8080" }).status).toBe(0)

    const result = machine.run(["update"])
    expect(result.status).toBe(0)
    expect(result.calls).toContain(`docker pull -q ${IMAGE}`)
    expect(result.calls).toContain(
      `docker run -d --name pcp --restart unless-stopped -p 8080:3000 -e PCP_HOST_UPDATER=2 -v pcp-data:/data ${IMAGE}`,
    )
    expect(result.stdout).toContain("PCP is updated")
    expect(result.stdout).not.toContain("Open it now")
  })
})

describe("install.sh as root", () => {
  // `sudo -E`, or a sudo that keeps HOME: root runs with an ordinary user's
  // directories, which that user may write to.
  const user = (machine: ReturnType<typeof host>) => ({
    HOME: machine.home,
    XDG_CONFIG_HOME: join(machine.home, ".config"),
    XDG_DATA_HOME: join(machine.home, ".local", "share"),
  })
  const mode = (path: string) => statSync(path).mode & 0o777

  it("keeps the updater where only root writes, not under HOME", () => {
    const machine = host({ docker: "works", uid: 0 })
    const result = machine.run([], { ...user(machine), PCP_AUTO_UPDATE: "1" })
    expect(result.status).toBe(0)
    expect(readFileSync(machine.sys.updater, "utf8")).toBe(
      readFileSync(INSTALL_SH, "utf8"),
    )
    expect(mode(machine.sys.updater)).toBe(0o644)
    expect(mode(dirname(machine.sys.updater))).toBe(0o755)
    expect(existsSync(join(machine.home, ".local"))).toBe(false)
    expect(existsSync(machine.updater)).toBe(false)
  })

  it("points the system timer's service at that copy", () => {
    const machine = host({ docker: "works", uid: 0 })
    const result = machine.run([], { ...user(machine), PCP_AUTO_UPDATE: "1" })
    expect(result.status).toBe(0)
    expect(readFileSync(machine.sys.service, "utf8")).toContain(
      `ExecStart=/bin/sh "${machine.sys.updater}" update\n`,
    )
    expect(readFileSync(machine.sys.timer, "utf8")).toContain(
      "OnCalendar=daily",
    )
    expect(result.calls).toContain("systemctl enable --now pcp-update.timer")
    expect(existsSync(join(machine.home, ".config", "systemd"))).toBe(false)
  })

  it("gives a crontab line for that copy without a systemd session", () => {
    const machine = host({ podman: "5.2.2", session: false, uid: 0 })
    const result = machine.run([], { ...user(machine), PCP_AUTO_UPDATE: "1" })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain(`/bin/sh "${machine.sys.updater}" update`)
    expect(result.stderr).not.toContain(machine.home)
    expect(existsSync(machine.sys.updater)).toBe(true)
  })

  it("keeps and reads its settings in /etc, not in HOME", () => {
    const machine = host({ docker: "works", uid: 0 })
    const first = machine.run([], { ...user(machine), PCP_PORT: "8080" })
    expect(first.status).toBe(0)
    expect(readFileSync(machine.sys.conf, "utf8")).toContain("PCP_PORT=8080\n")
    expect(mode(machine.sys.conf)).toBe(0o644)
    expect(existsSync(machine.conf)).toBe(false)

    const again = machine.run([], user(machine))
    expect(again.calls).toContain(
      `docker run -d --name pcp --restart unless-stopped -p 8080:3000 -e PCP_HOST_UPDATER=2 -v pcp-data:/data ${IMAGE}`,
    )
  })

  // An install from before root had a place of its own kept its settings in
  // HOME. They are carried over once, by an install run, and never read again.
  const oldConf = (machine: ReturnType<typeof host>, text: string) => {
    mkdirSync(dirname(machine.conf), { recursive: true })
    writeFileSync(machine.conf, text)
  }
  const HTTPS_RUN = `docker run -d --name pcp --restart unless-stopped -p 127.0.0.1:8080:3000 -p 80:8080 -p 443:8443 -e PCP_HOST_UPDATER=2 -v pcp-data:/data ${IMAGE}`

  it("carries the settings of an older install over from HOME, once", () => {
    const machine = host({ docker: "works", uid: 0 })
    oldConf(machine, "PCP_PORT=8080\nPCP_HTTPS=1\n")
    const first = machine.run([], user(machine))
    expect(first.status).toBe(0)
    expect(first.calls).toContain(HTTPS_RUN)
    expect(first.stderr).toContain(machine.conf)
    expect(first.stderr).toContain(machine.sys.conf)
    expect(readFileSync(machine.sys.conf, "utf8")).toBe(
      "PCP_PORT=8080\nPCP_HTTPS=1\nPCP_RUNTIME=docker\nPCP_DATA_VOLUME=pcp-data\nPCP_AUTO_UPDATE=0\nPCP_UPDATE_BUTTON=1\nPCP_CHANNEL=stable\nPCP_GPU=1\n",
    )

    // The file in HOME is not read again, whatever it says now.
    oldConf(machine, "PCP_PORT=9999\nPCP_HTTPS=0\nPCP_RUNTIME=podman\n")
    const second = machine.run([], user(machine))
    expect(second.status).toBe(0)
    expect(second.calls).toContain(HTTPS_RUN)
    expect(second.stderr).not.toContain(machine.conf)
  })

  it("lets the environment win over carried-over settings", () => {
    const machine = host({ docker: "works", uid: 0 })
    oldConf(machine, "PCP_PORT=8080\nPCP_HTTPS=1\nPCP_DATA_VOLUME=vault\n")
    const result = machine.run([], { ...user(machine), PCP_PORT: "7000" })
    expect(result.status).toBe(0)
    expect(result.calls).toContain(
      `docker run -d --name pcp --restart unless-stopped -p 127.0.0.1:7000:3000 -p 80:8080 -p 443:8443 -e PCP_HOST_UPDATER=2 -v vault:/data ${IMAGE}`,
    )
    expect(readFileSync(machine.sys.conf, "utf8")).toContain("PCP_PORT=7000\n")
  })

  it("checks carried-over settings like any others", () => {
    const machine = host({ docker: "works", uid: 0 })
    oldConf(machine, "PCP_PORT=abc\n")
    const result = machine.run([], user(machine))
    expect(result.status).toBe(2)
    expect(started(result.calls)).toBe(false)
    expect(existsSync(machine.sys.conf)).toBe(false)
  })

  it("prefers the file in /etc to the one in HOME", () => {
    const machine = host({ docker: "works", uid: 0 })
    expect(machine.run([], { ...user(machine), PCP_PORT: "8080" }).status).toBe(
      0,
    )
    oldConf(machine, "PCP_PORT=9999\n")
    const result = machine.run([], user(machine))
    expect(result.calls.some((call) => call.includes("-p 8080:3000"))).toBe(
      true,
    )
    expect(result.stderr).not.toContain(machine.conf)
  })

  it("never reads HOME's file in the daily update", () => {
    const machine = host({ docker: "works", uid: 0 })
    oldConf(
      machine,
      "PCP_PORT=9999\nPCP_HTTPS=1\nPCP_RUNTIME=podman\nPCP_AUTO_UPDATE=1\n",
    )
    const result = machine.run(["update"], user(machine))
    expect(result.status).toBe(0)
    expect(result.calls).toContain(`docker ${RUN}`)
    expect(result.stderr).not.toContain(machine.conf)
    expect(existsSync(machine.sys.updater)).toBe(false)
    expect(readFileSync(machine.sys.conf, "utf8")).toContain("PCP_PORT=3000\n")
  })

  it("does not carry settings over on uninstall", () => {
    const machine = host({ docker: "works", uid: 0 })
    oldConf(machine, "PCP_DATA_VOLUME=vault\n")
    const result = machine.run(["uninstall"], user(machine))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("docker volume rm pcp-data")
    expect(result.stderr).not.toContain(machine.conf)
  })

  it("needs no HOME, as in a system service", () => {
    const machine = host({ docker: "works", uid: 0 })
    const result = machine.run([], { HOME: "", PCP_AUTO_UPDATE: "1" })
    expect(result.status).toBe(0)
    expect(existsSync(machine.sys.updater)).toBe(true)
  })

  it("puts the Quadlet unit in /etc and leaves HOME alone", () => {
    const machine = host({ podman: "5.2.2", uid: 0 })
    const result = machine.run([], user(machine))
    expect(result.status).toBe(0)
    expect(readFileSync(machine.sys.unit, "utf8")).toContain(
      "WantedBy=multi-user.target\n",
    )
    expect(existsSync(machine.unit)).toBe(false)
  })

  it("removes the copy, the timer and the settings on uninstall", () => {
    const machine = host({ docker: "works", uid: 0 })
    const env = { ...user(machine), PCP_AUTO_UPDATE: "1" }
    expect(machine.run([], env).status).toBe(0)
    for (const file of [
      machine.sys.updater,
      machine.sys.timer,
      machine.sys.service,
      machine.sys.conf,
    ]) {
      expect(existsSync(file)).toBe(true)
    }
    const result = machine.run(["uninstall"], user(machine))
    expect(result.status).toBe(0)
    expect(result.calls).toContain("systemctl disable --now pcp-update.timer")
    expect(existsSync(machine.sys.updater)).toBe(false)
    expect(existsSync(dirname(machine.sys.updater))).toBe(false)
    expect(existsSync(machine.sys.timer)).toBe(false)
    expect(existsSync(machine.sys.service)).toBe(false)
    expect(existsSync(machine.sys.conf)).toBe(false)
    expect(existsSync(dirname(machine.sys.conf))).toBe(false)
  })

  it("removes the copy when PCP_AUTO_UPDATE=0 takes the timer away", () => {
    const machine = host({ docker: "works", uid: 0 })
    expect(machine.run([], { PCP_AUTO_UPDATE: "1" }).status).toBe(0)
    expect(existsSync(machine.sys.updater)).toBe(true)
    expect(
      machine.run([], { PCP_AUTO_UPDATE: "0", PCP_UPDATE_BUTTON: "0" }).status,
    ).toBe(0)
    expect(existsSync(machine.sys.updater)).toBe(false)
    expect(existsSync(machine.sys.timer)).toBe(false)
  })
})

describe("install.sh next to another install", () => {
  const badpirate = { name: "badpirate", uid: 1000, pcp: true }
  const handOver = (calls: string[]) =>
    calls.find((call) => call.includes("systemd-run"))

  it("updates a user's rootless PCP as that user when root runs it", () => {
    const machine = host({ podman: "5.8.4", uid: 0, users: [badpirate] })
    const result = machine.run([], { PCP_CHANNEL: "develop" })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("PCP is installed for the user badpirate")
    expect(handOver(result.calls)).toMatch(
      new RegExp(
        "^runuser -u badpirate -- env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus " +
          "systemd-run --user --quiet --collect --wait --unit=pcp-install-\\d+ --setenv=PCP_CHANNEL=develop " +
          "sh -c curl -fsSL 'https://raw\\.githubusercontent\\.com/kaperkunde/pcp/main/install\\.sh' \\| sh$",
      ),
    )
    // Its output goes to the journal, never through this session, which
    // may end with the PCP being replaced.
    expect(handOver(result.calls)).not.toContain("--pipe")
    expect(result.stdout).toMatch(
      /journalctl _SYSTEMD_USER_UNIT=pcp-install-\d+\.service -f/,
    )
    // Root starts nothing of its own and writes nothing of its own.
    expect(started(result.calls)).toBe(false)
    expect(existsSync(machine.sys.unit)).toBe(false)
    expect(existsSync(machine.sys.conf)).toBe(false)
  })

  it("passes on only the settings given, so the user's own stay", () => {
    const machine = host({ podman: "5.8.4", uid: 0, users: [badpirate] })
    const result = machine.run([])
    expect(result.status).toBe(0)
    expect(handOver(result.calls)).not.toContain("--setenv")
  })

  it("leaves users without PCP, and system accounts, alone", () => {
    const machine = host({
      podman: "5.8.4",
      uid: 0,
      users: [
        { name: "pat", uid: 1001 },
        { name: "daemon", uid: 2, pcp: true },
      ],
    })
    const result = machine.run([])
    expect(result.status).toBe(0)
    expect(handOver(result.calls)).toBeUndefined()
    expect(existsSync(machine.sys.unit)).toBe(true)
  })

  it("says to run it as the user when root cannot reach their systemd", () => {
    const machine = host({
      podman: "5.8.4",
      uid: 0,
      users: [badpirate],
      userSession: false,
    })
    const result = machine.run([])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Update it as badpirate")
    expect(result.stderr).toContain("an empty vault")
    expect(handOver(result.calls)).toBeUndefined()
    expect(started(result.calls)).toBe(false)
  })

  it("names the users when more than one has PCP", () => {
    const machine = host({
      podman: "5.8.4",
      uid: 0,
      users: [badpirate, { name: "pat", uid: 1001, pcp: true }],
    })
    const result = machine.run([])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("more than one user here: badpirate pat.")
    expect(started(result.calls)).toBe(false)
  })

  it("says which to remove when root and a user both have PCP", () => {
    const machine = host({ podman: "5.8.4", uid: 0, users: [badpirate] })
    mkdirSync(dirname(machine.sys.unit), { recursive: true })
    writeFileSync(machine.sys.unit, UNIT)
    const result = machine.run([])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("PCP is installed twice here")
    expect(result.stderr).toContain("sh -s -- uninstall")
    expect(handOver(result.calls)).toBeUndefined()
    expect(started(result.calls)).toBe(false)
  })

  it("refuses a user's install next to root's", () => {
    const machine = host({ podman: "5.8.4" })
    mkdirSync(dirname(machine.sys.unit), { recursive: true })
    writeFileSync(machine.sys.unit, UNIT)
    const result = machine.run([])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Update it as root")
    expect(started(result.calls)).toBe(false)
    expect(existsSync(machine.unit)).toBe(false)
  })

  it("still lets root update and remove its own install", () => {
    const machine = host({ podman: "5.8.4", uid: 0 })
    expect(machine.run([]).status).toBe(0)
    const again = machine.run([])
    expect(again.status).toBe(0)
    expect(again.stdout).toContain("PCP is updated and running")
    expect(again.stdout).not.toContain("Open it now")
    expect(machine.run(["uninstall"]).status).toBe(0)
    expect(existsSync(machine.sys.unit)).toBe(false)
  })
})

describe("install.sh installing when PCP asks", () => {
  const ID = "0f8a4f6e-3c1b-4d2a-9e5f-7b6c5d4e3f21"
  const now = () => Math.floor(Date.now() / 1000)

  it("watches for the request by default, through a copy of the installer", () => {
    const machine = host({ docker: "works" })
    const result = machine.run()
    expect(result.status).toBe(0)
    expect(result.calls).toContain(`docker ${RUN}`)
    expect(readFileSync(machine.updater, "utf8")).toBe(
      readFileSync(INSTALL_SH, "utf8"),
    )
    expect(readFileSync(machine.watchService, "utf8")).toContain(
      `ExecStart=/bin/sh "${machine.updater}" watch`,
    )
    expect(readFileSync(machine.watchTimer, "utf8")).toContain(
      "OnUnitActiveSec=30s",
    )
    expect(result.calls).toContain(
      "systemctl --user enable --now pcp-update-request.timer",
    )
    expect(readFileSync(machine.conf, "utf8")).toContain(
      "PCP_UPDATE_BUTTON=1\n",
    )
    expect(result.stdout).toContain('"Install and restart" under Settings')
    // The daily update stays off.
    expect(existsSync(machine.timer)).toBe(false)
  })

  it("takes it away with PCP_UPDATE_BUTTON=0, and on uninstall", () => {
    const machine = host({ docker: "works" })
    expect(machine.run().status).toBe(0)

    const off = machine.run([], { PCP_UPDATE_BUTTON: "0" })
    expect(off.status).toBe(0)
    expect(off.calls).toContain(
      `docker run -d --name pcp --restart unless-stopped -p 3000:3000 -v pcp-data:/data ${IMAGE}`,
    )
    expect(off.calls).toContain(
      "systemctl --user disable --now pcp-update-request.timer",
    )
    expect(existsSync(machine.watchTimer)).toBe(false)
    expect(existsSync(machine.watchService)).toBe(false)
    expect(existsSync(machine.updater)).toBe(false)
    expect(readFileSync(machine.conf, "utf8")).toContain(
      "PCP_UPDATE_BUTTON=0\n",
    )

    expect(machine.run([], { PCP_UPDATE_BUTTON: "1" }).status).toBe(0)
    expect(existsSync(machine.watchTimer)).toBe(true)
    expect(machine.run(["uninstall"]).status).toBe(0)
    expect(existsSync(machine.watchTimer)).toBe(false)
    expect(existsSync(machine.updater)).toBe(false)
  })

  it("does not watch for a pinned version", () => {
    const machine = host({ docker: "works" })
    const result = machine.run([], { PCP_VERSION: "1.2.3" })
    expect(result.status).toBe(0)
    expect(result.calls).toContain(
      "docker run -d --name pcp --restart unless-stopped -p 3000:3000 -v pcp-data:/data ghcr.io/kaperkunde/pcp:1.2.3",
    )
    expect(existsSync(machine.watchTimer)).toBe(false)
  })

  it("keeps the copy for the request when the daily update goes to Podman", () => {
    const machine = host({ podman: "5.2.2" })
    expect(machine.run([], { PCP_AUTO_UPDATE: "1" }).status).toBe(0)
    expect(existsSync(machine.timer)).toBe(false)
    expect(existsSync(machine.watchTimer)).toBe(true)
    expect(existsSync(machine.updater)).toBe(true)
  })

  it("gives the crontab line when there is no systemd session", () => {
    const machine = host({ podman: "5.2.2", session: false })
    const result = machine.run()
    expect(result.status).toBe(0)
    expect(result.stderr).toContain(
      `* * * * * /bin/sh "${machine.updater}" watch`,
    )
    expect(existsSync(machine.watchTimer)).toBe(false)
    expect(existsSync(machine.updater)).toBe(true)
  })

  it("updates PCP once for a fresh request", () => {
    const machine = host({ docker: "works", signal: `${ID} ${now()}` })
    expect(machine.run().status).toBe(0)

    const result = machine.run(["watch"])
    expect(result.status).toBe(0)
    expect(result.calls).toContain("docker exec pcp cat /data/install-request")
    expect(result.calls).toContain(`docker pull -q ${IMAGE}`)
    expect(result.calls).toContain(`docker ${RUN}`)
    expect(readFileSync(machine.handled, "utf8")).toMatch(
      new RegExp(`^${ID} \\d+\n$`),
    )

    const again = machine.run(["watch"])
    expect(again.status).toBe(0)
    expect(started(again.calls)).toBe(false)
  })

  it("moves to the channel a request names, and remembers it", () => {
    const develop = `ghcr.io/kaperkunde/pcp:develop`
    const machine = host({ docker: "works", signal: `${ID} ${now()} develop` })
    expect(machine.run().status).toBe(0)

    const result = machine.run(["watch"])
    expect(result.status).toBe(0)
    expect(result.calls).toContain(`docker pull -q ${develop}`)
    expect(result.calls).toContain(
      `docker run -d --name pcp --restart unless-stopped -p 3000:3000 -e PCP_HOST_UPDATER=2 -v pcp-data:/data ${develop}`,
    )
    expect(readFileSync(machine.conf, "utf8")).toContain(
      "PCP_CHANNEL=develop\n",
    )

    // The daily update and the next install follow it.
    const update = machine.run(["update"])
    expect(update.calls).toContain(`docker pull -q ${develop}`)
  })

  it("stays on its channel for a request that names none or the same", () => {
    const machine = host({ docker: "works", signal: `${ID} ${now()} stable` })
    expect(machine.run().status).toBe(0)
    const result = machine.run(["watch"])
    expect(result.calls).toContain(`docker pull -q ${IMAGE}`)
    expect(readFileSync(machine.conf, "utf8")).toContain("PCP_CHANNEL=stable\n")
  })

  it("keeps root's note of the last request where only root writes", () => {
    const machine = host({
      docker: "works",
      uid: 0,
      signal: `${ID} ${now()}`,
    })
    expect(machine.run().status).toBe(0)
    expect(existsSync(machine.sys.watchTimer)).toBe(true)

    expect(started(machine.run(["watch"]).calls)).toBe(true)
    expect(readFileSync(machine.sys.handled, "utf8")).toContain(ID)
    expect(existsSync(machine.handled)).toBe(false)

    expect(machine.run(["uninstall"]).status).toBe(0)
    expect(existsSync(machine.sys.handled)).toBe(false)
    expect(existsSync(dirname(machine.sys.handled))).toBe(false)
  })

  it("waits five minutes before answering another request", () => {
    const machine = host({ docker: "works", signal: `${ID} ${now()}` })
    expect(machine.run().status).toBe(0)
    mkdirSync(dirname(machine.handled), { recursive: true })

    writeFileSync(machine.handled, `another ${now() - 60}\n`)
    expect(started(machine.run(["watch"]).calls)).toBe(false)

    writeFileSync(machine.handled, `another ${now() - 301}\n`)
    expect(started(machine.run(["watch"]).calls)).toBe(true)
  })

  it.each([
    ["an old request", `${ID} ${now() - 901}`],
    ["one from the future", `${ID} ${now() + 3600}`],
    ["a short id", `0f8a ${now()}`],
    ["an id with other characters", `${ID.replace("0f", "$(")} ${now()}`],
    ["a time that is not a number", `${ID} soon`],
    ["a second line", `${ID} ${now()}\nrm -rf /`],
    ["a channel it does not know", `${ID} ${now()} nightly`],
    ["a channel and more", `${ID} ${now()} develop now`],
    ["a channel on a second line", `${ID} ${now()} develop\nrm -rf /`],
    ["nothing", ""],
  ])("does nothing for %s", (_, signal) => {
    const machine = host({ docker: "works", signal })
    expect(machine.run().status).toBe(0)
    const result = machine.run(["watch"])
    expect(result.status).toBe(0)
    expect(started(result.calls)).toBe(false)
    expect(existsSync(machine.handled)).toBe(false)
  })

  it("does nothing when there is no request, PCP is not running, or it is turned off", () => {
    const none = host({ docker: "works" })
    expect(none.run().status).toBe(0)
    expect(started(none.run(["watch"]).calls)).toBe(false)

    const stopped = host({
      docker: "works",
      state: "exited",
      signal: `${ID} ${now()}`,
    })
    const watched = stopped.run(["watch"], { PCP_RUNTIME: "docker" })
    expect(watched.status).toBe(0)
    expect(started(watched.calls)).toBe(false)

    const off = host({ docker: "works", signal: `${ID} ${now()}` })
    expect(off.run([], { PCP_UPDATE_BUTTON: "0" }).status).toBe(0)
    expect(started(off.run(["watch"]).calls)).toBe(false)
  })

  it("refuses a value it does not understand", () => {
    const result = host({ docker: "works" }).run([], {
      PCP_UPDATE_BUTTON: "yes",
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("PCP_UPDATE_BUTTON must be 0 or 1")
  })
})

// The browser PCP runs shows sites the container's time zone and language, so
// the installer hands over the host's. Both end up on a command line or in a
// unit file, so only plain names get through.
describe("install.sh passing on the host's time zone and language", () => {
  const BERLIN = { TZ: "Europe/Berlin", LANG: "de_DE.UTF-8" }
  const runLine = (...env: string[]) =>
    `docker run -d --name pcp --restart unless-stopped -p 3000:3000 -e PCP_HOST_UPDATER=2${env
      .map((entry) => ` -e ${entry}`)
      .join("")} -v pcp-data:/data ${IMAGE}`
  const put = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  const leaks = (calls: string[]) => calls.join("\n").includes("TZ=")

  it("adds -e TZ and -e LANG to docker run, after the updater's and before the volume", () => {
    const result = host({ docker: "works" }).run([], BERLIN)
    expect(result.status).toBe(0)
    expect(result.calls).toContain(
      runLine("TZ=Europe/Berlin", "LANG=de_DE.UTF-8"),
    )
  })

  it("passes on the one it knows", () => {
    const machine = host({ docker: "works" })
    expect(machine.run([], { TZ: "UTC" }).calls).toContain(runLine("TZ=UTC"))
    expect(machine.run([], { LANG: "de_DE.UTF-8" }).calls).toContain(
      runLine("LANG=de_DE.UTF-8"),
    )
  })

  it("puts them after the settings it already passes", () => {
    const result = host({ docker: "works" }).run([], {
      ...BERLIN,
      PCP_AUTO_UPDATE: "1",
    })
    expect(result.calls).toContain(
      `docker run -d --name pcp --restart unless-stopped -p 3000:3000 -e PCP_AUTO_UPDATE=1 -e PCP_HOST_UPDATER=2 -e TZ=Europe/Berlin -e LANG=de_DE.UTF-8 -v pcp-data:/data ${IMAGE}`,
    )
  })

  it("does the same for a plain podman run", () => {
    const result = host({ podman: "4.3.1" }).run([], BERLIN)
    expect(result.status).toBe(0)
    expect(result.calls).toContain(
      `podman ${runLine("TZ=Europe/Berlin", "LANG=de_DE.UTF-8").slice("docker ".length)}`,
    )
  })

  it("writes them into the Quadlet unit, in the same order", () => {
    const machine = host({ podman: "5.2.2" })
    expect(machine.run([], BERLIN).status).toBe(0)
    expect(readFileSync(machine.unit, "utf8")).toBe(
      UNIT.replace(
        "Environment=PCP_HOST_UPDATER=2\n",
        "Environment=PCP_HOST_UPDATER=2\nEnvironment=TZ=Europe/Berlin\nEnvironment=LANG=de_DE.UTF-8\n",
      ),
    )
  })

  it("puts them after the auto-update label in the unit", () => {
    const machine = host({ podman: "5.2.2" })
    expect(machine.run([], { ...BERLIN, PCP_AUTO_UPDATE: "1" }).status).toBe(0)
    expect(readFileSync(machine.unit, "utf8")).toContain(
      "Environment=PCP_AUTO_UPDATE=1\nLabel=io.containers.autoupdate=registry\nEnvironment=PCP_HOST_UPDATER=2\nEnvironment=TZ=Europe/Berlin\nEnvironment=LANG=de_DE.UTF-8\n\n[Service]",
    )
  })

  it("passes nothing when the host has neither, as before", () => {
    const docker = host({ docker: "works" }).run()
    expect(docker.calls).toContain(`docker ${RUN}`)
    expect(leaks(docker.calls)).toBe(false)

    const machine = host({ podman: "5.2.2" })
    expect(machine.run().status).toBe(0)
    expect(readFileSync(machine.unit, "utf8")).toBe(UNIT)
  })

  it("passes them again when an update starts PCP from a new image", () => {
    const machine = host({ docker: "works" })
    expect(machine.run().status).toBe(0)
    const result = machine.run(["update"], BERLIN)
    expect(result.status).toBe(0)
    expect(result.calls).toContain(
      runLine("TZ=Europe/Berlin", "LANG=de_DE.UTF-8"),
    )
  })

  describe("the time zone", () => {
    it("is read from etc/timezone when TZ is not set", () => {
      const machine = host({ docker: "works" })
      put(machine.sys.timezone, "Europe/Berlin\n")
      const result = machine.run()
      expect(result.status).toBe(0)
      expect(result.calls).toContain(runLine("TZ=Europe/Berlin"))
    })

    it("is TZ when that is set, before anything on disk", () => {
      const machine = host({ docker: "works", timedatectl: "Asia/Tokyo" })
      put(machine.sys.timezone, "Europe/Rome\n")
      expect(machine.run([], { TZ: "America/New_York" }).calls).toContain(
        runLine("TZ=America/New_York"),
      )
    })

    it("is timedatectl's answer before etc/timezone", () => {
      const machine = host({ docker: "works", timedatectl: "Asia/Tokyo" })
      put(machine.sys.timezone, "Europe/Rome\n")
      expect(machine.run().calls).toContain(runLine("TZ=Asia/Tokyo"))
    })

    it("passes over timedatectl saying it does not know", () => {
      const machine = host({ docker: "works", timedatectl: "n/a" })
      put(machine.sys.timezone, "Europe/Rome\n")
      expect(machine.run().calls).toContain(runLine("TZ=Europe/Rome"))
    })

    it("is where etc/localtime points, with the path through zoneinfo/ cut off", () => {
      const machine = host({ docker: "works" })
      mkdirSync(dirname(machine.sys.localtime), { recursive: true })
      symlinkSync("../usr/share/zoneinfo/Europe/Paris", machine.sys.localtime)
      expect(machine.run().calls).toContain(runLine("TZ=Europe/Paris"))
    })

    it("is not a link that points somewhere other than zoneinfo", () => {
      const machine = host({ docker: "works" })
      mkdirSync(dirname(machine.sys.localtime), { recursive: true })
      symlinkSync("/usr/share/elsewhere/Paris", machine.sys.localtime)
      const result = machine.run()
      expect(result.calls).toContain(`docker ${RUN}`)
      expect(leaks(result.calls)).toBe(false)
    })

    it("goes on to the next place when TZ is not a zone name", () => {
      const machine = host({ docker: "works" })
      put(machine.sys.timezone, "Europe/Rome\n")
      expect(machine.run([], { TZ: "Europe/Berlin Evil" }).calls).toContain(
        runLine("TZ=Europe/Rome"),
      )
    })

    it.each([
      ["a space", "Europe/Berlin Evil"],
      ["a newline", "Europe/Berlin\n-v /:/host"],
      ["a second setting", "Europe/Berlin\nEnvironment=X=1"],
      ["a shell expansion", "$(id)"],
      ["a quote", 'Europe/"Berlin'],
      ["a percent sign", "Europe/%H"],
      ["a leading colon", ":Europe/Berlin"],
      ["a leading slash", "/etc/passwd"],
      ["a parent directory", "Europe/../../etc/passwd"],
      ["a POSIX rule", "CET-1CEST,M3.5.0,M10.5.0/3"],
    ])("is dropped when TZ has %s", (_, value) => {
      const docker = host({ docker: "works" }).run([], { TZ: value })
      expect(docker.status).toBe(0)
      expect(docker.calls).toContain(`docker ${RUN}`)
      expect(leaks(docker.calls)).toBe(false)

      const machine = host({ podman: "5.2.2" })
      expect(machine.run([], { TZ: value }).status).toBe(0)
      expect(readFileSync(machine.unit, "utf8")).toBe(UNIT)
    })

    it("is dropped when etc/timezone holds more than a name", () => {
      const machine = host({ docker: "works" })
      put(machine.sys.timezone, "Europe/Berlin\n-v /:/host\n")
      const result = machine.run()
      expect(result.calls).toContain(`docker ${RUN}`)
      expect(leaks(result.calls)).toBe(false)
    })
  })

  describe("the language", () => {
    it.each([
      ["a space", "de DE"],
      ["a newline", "de_DE.UTF-8\n-v /:/host"],
      ["a second setting", "de_DE.UTF-8\nEnvironment=X=1"],
      ["a shell expansion", "$(id)"],
      ["a semicolon", "de_DE;x"],
      ["a percent sign", "de_%H"],
    ])("is dropped when LANG has %s", (_, value) => {
      const docker = host({ docker: "works" }).run([], { LANG: value })
      expect(docker.status).toBe(0)
      expect(docker.calls).toContain(`docker ${RUN}`)

      const machine = host({ podman: "5.2.2" })
      expect(machine.run([], { LANG: value }).status).toBe(0)
      expect(readFileSync(machine.unit, "utf8")).toBe(UNIT)
    })

    it("keeps the one that is good when the other is dropped", () => {
      const result = host({ docker: "works" }).run([], {
        TZ: "Europe/Berlin Evil",
        LANG: "de_DE@euro",
      })
      expect(result.calls).toContain(runLine("LANG=de_DE@euro"))
    })
  })
})

// PCP's browser draws with the graphics card when the container has its
// render node (kaperkunde/pcp#38), so the installer passes /dev/dri in where
// the host has one, with the node's group where PCP's user needs it.
describe("install.sh passing on the host's graphics card", () => {
  const OPEN = { mode: "crw-rw-rw-", gid: 105, group: "render" }
  const GROUP_ONLY = { mode: "crw-rw----+", gid: 105, group: "render" }
  const runLine = (...gpu: string[]) =>
    `docker run -d --name pcp --restart unless-stopped -p 3000:3000 -e PCP_HOST_UPDATER=2${gpu
      .map((entry) => ` ${entry}`)
      .join("")} -v pcp-data:/data ${IMAGE}`
  const note = (stderr: string) =>
    stderr.includes("draws in software rather than with this computer's")

  it("passes nothing when the host has no /dev/dri, as before", () => {
    const docker = host({ docker: "works" }).run()
    expect(docker.calls).toContain(`docker ${RUN}`)
    expect(docker.calls.join("\n")).not.toContain("/dev/dri")
    expect(note(docker.stderr)).toBe(false)

    const machine = host({ podman: "5.2.2" })
    expect(machine.run().status).toBe(0)
    expect(readFileSync(machine.unit, "utf8")).toBe(UNIT)
  })

  it("passes nothing for a card without a render node", () => {
    const docker = host({ docker: "works", dri: "card only" }).run()
    expect(docker.calls).toContain(`docker ${RUN}`)
  })

  it("passes /dev/dri alone when everyone may open the render node (Fedora, Bazzite)", () => {
    const docker = host({ docker: "works", dri: OPEN }).run()
    expect(docker.status).toBe(0)
    expect(docker.calls).toContain(runLine("--device /dev/dri"))
    expect(note(docker.stderr)).toBe(false)

    const machine = host({ podman: "5.2.2", dri: OPEN })
    expect(machine.run().status).toBe(0)
    expect(readFileSync(machine.unit, "utf8")).toBe(
      UNIT.replace(
        "Environment=PCP_HOST_UPDATER=2\n",
        "Environment=PCP_HOST_UPDATER=2\nAddDevice=/dev/dri\n",
      ),
    )
  })

  it("puts it after the time zone and language, before the volume", () => {
    const result = host({ docker: "works", dri: OPEN }).run([], {
      TZ: "Europe/Berlin",
    })
    expect(result.calls).toContain(
      runLine("-e TZ=Europe/Berlin", "--device /dev/dri"),
    )
  })

  it("adds the render node's group by number under Docker", () => {
    const result = host({ docker: "works", dri: GROUP_ONLY }).run()
    expect(result.status).toBe(0)
    expect(result.calls).toContain(
      runLine("--device /dev/dri", "--group-add 105"),
    )
    expect(note(result.stderr)).toBe(false)
  })

  it("adds it by number for root's Podman, in the unit too", () => {
    const machine = host({ podman: "5.2.2", uid: 0, dri: GROUP_ONLY })
    expect(machine.run().status).toBe(0)
    expect(readFileSync(machine.sys.unit, "utf8")).toContain(
      "AddDevice=/dev/dri\nGroupAdd=105\n",
    )
  })

  it("hands a Podman without root your groups, when you are in the node's", () => {
    const machine = host({
      podman: "5.2.2",
      dri: GROUP_ONLY,
      groups: [1000, 105],
    })
    const result = machine.run()
    expect(result.status).toBe(0)
    expect(readFileSync(machine.unit, "utf8")).toContain(
      "AddDevice=/dev/dri\nGroupAdd=keep-groups\n",
    )
    expect(note(result.stderr)).toBe(false)

    const plain = host({
      podman: "4.3.1",
      dri: GROUP_ONLY,
      groups: [1000, 105],
    })
    expect(plain.run().calls).toContain(
      `podman ${runLine("--device /dev/dri", "--group-add keep-groups").slice("docker ".length)}`,
    )
  })

  it("says how to join the group when you are not in it, and still passes the device", () => {
    const machine = host({ podman: "5.2.2", dri: GROUP_ONLY, groups: [1000] })
    const result = machine.run()
    expect(result.status).toBe(0)
    const unit = readFileSync(machine.unit, "utf8")
    expect(unit).toContain("AddDevice=/dev/dri\n")
    expect(unit).not.toContain("GroupAdd")
    expect(note(result.stderr)).toBe(true)
    expect(result.stderr).toContain("sudo usermod -aG render pat")
    // It never runs sudo itself.
    expect(result.calls.some((call) => call.startsWith("sudo"))).toBe(false)
  })

  it("adds no keep-groups without crun, which alone knows it", () => {
    const machine = host({
      podman: "5.2.2",
      dri: GROUP_ONLY,
      groups: [1000, 105],
      ociRuntime: "runc",
    })
    const result = machine.run()
    expect(result.status).toBe(0)
    expect(readFileSync(machine.unit, "utf8")).not.toContain("GroupAdd")
    expect(result.stderr).toContain("crun runtime, not runc")
  })

  it("leaves GroupAdd out of the unit of a Podman older than 5.1, which would refuse it", () => {
    const machine = host({
      podman: "5.0.3",
      dri: GROUP_ONLY,
      groups: [1000, 105],
    })
    const result = machine.run()
    expect(result.status).toBe(0)
    const unit = readFileSync(machine.unit, "utf8")
    expect(unit).toContain("AddDevice=/dev/dri\n")
    expect(unit).not.toContain("GroupAdd")
    expect(result.stderr).toContain("Podman 5.0.3 cannot add")
  })

  it("adds no group a rootless Docker cannot map, and says so", () => {
    const result = host({
      docker: "works",
      dri: GROUP_ONLY,
      dockerRootless: true,
    }).run()
    expect(result.status).toBe(0)
    expect(result.calls).toContain(runLine("--device /dev/dri"))
    expect(result.stderr).toContain("Docker without root")
  })

  it("never adds root's group", () => {
    const result = host({
      docker: "works",
      dri: { mode: "crw-rw----", gid: 0, group: "root" },
    }).run()
    expect(result.calls).toContain(runLine("--device /dev/dri"))
  })

  it("leaves the card out with PCP_GPU=0, and remembers it", () => {
    const machine = host({ docker: "works", dri: GROUP_ONLY })
    const first = machine.run([], { PCP_GPU: "0" })
    expect(first.status).toBe(0)
    expect(first.calls).toContain(`docker ${RUN}`)
    expect(readFileSync(machine.conf, "utf8")).toContain("PCP_GPU=0\n")

    // The daily update has no PCP_GPU of its own: the remembered one holds.
    expect(machine.run(["update"]).calls).toContain(`docker ${RUN}`)
    // Until it is turned back on.
    expect(machine.run([], { PCP_GPU: "1" }).calls).toContain(
      runLine("--device /dev/dri", "--group-add 105"),
    )
  })

  it("refuses a PCP_GPU it does not understand", () => {
    const result = host({ docker: "works" }).run([], { PCP_GPU: "yes" })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain("PCP_GPU must be 0 or 1")
  })

  it("passes it again when an update starts PCP from a new image", () => {
    const machine = host({ docker: "works", dri: GROUP_ONLY })
    expect(machine.run().status).toBe(0)
    const result = machine.run(["update"])
    expect(result.status).toBe(0)
    expect(result.calls).toContain(
      runLine("--device /dev/dri", "--group-add 105"),
    )
  })
})
