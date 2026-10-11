import { existsSync, statSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { crc32 } from "node:zlib"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { startTestApi, type TestApi } from "../openapi/test-api"
import {
  chromiumBuild,
  chromiumInstallState,
  chromiumInstalling,
  installChromium,
  installedChromium,
  olderChromiumInstalled,
  resetChromiumInstall,
  type ChromiumBuild,
} from "./install"

// Installing Chromium from the Browser page, against a server on this
// machine standing in for Playwright's and a real archive unpacked with
// Playwright's own unzip. The caps are made small to be reached.

vi.mock("./limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./limits")>()),
  MAX_CHROMIUM_DOWNLOAD_BYTES: 64 * 1024,
  CHROMIUM_DOWNLOAD_STALL_MS: 300,
}))

const EXECUTABLE = path.join("chrome-test", "chrome")
const CHROME = "#!/bin/sh\necho chromium\n"

let dataDir: string
let api: TestApi
let archive: Buffer

function build(urls: string[], revision = "1243"): ChromiumBuild {
  return { revision, urls, executable: EXECUTABLE }
}

/** A zip of stored (uncompressed) files, as small as the format allows. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const nameBytes = Buffer.from(name)
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made on Unix: modes count
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(((0o100644 << 16) >>> 0) as number, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + data.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, directory, end])
}

beforeEach(async () => {
  resetChromiumInstall()
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "pcp-install-"))
  archive = zip({ [EXECUTABLE.split(path.sep).join("/")]: CHROME })
  api = await startTestApi((request, res) => {
    if (request.url === "/chromium.zip") {
      res.setHeader("content-length", archive.length)
      res.end(archive)
    } else if (request.url === "/unsized.zip") {
      // No length: chunks until the cap is passed.
      const chunk = Buffer.alloc(16 * 1024)
      let sent = 0
      const timer = setInterval(() => {
        if (sent > 128 * 1024 || res.destroyed) {
          clearInterval(timer)
          res.end()
        } else {
          sent += chunk.length
          res.write(chunk)
        }
      }, 1)
    } else if (request.url === "/huge.zip") {
      res.setHeader("content-length", 10 * 1024 * 1024)
      res.write(archive)
    } else if (request.url === "/stall.zip") {
      res.setHeader("content-length", archive.length)
      res.write(archive.subarray(0, 10))
    } else if (request.url === "/empty.zip") {
      const empty = zip({ "README.txt": "nothing here" })
      res.setHeader("content-length", empty.length)
      res.end(empty)
    } else {
      res.statusCode = 404
      res.end()
    }
  })
})

afterEach(async () => {
  await api.close()
  await fs.rm(dataDir, { recursive: true, force: true })
})

describe("installChromium", () => {
  it("downloads, unpacks and marks the build, and drops older ones", async () => {
    const browsers = path.join(dataDir, "browsers")
    await fs.mkdir(path.join(browsers, "chromium-1000"), { recursive: true })
    await fs.mkdir(path.join(browsers, ".install-crashed"), { recursive: true })
    const current = build([`${api.origin}/chromium.zip`])

    expect(await installedChromium(dataDir, current)).toBeNull()
    expect(await olderChromiumInstalled(dataDir, current)).toBe(true)

    const state = await installChromium({ dataDir, build: current })

    expect(state).toEqual({
      stage: "done",
      received: archive.length,
      total: archive.length,
      error: null,
    })
    const executable = await installedChromium(dataDir, current)
    expect(executable).toBe(
      path.join(browsers, "chromium-1243", "chrome-test", "chrome"),
    )
    expect(await fs.readFile(executable!, "utf8")).toBe(CHROME)
    expect(statSync(executable!).mode & 0o777).toBe(0o755)
    expect(
      existsSync(path.join(browsers, "chromium-1243", "INSTALLATION_COMPLETE")),
    ).toBe(true)
    // Nothing else is left: not the older build, not the download.
    expect(await fs.readdir(browsers)).toEqual(["chromium-1243"])
    expect(await olderChromiumInstalled(dataDir, current)).toBe(false)
    expect(chromiumInstallState().stage).toBe("done")
    expect(chromiumInstalling()).toBe(false)
  })

  it("starts one install for two clicks", async () => {
    const current = build([`${api.origin}/chromium.zip`])

    const first = installChromium({ dataDir, build: current })
    const second = installChromium({ dataDir, build: current })

    expect(chromiumInstalling()).toBe(true)
    expect(chromiumInstallState().stage).toBe("downloading")
    await Promise.all([first, second])
    expect(api.requests).toHaveLength(1)
  })

  it("does nothing when the build is already there", async () => {
    const current = build([`${api.origin}/chromium.zip`])
    await installChromium({ dataDir, build: current })

    const again = await installChromium({ dataDir, build: current })

    expect(again.stage).toBe("done")
    expect(api.requests).toHaveLength(1)
  })

  it("tries Playwright's next address when one fails", async () => {
    const current = build([
      `${api.origin}/missing.zip`,
      `${api.origin}/chromium.zip`,
    ])

    const state = await installChromium({ dataDir, build: current })

    expect(state.stage).toBe("done")
    expect(api.requests.map((request) => request.url)).toEqual([
      "/missing.zip",
      "/chromium.zip",
    ])
  })

  it("says how the last address failed", async () => {
    const state = await installChromium({
      dataDir,
      build: build([`${api.origin}/missing.zip`]),
    })

    expect(state.stage).toBe("failed")
    expect(state.error).toMatch(
      /answered the download of Chromium with HTTP 404/,
    )
    expect(await installedChromium(dataDir, build([]))).toBeNull()
  })

  it("refuses an archive larger than PCP takes, said or sent", async () => {
    const said = await installChromium({
      dataDir,
      build: build([`${api.origin}/huge.zip`]),
    })
    expect(said.error).toMatch(/larger than PCP takes/)

    resetChromiumInstall()
    const sent = await installChromium({
      dataDir,
      build: build([`${api.origin}/unsized.zip`]),
    })
    expect(sent.error).toMatch(/more than PCP takes/)
    expect(await fs.readdir(path.join(dataDir, "browsers"))).toEqual([])
  })

  it("gives up on a download that stalls", async () => {
    const state = await installChromium({
      dataDir,
      build: build([`${api.origin}/stall.zip`]),
    })

    expect(state.stage).toBe("failed")
    expect(state.error).toMatch(/stalled/)
    expect(await fs.readdir(path.join(dataDir, "browsers"))).toEqual([])
  })

  it("refuses an archive without Chromium where Playwright says", async () => {
    const state = await installChromium({
      dataDir,
      build: build([`${api.origin}/empty.zip`]),
    })

    expect(state.error).toMatch(/did not hold Chromium/)
    expect(await fs.readdir(path.join(dataDir, "browsers"))).toEqual([])
  })
})

describe("chromiumBuild", () => {
  it("reads the build patchright-core drives from Playwright's own list", async () => {
    const current = await chromiumBuild()

    expect(current).not.toBeNull()
    expect(current!.revision).toMatch(/^\d+$/)
    expect(current!.urls.length).toBeGreaterThan(0)
    for (const url of current!.urls) {
      expect(new URL(url).protocol).toBe("https:")
    }
    expect(path.isAbsolute(current!.executable)).toBe(false)
    expect(current!.executable.startsWith("..")).toBe(false)
  })
})
