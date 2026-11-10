import fs from "node:fs/promises"
import path from "node:path"

import type { Browser, CDPSession } from "patchright-core"

import { mediaTypeOf } from "./challenge"
import {
  DOCUMENT_READ_BYTES,
  DOWNLOAD_START_MS,
  DOWNLOAD_TIMEOUT_MS,
  MAX_REMEMBERED_WINDOWS,
  MAX_WINDOW_DEPTH,
} from "./limits"

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
 * A popup is known to be its tab's by the page that opened it, as Chromium
 * named it when the popup was made (`openers`, from Target.targetCreated):
 * Chromium closes a blank window whose address turned out to be a download
 * as the download begins, before anyone could ask it whose it was. A file
 * a page shows rather than offers (a PDF or a picture its tab or such a
 * popup is answered with, no attachment) is taken too: the gate holds that
 * answer while a call waits (`wantsDocument`), and `takeDocument` reads it
 * in chunks, past the largest file never whole, and hands it on to the
 * page as it was.
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
  /** Whether the waiting call has said whose it is yet. */
  judged: boolean
}

/** Whether a download is the waiting call's, refused, or someone else's. */
export type DownloadVerdict = "take" | "refuse" | "other"

/** A PDF or picture a page was answered with, taken as the call's file. */
type ShownFile = {
  frameId: string
  url: string
  name: string
  state: "reading" | "done" | "too_large" | "failed"
  size: number
  bytes: Buffer | null
}

type Waiter = {
  judge: (frameId: string, url: string) => Promise<DownloadVerdict>
  /** The waiting tab's main frame: a file it shows is taken. */
  mainFrameId: string
  maxBytes: number
  taken: Entry | null
  /** A file shown rather than offered, taken instead of a download. */
  shown: ShownFile | null
  /** Set once the call stopped waiting: a file still being read is let go. */
  over: boolean
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
  /**
   * The page (target) that opened each window, as Chromium said when it
   * made it; kept after the window closed, for the newest
   * MAX_REMEMBERED_WINDOWS.
   */
  openers: Map<string, string>
}

/** What PCP hears of the windows (page targets) Chromium makes and ends. */
export type WindowHooks = {
  /** A page opened a window (`openerId` is the opener's target). */
  opened: (targetId: string, openerId: string, url: string) => void
  /** A window shows another address. */
  moved: (targetId: string, url: string) => void
  /** A page or window is gone. */
  gone: (targetId: string) => void
}

export type CaughtDownload =
  | {
      kind: "file"
      name: string
      url: string
      bytes: Buffer
      /** The frame it came from: the tab's, or a popup's. */
      frameId: string
    }
  /** Nothing started a download in time. */
  | { kind: "none" }
  /** The tab's download came from an address it may not open. */
  | { kind: "refused"; url: string }
  | { kind: "too_large"; name: string; size: number }
  | { kind: "timeout"; name: string }
  | { kind: "failed"; name: string }
  /** Another tab's download call is waiting for one now. */
  | { kind: "busy" }

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

/** Notes which page opened a window, keeping only the newest. */
function rememberOpener(
  downloads: Downloads,
  targetId: string,
  openerId: string,
): void {
  downloads.openers.delete(targetId)
  downloads.openers.set(targetId, openerId)

  for (const oldest of downloads.openers.keys()) {
    if (downloads.openers.size <= MAX_REMEMBERED_WINDOWS) break
    downloads.openers.delete(oldest)
  }
}

/**
 * The page that opened a window, as Chromium named it when it made it
 * (asked again if PCP missed that): null for a page nothing opened, or one
 * long gone.
 */
export async function openerOf(
  downloads: Downloads,
  targetId: string,
): Promise<string | null> {
  const known = downloads.openers.get(targetId)

  if (known) {
    return known
  }

  const info = await downloads.session
    .send("Target.getTargetInfo", { targetId })
    .then(({ targetInfo }) => targetInfo)
    .catch(() => null)

  if (info?.openerId) {
    rememberOpener(downloads, targetId, info.openerId)
  }

  return info?.openerId ?? null
}

/**
 * PCP's session for the browser's downloads, with its folder. `onOffered`
 * hears of a download a page started while no call waited (refused);
 * `windows` hears of the windows pages open.
 */
