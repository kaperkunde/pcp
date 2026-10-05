import { createWriteStream, existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import { pipeline } from "node:stream/promises"

import {
  CHROMIUM_DOWNLOAD_STALL_MS,
  CHROMIUM_DOWNLOAD_TIMEOUT_MS,
  MAX_CHROMIUM_DOWNLOAD_BYTES,
} from "./limits"

/**
 * Chromium for a machine that has none, the desktop app's above all:
 * the build this version of playwright-core drives, downloaded from the
 * addresses Playwright pins for it and unpacked under PCP's data folder
 * (`browsers/chromium-<revision>/`), in this process. Playwright's own
 * installer downloads in a child process, which the desktop app cannot
 * start (its runAsNode fuse is off), so only its list of addresses and its
 * unzip are used.
 *
 * The owner's click starts it and nothing else: no address comes from a
 * request, and nothing runs (no timer, no request) until then. A newer
 * playwright-core drives a newer build, which is looked for in its own
 * folder; installing it removes the older ones.
 */

export type ChromiumBuild = {
  revision: string
  /** Playwright's own addresses for this build, tried in turn. */
  urls: string[]
  /** The executable, relative to the unpacked archive. */
  executable: string
}

export type InstallStage =
  "idle" | "downloading" | "unpacking" | "done" | "failed"

export type InstallState = {
  stage: InstallStage
  received: number
  /** From the server's Content-Length; null when it sends none. */
  total: number | null
  error: string | null
}

export type InstallOptions = {
  dataDir: string
  /** Tests: a build of their own, and how it is fetched and unpacked. */
  build?: ChromiumBuild
  fetcher?: typeof fetch
  extract?: (zipPath: string, dir: string) => Promise<void>
}

const MARKER = "INSTALLATION_COMPLETE"
const PREFIX = "chromium-"
const WORK_PREFIX = ".install-"

const IDLE: InstallState = {
  stage: "idle",
  received: 0,
  total: null,
  error: null,
}

type Installer = {
  state: InstallState
  running: Promise<InstallState> | null
}

const INSTALLER = Symbol.for("pcp.browser.install")

/** One per process, on globalThis like the browser's runtime. */
function installer(): Installer {
  const holder = globalThis as unknown as { [INSTALLER]?: Installer }
  holder[INSTALLER] ??= { state: IDLE, running: null }
  return holder[INSTALLER]
}

/** The Chromium build playwright-core drives, as Playwright publishes it. */
export async function chromiumBuild(): Promise<ChromiumBuild | null> {
  try {
    const { registry } = await import("playwright-core/lib/coreBundle")
    const found = registry.registry.findExecutable("chromium")
    const full = found?.executablePath()

    if (
      !found?.directory ||
      !full ||
      !found.revision ||
      !/^[\w.-]+$/.test(found.revision) ||
      found.downloadURLs.length === 0
    ) {
      return null
    }

    return {
      revision: found.revision,
      urls: [...found.downloadURLs],
      executable: path.relative(found.directory, full),
    }
  } catch {
    return null
  }
}

function browsersDir(dataDir: string): string {
  return path.join(dataDir, "browsers")
}

function buildDir(dataDir: string, build: ChromiumBuild): string {
  return path.join(browsersDir(dataDir), PREFIX + build.revision)
}

/** The executable of PCP's own install of the current build, if done. */
export async function installedChromium(
  dataDir: string,
  build: ChromiumBuild | null = null,
): Promise<string | null> {
  const current = build ?? (await chromiumBuild())

  if (!current) {
    return null
  }

  const dir = buildDir(dataDir, current)
  const executable = path.join(dir, current.executable)

  return existsSync(path.join(dir, MARKER)) && existsSync(executable)
    ? executable
    : null
}

/** PCP installed a build before this one, which no longer runs here. */
export async function olderChromiumInstalled(
  dataDir: string,
  build: ChromiumBuild | null = null,
): Promise<boolean> {
  const current = build ?? (await chromiumBuild())
  const entries = await fs.readdir(browsersDir(dataDir)).catch(() => [])

  return entries.some(
    (name) =>
      name.startsWith(PREFIX) &&
      (!current || name !== PREFIX + current.revision),
  )
}

export function chromiumInstallState(): InstallState {
  return { ...installer().state }
}

export function chromiumInstalling(): boolean {
  return installer().running !== null
}

/**
 * Installs the current build unless it is there; a second call while one
 * runs joins it. Resolves with how it ended, and never rejects: a failure
 * is the state's error, for the Browser page to show.
 */
export function installChromium(
  options: InstallOptions,
): Promise<InstallState> {
  const self = installer()

  if (self.running) {
    return self.running
  }

  self.state = { stage: "downloading", received: 0, total: null, error: null }
  self.running = install(self, options)
    .then(
      (): InstallState => ({ ...self.state, stage: "done", error: null }),
      (error: unknown): InstallState => ({
        ...self.state,
        stage: "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .then((state) => {
      self.state = state
      self.running = null
      return { ...state }
    })

  return self.running
}

async function install(self: Installer, options: InstallOptions) {
  const build = options.build ?? (await chromiumBuild())

  if (!build) {
    throw new Error(
      `Playwright has no Chromium build for this system (${process.platform}, ${process.arch}).`,
    )
  }

  if (await installedChromium(options.dataDir, build)) {
    return
  }

  const browsers = browsersDir(options.dataDir)
  await fs.mkdir(browsers, { recursive: true })
  await removeEntries(browsers, (name) => name.startsWith(WORK_PREFIX))

  const work = await fs.mkdtemp(path.join(browsers, WORK_PREFIX))

  try {
    const zip = path.join(work, "chromium.zip")
    await downloadFirst(build.urls, zip, self, options.fetcher ?? fetch)

    self.state = { ...self.state, stage: "unpacking" }
    const unpacked = path.join(work, "chromium")
    await (options.extract ?? extractZip)(zip, unpacked)
    await fs.rm(zip, { force: true })

    const executable = path.join(unpacked, build.executable)

    if (!existsSync(executable)) {
      throw new Error(
        "The download did not hold Chromium where Playwright says it is.",
      )
    }

    if (process.platform !== "win32") {
      await fs.chmod(executable, 0o755)
    }

    // The marker goes in before the folder takes its name, so a folder of
    // that name is always a whole install.
    await fs.writeFile(path.join(unpacked, MARKER), "")
    const target = buildDir(options.dataDir, build)
    await fs.rm(target, { recursive: true, force: true })
    await fs.rename(unpacked, target)
    await removeEntries(
      browsers,
      (name) => name.startsWith(PREFIX) && name !== path.basename(target),
    )
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}

async function extractZip(zipPath: string, dir: string): Promise<void> {
  const { utils } = await import("playwright-core/lib/coreBundle")
  await utils.extractZip(zipPath, { dir })
}

async function removeEntries(
  dir: string,
  matches: (name: string) => boolean,
): Promise<void> {
  const entries = await fs.readdir(dir).catch(() => [])

  for (const name of entries.filter(matches)) {
    await fs.rm(path.join(dir, name), { recursive: true, force: true })
  }
}

/** Each address in turn; the last one's failure is the one told. */
async function downloadFirst(
  urls: string[],
  file: string,
  self: Installer,
  fetcher: typeof fetch,
): Promise<void> {
  let failure: unknown = new Error(
    "Playwright lists no address to download from.",
  )

  for (const url of urls) {
    try {
      await download(url, file, self, fetcher)
      return
    } catch (error) {
      failure = error
      await fs.rm(file, { force: true })
    }
  }

  throw failure
}

async function download(
  url: string,
  file: string,
  self: Installer,
  fetcher: typeof fetch,
): Promise<void> {
  const host = new URL(url).host
  const controller = new AbortController()
  const stop = (message: string) =>
    controller.abort(new Error(`${message} (${host}).`))
  const overall = setTimeout(
    () => stop("Downloading Chromium took too long"),
    CHROMIUM_DOWNLOAD_TIMEOUT_MS,
  )
  let stall = setTimeout(
    () => stop("The download of Chromium stalled"),
    CHROMIUM_DOWNLOAD_STALL_MS,
  )

  try {
    // Playwright's servers, not an address anyone handed PCP: redirects
    // to its storage are followed.
    const response = await fetcher(url, {
      signal: controller.signal,
      redirect: "follow",
      cache: "no-store",
    }).catch((error: unknown) => {
      throw new Error(
        `Could not reach ${host} to download Chromium: ${reasonOf(error)}.`,
      )
    })

    if (!response.ok || !response.body) {
      throw new Error(
        `${host} answered the download of Chromium with HTTP ${response.status}.`,
      )
    }

    const length = Number(response.headers.get("content-length"))
    const total = Number.isSafeInteger(length) && length > 0 ? length : null

    if (total !== null && total > MAX_CHROMIUM_DOWNLOAD_BYTES) {
      throw new Error(`${host} offered a Chromium larger than PCP takes.`)
    }

    self.state = { ...self.state, received: 0, total }
    let received = 0

    const count = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length

        if (received > MAX_CHROMIUM_DOWNLOAD_BYTES) {
          callback(new Error(`${host} sent more than PCP takes for Chromium.`))
          return
        }

        self.state = { ...self.state, received }
        clearTimeout(stall)
        stall = setTimeout(
          () => stop("The download of Chromium stalled"),
          CHROMIUM_DOWNLOAD_STALL_MS,
        )
        callback(null, chunk)
      },
    })

    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream),
      count,
      createWriteStream(file),
    )

    if (total !== null && received !== total) {
      throw new Error(`The download of Chromium from ${host} stopped short.`)
    }
  } catch (error) {
    // An abort surfaces as the stream's error; what stopped it says more.
    throw controller.signal.aborted ? controller.signal.reason : error
  } finally {
    clearTimeout(overall)
    clearTimeout(stall)
  }
}

/** fetch's "fetch failed" says little; its cause says what failed. */
function reasonOf(error: unknown): string {
  const cause = error instanceof Error ? error.cause : null
  const inner = cause instanceof Error ? cause : error

  return inner instanceof Error ? inner.message : String(inner)
}

/** Tests: forget the last install's outcome. */
export function resetChromiumInstall(): void {
  const self = installer()

  if (!self.running) {
    self.state = IDLE
  }
}
