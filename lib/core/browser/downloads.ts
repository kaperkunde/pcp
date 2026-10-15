import fs from "node:fs/promises"
import path from "node:path"

import type { Browser, CDPSession } from "patchright-core"

import { DOWNLOAD_START_MS, DOWNLOAD_TIMEOUT_MS } from "./limits"

/**
 * Downloads: a file a page hands the browser to save, taken by the
 * download tool and kept as a result of the token's (tool-results.ts), never
 * left on the machine.
 *
 * Chromium refuses every download (Playwright makes the vault's context
 * with downloads off) except while a download call waits for one. Then the
 * vault's context saves downloads into a folder of the browser's scratch
 * folder (runtime.ts), each under Chromium's own id, and the call takes
 * one: the first its own tab (or a popup of it) starts, from an address
 * the tab may open. Every other download is cancelled the moment it
 * begins, and the one taken is cancelled once Chromium says it is larger
 * than PCP keeps of one file, or once it is too slow. The file is read and
 * removed before the call answers, and the folder goes with the browser.
 *
 * The events come to a DevTools session of PCP's own, as the gate's do:
 * Playwright's download objects can read nothing in a context made with
 * downloads off. A download a page starts while no call waits is refused
 * by Chromium and only noted for its tab (`onOffered`), so the next answer
 * can say a file was offered.
 */

type Entry = {
  guid: string
  frameId: string
  url: string
  name: string
  received: number
  total: number
  state: "begun" | "inProgress" | "completed" | "canceled"
}

/** Whether a download is the waiting call's, refused, or someone else's. */
export type DownloadVerdict = "take" | "refuse" | "other"

type Waiter = {
  judge: (frameId: string, url: string) => Promise<DownloadVerdict>
  taken: Entry | null
  /** The address of a download of the tab's that was refused. */
  refused: string | null
  /** Called on every event while the call waits. */
  update: () => void
}

export type Downloads = {
  session: CDPSession
  /** Where Chromium writes a download while a call waits for it. */
  dir: string
  /** The vault's context, as DevTools names it; read from the first tab. */
  contextId: Promise<string> | null
  waiter: Waiter | null
  /** Downloads begun while a call waited, by Chromium's id. */
  entries: Map<string, Entry>
}

export type CaughtDownload =
  | { kind: "file"; name: string; url: string; bytes: Buffer }
  /** Nothing started a download in time. */
  | { kind: "none" }
  /** The tab's download came from an address it may not open. */
  | { kind: "refused"; url: string }
  | { kind: "too_large"; name: string; size: number }
  | { kind: "timeout"; name: string }
  | { kind: "failed"; name: string }

/** A file name as a page offered it, for an answer: one plain line. */
export function offeredName(name: string): string {
  return (
    name
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]+/g, " ")
      .trim()
      .slice(0, 200) || "a file"
  )
}

function fileOf(downloads: Downloads, guid: string): string {
  // Chromium's ids are UUIDs; anything else never names a path.
  return path.join(downloads.dir, guid.replace(/[^\w-]/g, "_"))
}

function removeFile(downloads: Downloads, guid: string): Promise<void> {
  return fs.rm(fileOf(downloads, guid), { force: true }).catch(() => {})
}

async function cancel(downloads: Downloads, guid: string): Promise<void> {
  const browserContextId = await downloads.contextId?.catch(() => undefined)
  await downloads.session
    .send("Browser.cancelDownload", {
      guid,
      ...(browserContextId ? { browserContextId } : {}),
    })
    .catch(() => {})
}

/**
 * PCP's session for the browser's downloads, with its folder. `onOffered`
 * hears of a download a page started while no call waited (refused).
 */
export async function openDownloads(
  browser: Browser,
  dir: string,
  onOffered: (frameId: string, name: string) => void,
): Promise<Downloads> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const session = await browser.newBrowserCDPSession()
  const downloads: Downloads = {
    session,
    dir,
    contextId: null,
    waiter: null,
    entries: new Map(),
  }

  session.on("Browser.downloadWillBegin", (event) => {
    const waiter = downloads.waiter

    if (!waiter) {
      onOffered(event.frameId, event.suggestedFilename)
      return
    }

    const entry: Entry = {
      guid: event.guid,
      frameId: event.frameId,
      url: event.url,
      name: event.suggestedFilename,
      received: 0,
      total: 0,
      state: "begun",
    }
    downloads.entries.set(entry.guid, entry)

    void waiter
      .judge(entry.frameId, entry.url)
      .catch((): DownloadVerdict => "other")
      .then((verdict) => {
        if (
          verdict === "take" &&
          downloads.waiter === waiter &&
          !waiter.taken &&
          !waiter.refused
        ) {
          waiter.taken = entry
          waiter.update()
          return
        }

        void cancel(downloads, entry.guid)

        if (verdict === "refuse" && downloads.waiter === waiter) {
          waiter.refused ??= entry.url
          waiter.update()
        } else if (verdict === "other") {
          onOffered(entry.frameId, entry.name)
        }
      })
  })

  session.on("Browser.downloadProgress", (event) => {
    const entry = downloads.entries.get(event.guid)

    if (!entry) {
      return
    }

    entry.received = event.receivedBytes
    entry.total = event.totalBytes
    entry.state = event.state

    if (event.state !== "inProgress") {
      downloads.entries.delete(entry.guid)

      // Only the download a call took is read; any other is gone at once.
      if (downloads.waiter?.taken !== entry) {
        void removeFile(downloads, entry.guid)
      }
    }

    downloads.waiter?.update()
  })

  return downloads
}

