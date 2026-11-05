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
  /** Named volumes on the host, made by `run` (or a test). */
  volumes: string[]
  volumesRemoved: string[]
  /**
   * `run` makes the container (and its volumes) and then fails to start
   * it with this error, as Docker does when a port is taken.
   */
  runFailsAfterCreate: string | null
  /** `rm` of a container that is there fails with this error. */
  failRm: string | null
  /** `volume rm` fails with this error. */
  failVolumeRm: string | null
  /** The tarball `curl` and `wget` hand over: a test's repository. */
  tarball: string | null
  /** Addresses downloaded, and with which program. */
  downloads: Array<{ program: string; url: string; args: string[] }>
  /** Builds, as the engine got them. */
  builds: Array<{
    file: string
    containerfile: string
    context: string
    contextFiles: string[]
    tag: string | null
    buildArgs: string[]
  }>
  /** The image id a build makes (64 hex), and its size in bytes. */
  buildId: string
  imageSize: number
  /** A build fails with this error. */
  failBuild: string | null
  /** Images on the host by id (sha256:…), made by `build`. */
  images: string[]
  imagesRemoved: string[]
  /** What `cp -` was handed: where to, and how many bytes of tar stream. */
  copiedIn: Array<{ to: string; bytes: number }>
}

export type FakeDocker = {
  run: FakeRun
  state: () => FakeDockerState
  update: (change: (state: FakeDockerState) => void) => void
  /** Files left in the temporary directory commands use. */
  leftovers: () => string[]
  /** The fake's own folder, for a test's repository tarball. */
  dir: string
  /** Where a named volume's files are, in the fake's own folder. */
  volumeDir: (volume: string) => string
  /** Takes curl or wget off the login's PATH. */
  withoutDownloader: (program: "curl" | "wget") => void
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
} else if (command === "build") {
  if (state.failBuild) fail(state.failBuild + "\n")
  const file = option("--file")
  const iid = option("--iidfile")
  const context = args[args.length - 1]
  if (!fs.existsSync(file)) fail("Error: no such file " + file + "\n")
  if (!fs.statSync(context).isDirectory()) fail("Error: context is no folder\n")
  const buildArgs = []
  args.forEach((word, at) => { if (word === "--build-arg") buildArgs.push(args[at + 1]) })
  const walk = (dir, prefix) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(dir + "/" + entry.name, prefix + entry.name + "/") : [prefix + entry.name])
  state.builds.push({ file, containerfile: fs.readFileSync(file, "utf8"), context, contextFiles: walk(context, "").sort(), tag: option("--tag"), buildArgs })
  process.stdout.write("STEP 1/2: FROM scratch\n")
  fs.writeFileSync(iid, "sha256:" + state.buildId)
  if (!state.images.includes("sha256:" + state.buildId)) state.images.push("sha256:" + state.buildId)
} else if (command === "rmi") {
  const id = args[args.length - 1]
  state.images = state.images.filter((each) => each !== id)
  state.imagesRemoved.push(id)
} else if (command === "image" && args[1] === "inspect" && args.includes("{{.Size}}")) {
  const id = args[args.length - 1]
  if (!state.images.includes(id)) fail("Error: No such image: " + id + "\n")
  out(String(state.imageSize) + "\n")
} else if (command === "image" && args[1] === "inspect" && args.includes("{{.Id}}")) {
  const id = args[args.length - 1]
  if (!state.images.includes(id)) fail("Error: No such image: " + id + "\n")
  out(id + "\n")
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
  for (const mount of volumes) { const volume = mount.split(":")[0]; if (!state.volumes.includes(volume)) state.volumes.push(volume); fs.mkdirSync(require("node:path").join(require("node:path").dirname(file), "volumes", volume), { recursive: true }) }
  if (state.runFailsAfterCreate) {
    state.containers[name] = { name, image, label, state: "created", exitCode: 0, health: null, args: args.slice(at + 1), publish, volumes, capAdd, devices, env }
    fail(state.runFailsAfterCreate + "\n", 125)
  }
  state.containers[name] = { name, image, label, state: state.runState, exitCode: state.runState === "exited" ? 1 : 0, health: state.runHealth, args: args.slice(at + 1), publish, volumes, capAdd, devices, env }
  out("c0ffee\n")
} else if (command === "inspect") {
  const name = args[args.length - 1]
  const c = state.containers[name]
  if (!c) fail("Error: No such object: " + name + "\n")
  const s = { Status: c.state, Running: c.state === "running", StartedAt: "2026-10-29T10:00:00Z", ExitCode: c.exitCode, Error: "" }
  if (c.health) s.Health = { Status: c.health }
  const imageId = c.image.startsWith("sha256:") ? c.image : "sha256:" + "f".repeat(64)
  out(JSON.stringify([s, c.image, c.label ? { "pcp.service": c.label } : {}, imageId]) + "\n")
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
  const name = args[args.length - 1]
  if (!state.containers[name]) fail("Error: No such container: " + name + "\n")
  if (state.failRm) fail(state.failRm + "\n")
  delete state.containers[name]
} else if (command === "volume" && args[1] === "rm") {
  if (state.failVolumeRm) fail(state.failVolumeRm + "\n")
  for (const volume of args.slice(2)) {
    if (!state.volumes.includes(volume)) fail("Error: No such volume: " + volume + "\n")
    state.volumes = state.volumes.filter((each) => each !== volume)
    state.volumesRemoved.push(volume)
  }
} else if (command === "volume" && args[1] === "inspect") {
  const volume = args[args.length - 1]
  if (!state.volumes.includes(volume)) fail("Error: No such volume: " + volume + "\n")
  out(JSON.stringify([{ Name: volume }]) + "\n")
} else if (command === "cp") {
  // A container's volumes are folders of the fake's own (volumes/<name>),
  // and the tar streams the machine's own tar: what PCP builds and reads
  // is tested against a real one.
  const child = require("node:child_process")
  const path = require("node:path")
  const root = path.join(path.dirname(file), "volumes")
  const resolve = (spec) => {
    const at = spec.indexOf(":")
    const name = spec.slice(0, at)
    const inner = spec.slice(at + 1)
    const c = state.containers[name]
    if (!c) fail("Error: No such container: " + name + "\n")
    for (const mount of c.volumes) {
      const [volume, mounted] = mount.split(":")
      if (inner === mounted || inner.startsWith(mounted + "/")) {
        fs.mkdirSync(path.join(root, volume), { recursive: true })
        return { name, inner, where: path.join(root, volume, inner.slice(mounted.length)) }
      }
    }
    fail("Error: the fake keeps files in volumes only, not at " + inner + "\n")
  }
  const there = (where) => { try { fs.lstatSync(where); return true } catch { return false } }
  if (args[1] === "-") {
    const target = resolve(args[2])
    if (!there(target.where) || !fs.statSync(target.where).isDirectory()) fail("Error: No such container:path: " + args[2] + "\n")
    const input = fs.readFileSync(0)
    state.copiedIn.push({ to: target.inner, bytes: input.length })
    const made = child.spawnSync("tar", ["-x", "-f", "-", "-C", target.where, "--no-same-owner"], { input })
    if (made.status !== 0) fail("Error: " + String(made.stderr))
  } else {
    const source = resolve(args[1])
    if (!there(source.where)) fail("Error response from daemon: Could not find the file " + source.inner + " in container " + source.name + "\n")
    const made = child.spawnSync("tar", ["-c", "-f", "-", "-C", path.dirname(source.where), path.basename(source.where)], { maxBuffer: 1024 * 1024 * 1024 })
    if (made.status !== 0) fail("Error: " + String(made.stderr))
    save()
    process.stdout.write(made.stdout)
    return
  }
} else {
  fail("unknown command " + command + "\n")
}
save()
`

/**
 * curl and wget for tests: each records the address it was given and hands
 * over the test's tarball (state.tarball), as GitHub would.
 */
const DOWNLOADER = String.raw`
const fs = require("node:fs")
const path = require("node:path")
const file = process.env.FAKE_DOCKER_STATE
const state = JSON.parse(fs.readFileSync(file, "utf8"))
const args = process.argv.slice(2)
const program = path.basename(process.argv[1])
const url = args[args.length - 1]
state.downloads.push({ program, url, args })
fs.writeFileSync(file, JSON.stringify(state))
const at = args.indexOf(program === "curl" ? "-o" : "-O")
if (!state.tarball || !url.startsWith("https://")) { process.stderr.write(program + ": (22) The requested URL returned error: 404\n"); process.exit(22) }
fs.copyFileSync(state.tarball, args[at + 1])
`

/**
 * A repository's tarball at a commit as GitHub's codeload serves it: every
 * file under one folder named after the repository and the commit. Made
 * with the machine's own tar, for tests only.
 */
export function fakeRepositoryTarball(
  dir: string,
  files: Record<string, string>,
  { links = {} }: { links?: Record<string, string> } = {},
): string {
  const root = path.join(dir, "repo-src")
  const top = path.join(root, "repo-0123456789")

  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(top, name)), { recursive: true })
    writeFileSync(path.join(top, name), content)
  }

  for (const [name, target] of Object.entries(links)) {
    mkdirSync(path.dirname(path.join(top, name)), { recursive: true })
    symlinkSync(target, path.join(top, name))
  }

  const tarball = path.join(dir, "repo.tar.gz")
  const made = spawnSync("tar", [
    "-czf",
    tarball,
    "-C",
    root,
    "repo-0123456789",
  ])

  if (made.status !== 0) {
    throw new Error(`tar did not make the test's repository: ${made.stderr}`)
  }

  rmSync(root, { recursive: true, force: true })
  return tarball
}

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
  for (const tool of [
    "sh",
    "cat",
    "rm",
    "mktemp",
    "true",
    "mkdir",
    "wc",
    "tail",
    "tar",
    "gzip",
  ]) {
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

  // A test takes either away by deleting it (`withoutDownloader`).
  for (const downloader of ["curl", "wget"]) {
    const file = path.join(bin, downloader)
    writeFileSync(file, `#!${process.execPath}\n${DOWNLOADER}`)
    chmodSync(file, 0o755)
  }

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
    volumes: [],
    volumesRemoved: [],
    runFailsAfterCreate: null,
    failRm: null,
    failVolumeRm: null,
    tarball: null,
    downloads: [],
    builds: [],
    buildId: "d".repeat(64),
    imageSize: 50 * 1024 * 1024,
    failBuild: null,
    images: [],
    imagesRemoved: [],
    copiedIn: [],
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
        // A file copied out with cp comes back whole.
        maxBuffer: 64 * 1024 * 1024,
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
    dir,
    volumeDir: (volume) => path.join(dir, "volumes", volume),
    withoutDownloader: (program) => rmSync(path.join(bin, program)),
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}