export async function openDownloads(
  browser: Browser,
  dir: string,
  onOffered: (frameId: string, name: string) => void,
  windows?: WindowHooks,
): Promise<Downloads> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const session = await browser.newBrowserCDPSession()
  const downloads: Downloads = {
    session,
    dir,
    contextId: null,
    waiter: null,
    entries: new Map(),
    openers: new Map(),
  }

  session.on("Target.targetCreated", ({ targetInfo }) => {
    if (targetInfo.type !== "page" || !targetInfo.openerId) return
    rememberOpener(downloads, targetInfo.targetId, targetInfo.openerId)
    windows?.opened(targetInfo.targetId, targetInfo.openerId, targetInfo.url)
  })
  session.on("Target.targetInfoChanged", ({ targetInfo }) => {
    if (targetInfo.type === "page") {
      windows?.moved(targetInfo.targetId, targetInfo.url)
    }
  })
  session.on("Target.targetDestroyed", ({ targetId }) => {
    windows?.gone(targetId)
  })

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
      judged: false,
    }
    downloads.entries.set(entry.guid, entry)

    void waiter
      .judge(entry.frameId, entry.url)
      .catch((): DownloadVerdict => "other")
      .then((verdict) => {
        entry.judged = true

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

        // One that finished before it was judged was kept for the verdict.
        if (entry.state === "completed" || entry.state === "canceled") {
          void removeFile(downloads, entry.guid)
        }

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

      // Only the download a call took is read; any other is gone at once
      // (one still being judged, once it is: a small file can finish first).
      if (entry.judged && downloads.waiter?.taken !== entry) {
        void removeFile(downloads, entry.guid)
      }
    }

    downloads.waiter?.update()
  })

  // Every page target, so a window is known by its opener from the moment
  // it exists (openers).
  await session.send("Target.setDiscoverTargets", { discover: true })
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

  // A popup the tab opened (or a window that popup opened): its main frame
  // is its target, known by its opener even once it has closed.
  let target = frameId

  for (let depth = 0; depth < MAX_WINDOW_DEPTH; depth++) {
    const opener = await openerOf(downloads, target)

    if (!opener) {
      return false
    }

    if (opener === tab.mainFrameId) {
      return true
    }

    target = opener
  }

  return false
}

type PausedResponse = {
  requestId: string
  frameId?: string
  request: { url: string }
  responseStatusCode?: number
  responseHeaders?: Array<{ name: string; value: string }>
}

function headerOf(event: PausedResponse, name: string): string | undefined {
  return event.responseHeaders?.find(
    (header) => header.name.toLowerCase() === name,
  )?.value
}

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
}

/**
 * The name of a file a page shows: the one its Content-Disposition gives,
 * else the address's last part, with the extension its type has.
 */
export function shownFileName(
  url: string,
  type: string,
  disposition: string | undefined,
): string {
  const given =
    /filename\*\s*=\s*utf-8''([^;]+)/i.exec(disposition ?? "")?.[1] ??
    /filename\s*=\s*"?([^";]+)"?/i.exec(disposition ?? "")?.[1]
  let name = ""

  try {
    name = decodeURIComponent(
      given ?? new URL(url).pathname.split("/").pop() ?? "",
    )
  } catch {
    name = given ?? ""
  }

  name = name.replace(/[/\\]/g, "_").trim()
  const extension = EXTENSIONS[type] ?? type.split("/")[1] ?? "bin"

  if (!name) {
    return `${type.startsWith("image/") ? "picture" : "document"}.${extension}`
  }

  return /\.[a-z0-9]{1,8}$/i.test(name) ? name : `${name}.${extension}`
}

/**
 * Whether the gate should hold the answer to a document request of this
 * frame for the waiting call: its tab's or a popup's, at an address the
 * tab may open, while nothing has been taken yet.
 */
export async function wantsDocument(
  downloads: Downloads,
  frameId: string,
  url: string,
): Promise<boolean> {
  const waiter = downloads.waiter

  if (!waiter || waiter.taken || waiter.shown || waiter.over) {
    return false
  }

  // A page's main frame only, the tab's or a popup's: a document in a
  // frame inside a page is part of that page.
  if (frameId !== waiter.mainFrameId && !(await openerOf(downloads, frameId))) {
    return false
  }

  return (await waiter.judge(frameId, url).catch(() => "other")) === "take"
}

/**
 * A document answer the gate held (wantsDocument): a PDF or a picture
 * shown rather than offered is taken as the waiting call's file, read in
 * chunks and stopped past the largest file, then handed on to the page as
 * it was. True when it answered the request; false when the gate should
 * let the answer go on as it is.
 */