/**
 * Hears the downloads of the vault's context, which a tab's session names:
 * once, from the first tab. Downloads stay refused.
 */
export function watchDownloads(
  downloads: Downloads,
  tabSession: CDPSession,
): Promise<string> {
  if (!downloads.contextId) {
    downloads.contextId = tabSession
      .send("Target.getTargetInfo")
      .then(async ({ targetInfo }) => {
        const browserContextId = targetInfo.browserContextId

        if (!browserContextId) {
          throw new Error("The tab's context has no id.")
        }

        await downloads.session.send("Browser.setDownloadBehavior", {
          behavior: "deny",
          browserContextId,
          eventsEnabled: true,
        })
        return browserContextId
      })
    downloads.contextId.catch(() => {
      downloads.contextId = null
    })
  }

  return downloads.contextId
}

/** Whether a frame is the tab's, by its main frame and its session. */
export async function tabOwnsFrame(
  downloads: Downloads,
  tab: { mainFrameId: string; cdp: CDPSession },
  frameId: string,
): Promise<boolean> {
  if (frameId === tab.mainFrameId) {
    return true
  }

  type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] }
  const holds = (tree: FrameTree): boolean =>
    tree.frame.id === frameId || (tree.childFrames ?? []).some(holds)
  const tree = await tab.cdp
    .send("Page.getFrameTree")
    .then(({ frameTree }) => frameTree as FrameTree)
    .catch(() => null)

  if (tree && holds(tree)) {
    return true
  }

  // A popup the tab opened to download from: its main frame is its target.
  const info = await downloads.session
    .send("Target.getTargetInfo", { targetId: frameId })
    .then(({ targetInfo }) => targetInfo)
    .catch(() => null)

  return info?.openerId === tab.mainFrameId
}

/** Waits until `done`, re-checked on every download event, or `ms`. */
function until(waiter: Waiter, done: () => boolean, ms: number) {
  if (done()) {
    return Promise.resolve(true)
  }

  return new Promise<boolean>((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer)
      waiter.update = () => {}
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), ms)
    waiter.update = () => {
      if (done()) finish(true)
    }
  })
}

/**
 * Runs `start` (a click, or opening an address) with downloads let through
 * for the vault's context, and takes the first one `judge` says is the
 * call's. The vault's browser work runs one call at a time (withVault), so
 * no two calls wait at once.
 */
export async function catchDownload(
  downloads: Downloads,
  {
    tabSession,
    judge,
    start,
    maxBytes,
  }: {
    tabSession: CDPSession
    judge: Waiter["judge"]
    /**
     * Starts the download; answers how long to wait for it to begin, when
     * that is known to be less (an address that opened a page).
     */
    start: () => Promise<number | void>
    maxBytes: number
  },
): Promise<CaughtDownload> {
  const browserContextId = await watchDownloads(downloads, tabSession)
  const waiter: Waiter = {
    judge,
    taken: null,
    refused: null,
    update: () => {},
  }
  const tooLarge = (entry: Entry) =>
    entry.total > maxBytes || entry.received > maxBytes

  downloads.waiter = waiter

  try {
    await downloads.session.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      browserContextId,
      downloadPath: downloads.dir,
      eventsEnabled: true,
    })
    const startMs = (await start()) ?? DOWNLOAD_START_MS
    await until(
      waiter,
      () => waiter.taken !== null || waiter.refused !== null,
      startMs,
    )

    const entry = waiter.taken

    if (!entry) {
      return waiter.refused
        ? { kind: "refused", url: waiter.refused }
        : { kind: "none" }
    }

    const ended = await until(
      waiter,
      () =>
        entry.state === "completed" ||
        entry.state === "canceled" ||
        tooLarge(entry),
      DOWNLOAD_TIMEOUT_MS,
    )

    if (tooLarge(entry)) {
      await cancel(downloads, entry.guid)
      return {
        kind: "too_large",
        name: entry.name,
        size: Math.max(entry.total, entry.received),
      }
    }

    if (!ended) {
      await cancel(downloads, entry.guid)
      return { kind: "timeout", name: entry.name }
    }

    if (entry.state === "canceled") {
      return { kind: "failed", name: entry.name }
    }

    const bytes = await fs.readFile(fileOf(downloads, entry.guid))

    if (bytes.length > maxBytes) {
      return { kind: "too_large", name: entry.name, size: bytes.length }
    }

    return { kind: "file", name: entry.name, url: entry.url, bytes }
  } finally {
    downloads.waiter = null
    await downloads.session
      .send("Browser.setDownloadBehavior", {
        behavior: "deny",
        browserContextId,
        eventsEnabled: true,
      })
      .catch(() => {})

    if (waiter.taken) {
      if (
        waiter.taken.state === "begun" ||
        waiter.taken.state === "inProgress"
      ) {
        await cancel(downloads, waiter.taken.guid)
      }

      await removeFile(downloads, waiter.taken.guid)
    }
  }
}
