import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { FakeRun } from "../ssh/fake-server"

/**
 * A Docker (or Podman) for tests: the command the SSH test server gets is
 * run by a real sh, with a `docker` on its PATH that is a small Node
 * program recording each call's words and the env file it was handed, and
 * keeping containers in a JSON file. So quoting is tested against a real
 * shell, and what reached the engine's command line against what PCP sent.
 * Never used outside tests.
 */

export type FakeContainer = {
  name: string
  image: string
  label: string | null
  state: string
  exitCode: number
  health: string | null
  args: string[]
  publish: string[]
  volumes: string[]
  capAdd: string[]
  devices: string[]
  /** The env file's text as the engine read it. */
  env: string
}

export type FakeDockerState = {
  version: string
  containers: Record<string, FakeContainer>
  /** What `run` makes: running unless a test says otherwise. */
  runState: string
  /** The image's own health check, if it has one. */
  runHealth: string | null
  /** What `logs` writes. */
  logs: string
  /** The digest a tag resolves to. */
  digest: string
  /** Pulls of these fail. */
  failPull: string[]
  /** Calls, as the words the engine got. */
  calls: string[][]
  /** Env files read by `run`. */
  envFiles: string[]
  volumesRemoved: string[]
}

export type FakeDocker = {
  run: FakeRun
  state: () => FakeDockerState
  update: (change: (state: FakeDockerState) => void) => void
  /** Files left in the temporary directory commands use. */
  leftovers: () => string[]
  /** Every process's command line PCP's commands ran with (as `ps` would show). */
  commands: string[]
  close: () => void
}

const PROGRAM = String.raw`
const fs = require("node:fs")
const file = process.env.FAKE_DOCKER_STATE
const state = JSON.parse(fs.readFileSync(file, "utf8"))
const args = process.argv.slice(2)
state.calls.push(args)
const save = () => fs.writeFileSync(file, JSON.stringify(state))
const out = (text) => process.stdout.write(text)
const fail = (text, code = 1) => { save(); process.stderr.write(text); process.exit(code) }
const option = (name) => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1] }
const command = args[0]

if (command === "version") {
  out(state.version + "\n")
} else if (command === "pull") {
  const image = args[args.length - 1]
  if (state.failPull.includes(image)) fail("Error: pull access denied for " + image + "\n")
  out(image + "\n")
} else if (command === "image" && args[1] === "inspect") {
  const source = args[args.length - 1]
  const repo = source.replace(/:[^:/]+$/, "")
  out(JSON.stringify([repo + "@" + state.digest]) + "\n")
} else if (command === "run") {
  const name = option("--name")
  if (state.containers[name]) fail("Error: Conflict. The container name \"/" + name + "\" is already in use\n", 125)
  const envPath = option("--env-file")
  const env = fs.readFileSync(envPath, "utf8")
  state.envFiles.push(env)
  const publish = [], volumes = [], capAdd = [], devices = []
  let at = 1, image = null
  while (at < args.length) {
    const word = args[at]
    if (!word.startsWith("--")) { image = word; break }
    if (word === "--publish") publish.push(args[at + 1])
    if (word === "--volume") volumes.push(args[at + 1])
    if (word === "--cap-add") capAdd.push(args[at + 1])
    if (word === "--device") devices.push(args[at + 1])
    at += word === "--detach" ? 1 : 2
  }
  const label = (option("--label") || "").replace(/^pcp\.service=/, "") || null
  state.containers[name] = { name, image, label, state: state.runState, exitCode: state.runState === "exited" ? 1 : 0, health: state.runHealth, args: args.slice(at + 1), publish, volumes, capAdd, devices, env }
  out("c0ffee\n")
} else if (command === "inspect") {
  const name = args[args.length - 1]
  const c = state.containers[name]
  if (!c) fail("Error: No such object: " + name + "\n")
  const s = { Status: c.state, Running: c.state === "running", StartedAt: "2026-10-29T10:00:00Z", ExitCode: c.exitCode, Error: "" }
  if (c.health) s.Health = { Status: c.health }
  out(JSON.stringify([s, c.image, c.label ? { "pcp.service": c.label } : {}]) + "\n")
} else if (command === "logs") {
  const name = args[args.length - 1]
  if (!state.containers[name]) fail("Error: No such container: " + name + "\n")
  out(state.logs)
} else if (command === "start" || command === "restart") {
  const c = state.containers[args[args.length - 1]]
  if (!c) fail("Error: No such container\n")
  c.state = "running"; c.exitCode = 0
} else if (command === "stop") {
  const c = state.containers[args[args.length - 1]]
  if (!c) fail("Error: No such container\n")
  c.state = "exited"; c.exitCode = 0
} else if (command === "rm") {
  delete state.containers[args[args.length - 1]]
} else if (command === "volume" && args[1] === "rm") {
  state.volumesRemoved.push(...args.slice(2))
} else {
  fail("unknown command " + command + "\n")
}
save()
`

export function startFakeDocker({
  engine = "docker",
}: { engine?: "docker" | "podman" } = {}): FakeDocker {
  const dir = mkdtempSync(path.join(tmpdir(), "pcp-fake-docker-"))
  const bin = path.join(dir, "bin")
  const basics = path.join(dir, "basics")
  const tmp = path.join(dir, "tmp")
  const stateFile = path.join(dir, "state.json")
  mkdirSync(bin)
  mkdirSync(basics)
  mkdirSync(tmp)

  // Only what the scripts use, so an engine installed on the test machine
  // is never the one found.
  for (const tool of ["sh", "cat", "rm", "mktemp", "true"]) {
    const found = ["/bin", "/usr/bin"]
      .map((where) => path.join(where, tool))
      .find((candidate) => existsSync(candidate))
    if (found) {
      symlinkSync(found, path.join(basics, tool))
    }
  }

  const script = path.join(bin, engine)
  writeFileSync(script, `#!${process.execPath}\n${PROGRAM}`)
  chmodSync(script, 0o755)

  const initial: FakeDockerState = {
    version: "27.3.1",
    containers: {},
    runState: "running",
    runHealth: null,
    logs: "",
    digest: `sha256:${"b".repeat(64)}`,
    failPull: [],
    calls: [],
    envFiles: [],
    volumesRemoved: [],
  }
  writeFileSync(stateFile, JSON.stringify(initial))

  const read = (): FakeDockerState =>
    JSON.parse(readFileSync(stateFile, "utf8")) as FakeDockerState
  const commands: string[] = []

  return {
    commands,
    run: (command, stdin) => {
      commands.push(command)
      // The login shell: sh, with only the fake engine and the basics on
      // its PATH.
      const result = spawnSync("/bin/sh", ["-c", command], {
        input: stdin,
        cwd: dir,
        env: {
          PATH: `${bin}:${basics}`,
          TMPDIR: tmp,
          FAKE_DOCKER_STATE: stateFile,
        } as unknown as NodeJS.ProcessEnv,
        timeout: 20_000,
      })

      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.status ?? 1,
      }
    },
    state: read,
    update: (change) => {
      const state = read()
      change(state)
      writeFileSync(stateFile, JSON.stringify(state))
    },
    leftovers: () => readdirSync(tmp),
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}