export async function takeDocument(
  downloads: Downloads,
  gate: CDPSession,
  event: PausedResponse,
): Promise<boolean> {
  const waiter = downloads.waiter
  const type = mediaTypeOf(headerOf(event, "content-type"))
  const disposition = headerOf(event, "content-disposition")
  const frameId = event.frameId
  const url = event.request.url

  if (
    !waiter ||
    !frameId ||
    event.responseStatusCode !== 200 ||
    !type ||
    !(type === "application/pdf" || type.startsWith("image/")) ||
    // Offered as a file: Chromium makes it a download, taken as one.
    /^\s*attachment/i.test(disposition ?? "") ||
    (await waiter.judge(frameId, url).catch(() => "other")) !== "take" ||
    downloads.waiter !== waiter ||
    waiter.taken ||
    waiter.shown ||
    waiter.over
  ) {
    return false
  }

  const shown: ShownFile = {
    frameId,
    url,
    name: shownFileName(url, type, disposition),
    state: "reading",
    size: 0,
    bytes: null,
  }
  waiter.shown = shown
  waiter.update()
  const declared = Number(headerOf(event, "content-length"))

  if (Number.isFinite(declared) && declared > waiter.maxBytes) {
    // Too large to keep: the page gets it as it would, and nothing is read.
    shown.state = "too_large"
    shown.size = declared
    waiter.update()
    return false
  }

  let stream: string | null = null

  try {
    ;({ stream } = await gate.send("Fetch.takeResponseBodyAsStream", {
      requestId: event.requestId,
    }))
    const chunks: Buffer[] = []

    for (;;) {
      const piece = await gate.send("IO.read", {
        handle: stream,
        size: DOCUMENT_READ_BYTES,
      })
      const bytes = Buffer.from(
        piece.data,
        piece.base64Encoded ? "base64" : "latin1",
      )
      shown.size += bytes.length

      if (shown.size > waiter.maxBytes || waiter.over) {
        shown.state = shown.size > waiter.maxBytes ? "too_large" : "failed"
        waiter.update()
        await gate
          .send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "Aborted",
          })
          .catch(() => {})
        return true
      }

      chunks.push(bytes)

      if (piece.eof) break
    }

    shown.bytes = Buffer.concat(chunks)
    shown.state = "done"
    waiter.update()
    // The page shows what it was answered with, as it would have.
    await gate
      .send("Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: (event.responseHeaders ?? []).filter(
          (header) =>
            !/^(content-length|content-encoding|transfer-encoding)$/i.test(
              header.name,
            ),
        ),
        body: shown.bytes.toString("base64"),
      })
      .catch(() => {})
    return true
  } catch {
    shown.state = "failed"
    waiter.update()
    await gate
      .send("Fetch.failRequest", {
        requestId: event.requestId,
        errorReason: "Failed",
      })
      .catch(() => {})
    return true
  } finally {
    if (stream) await gate.send("IO.close", { handle: stream }).catch(() => {})
  }
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
 * call's. One call waits for a download at a time, whichever its tab:
 * while one does, another is answered busy rather than kept waiting.
 */
export async function catchDownload(
  downloads: Downloads,
  {
    tabSession,
    mainFrameId,
    judge,
    start,
    maxBytes,
  }: {
    tabSession: CDPSession
    /** The tab's main frame, whose own document may be the file. */
    mainFrameId: string
    judge: Waiter["judge"]
    /**
     * Starts the download; answers how long to wait for it to begin, when
     * that is known to be less (an address that opened a page).
     */
    start: () => Promise<number | void>
    maxBytes: number
  },
): Promise<CaughtDownload> {
  if (downloads.waiter) {
    return { kind: "busy" }
  }

  const waiter: Waiter = {
    judge,
    mainFrameId,
    maxBytes,
    taken: null,
    shown: null,
    over: false,
    refused: null,
    update: () => {},
  }
  const tooLarge = (entry: Entry) =>
    entry.total > maxBytes || entry.received > maxBytes

  // Taken before anything is awaited, so no second call slips in.
  downloads.waiter = waiter
  let browserContextId: string

  try {
    browserContextId = await watchDownloads(downloads, tabSession)
  } catch (error) {
    downloads.waiter = null
    throw error
  }

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
      () =>
        waiter.taken !== null ||
        waiter.shown !== null ||
        waiter.refused !== null,
      startMs,
    )

    const shown = waiter.shown

    if (shown) {
      return await shownFile(waiter, shown)
    }

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

    return {
      kind: "file",
      name: entry.name,
      url: entry.url,
      bytes,
      frameId: entry.frameId,
    }
  } finally {
    waiter.over = true
    if (downloads.waiter === waiter) downloads.waiter = null
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

/** A file a page showed (takeDocument), once it is read or given up. */
async function shownFile(
  waiter: Waiter,
  shown: ShownFile,
): Promise<CaughtDownload> {
  const ended = await until(
    waiter,
    () => shown.state !== "reading",
    DOWNLOAD_TIMEOUT_MS,
  )

  switch (ended ? shown.state : "reading") {
    case "done":
      return {
        kind: "file",
        name: shown.name,
        url: shown.url,
        bytes: shown.bytes!,
        frameId: shown.frameId,
      }
    case "too_large":
      return { kind: "too_large", name: shown.name, size: shown.size }
    case "failed":
      return { kind: "failed", name: shown.name }
    default:
      return { kind: "timeout", name: shown.name }
  }
}
