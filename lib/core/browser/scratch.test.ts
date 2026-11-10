import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  symlinkSync,
  utimesSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  makeScratchDir,
  processAlive,
  pruneScratchDirs,
  removeScratchDir,
} from "./scratch"

// The browser's folders under the temporary folder, and the cleanup's part
// that removes the ones a crashed or killed PCP left behind (#100).

let base: string

beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), "pcp-scratch-test-"))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** A pid no process has: above every Linux and macOS limit. */
const GONE = 999_999_999
const OTHER = 4242

function folder(name: string): string {
  const dir = path.join(base, name)
  mkdirSync(dir)
  return dir
}

describe("the browser's temporary folders", () => {
  it("carry the process's id in their name", async () => {
    const chromium = await makeScratchDir("chromium", base)
    const display = await makeScratchDir("display", base)

    expect(path.basename(chromium)).toMatch(
      new RegExp(`^pcp-chromium-${process.pid}-[A-Za-z0-9]{6}$`),
    )
    expect(path.basename(display)).toMatch(
      new RegExp(`^pcp-display-${process.pid}-[A-Za-z0-9]{6}$`),
    )

    await removeScratchDir(chromium)
    await removeScratchDir(display)
    expect(existsSync(chromium)).toBe(false)
    expect(existsSync(display)).toBe(false)
  })

  it("are removed when their process is gone, and kept while it runs", async () => {
    const dead = folder(`pcp-chromium-${GONE}-aB3dE9`)
    const deadDisplay = folder(`pcp-display-${GONE}-Zz0000`)
    const running = folder(`pcp-chromium-${OTHER}-aB3dE9`)

    const removed = await pruneScratchDirs({
      base,
      alive: (pid) => pid === OTHER,
    })

    expect(removed).toBe(2)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(deadDisplay)).toBe(false)
    expect(existsSync(running)).toBe(true)
  })

  it("keeps this process's folders a browser holds, and removes the ones none does", async () => {
    const held = await makeScratchDir("chromium", base)
    const dropped = folder(`pcp-chromium-${process.pid}-qQ1234`)

    const removed = await pruneScratchDirs({ base, alive: () => true })

    expect(removed).toBe(1)
    expect(existsSync(held)).toBe(true)
    expect(existsSync(dropped)).toBe(false)
    await removeScratchDir(held)
  })

  // Without the id, nothing says whose it is: an older PCP still running
  // may hold one, and it is left until it has not changed for a day.
  it("removes the folders from before the id was in the name once a day old", async () => {
    const old = folder("pcp-chromium-Ab12Cd")
    const oldDisplay = folder("pcp-display-Ab12Cd")
    const recent = folder("pcp-chromium-Ef34Gh")
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(old, twoDaysAgo, twoDaysAgo)
    utimesSync(oldDisplay, twoDaysAgo, twoDaysAgo)

    expect(await pruneScratchDirs({ base, alive: () => true })).toBe(2)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(oldDisplay)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  it("leaves everything else alone: Playwright's, other names, files and links", async () => {
    const kept = [
      folder("playwright_chromiumdev_profile-Ab12Cd"),
      folder("playwright-artifacts-Ab12Cd"),
      folder("pcp-chromium"),
      folder(`pcp-chromium-${GONE}`),
      folder(`pcp-chromium-${GONE}-toolong1`),
      folder(`pcp-other-${GONE}-Ab12Cd`),
      folder("pcp-import-Ab12Cd"),
    ]
    const target = folder("somewhere")
    const link = path.join(base, `pcp-chromium-${GONE}-L1nk00`)
    symlinkSync(target, link)

    expect(await pruneScratchDirs({ base, alive: () => false })).toBe(0)
    for (const dir of [...kept, target, link]) {
      expect(existsSync(dir), dir).toBe(true)
    }
  })

  it("finds nothing to remove in a folder that is not there", async () => {
    expect(await pruneScratchDirs({ base: path.join(base, "missing") })).toBe(0)
  })

  it("tells a running process from one that is gone", () => {
    expect(processAlive(process.pid)).toBe(true)
    expect(processAlive(GONE)).toBe(false)
  })
})
