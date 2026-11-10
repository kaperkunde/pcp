import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * The browser's folders under the system's temporary folder: one per
 * Chromium (`pcp-chromium-<pid>-…`: its crash reporter's config and cache,
 * XDG_CONFIG_HOME and XDG_CACHE_HOME in launch.ts, and the file a download
 * call waits for, downloads.ts) and one per virtual display
 * (`pcp-display-<pid>-…`: the display's cookie, display.ts). Each is removed
 * when its browser or display closes; a process that crashes or is killed
 * leaves its folders behind, so the name carries the process's id and the
 * cleanup (lib/core/cleanup/) removes the folders of a process that is gone,
 * and this process's own that no browser or display holds any more.
 *
 * Sign-ins are not among them: the browser's contexts are off the record
 * (launch.ts), so their cookies and storage stay in memory, and the vault's
 * are saved encrypted (profile.ts). What a crash can leave is a download,
 * the crash reporter's files and the display's cookie.
 *
 * Playwright's own folders beside them (`playwright_chromiumdev_profile-…`,
 * `playwright-artifacts-…`) are not PCP's and stay as they are; in the
 * container image /tmp is a tmpfs (docker-compose.yaml, install.sh), which
 * nothing outlives.
 */

export type ScratchKind = "chromium" | "display"

/** A folder of this scheme: its kind, the process's id, mkdtemp's six. */
const NAME = /^pcp-(chromium|display)-([1-9]\d{0,9})-[A-Za-z0-9]{6}$/
/** A folder from before the id was in the name. */
const LEGACY = /^pcp-(chromium|display)-[A-Za-z0-9]{6}$/

type ScratchState = {
  /** The folders this process's browsers and display hold. */
  live: Set<string>
  /** Folders being made, not yet in `live`. */
  making: number
}

/** On globalThis: the cleanup and the browser are bundled apart. */
const SCRATCH = Symbol.for("pcp.browser.scratch")

function state(): ScratchState {
  const holder = globalThis as unknown as { [SCRATCH]?: ScratchState }

  holder[SCRATCH] ??= { live: new Set(), making: 0 }
  return holder[SCRATCH]
}

/** A new private folder for a browser or the display, held until removed. */
export async function makeScratchDir(
  kind: ScratchKind,
  base: string = os.tmpdir(),
): Promise<string> {
  const current = state()
  current.making++

  try {
    const dir = await fs.mkdtemp(path.join(base, `pcp-${kind}-${process.pid}-`))
    current.live.add(dir)
    return dir
  } finally {
    current.making--
  }
}

/** Lets the folder go and removes it, quietly: the cleanup tries again. */
export async function removeScratchDir(dir: string): Promise<void> {
  state().live.delete(dir)
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

/** Whether a process with this id runs (one of another user's counts). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Removes the browser's folders nothing holds: those of a process that is
 * gone, this process's own that no browser or display holds, and those from
 * before the id was in the name. Only folders this user owns, and never a
 * link. Returns how many it removed.
 */
export async function pruneScratchDirs({
  base = os.tmpdir(),
  pid = process.pid,
  alive = processAlive,
}: {
  base?: string
  pid?: number
  alive?: (pid: number) => boolean
} = {}): Promise<number> {
  const current = state()
  let entries: import("node:fs").Dirent[]

  try {
    entries = await fs.readdir(base, { withFileTypes: true })
  } catch {
    return 0
  }

  const uid = process.getuid?.()
  let removed = 0

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const match = NAME.exec(entry.name)

    if (!match && !LEGACY.test(entry.name)) continue

    const dir = path.join(base, entry.name)

    if (match) {
      const owner = Number(match[2])

      if (owner === pid) {
        // One being made is not in `live` yet: leave ours for the next run.
        if (current.making > 0 || current.live.has(dir)) continue
      } else if (alive(owner)) {
        continue
      }
    }

    try {
      const stat = await fs.lstat(dir)

      if (!stat.isDirectory()) continue
      if (uid !== undefined && stat.uid !== uid) continue

      await fs.rm(dir, { recursive: true, force: true })
      removed++
    } catch {
      // Gone already, or not ours to remove.
    }
  }

  return removed
}
