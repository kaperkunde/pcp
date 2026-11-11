import type { CDPSession, Locator, Page } from "patchright-core"

import { MAX_UNSEEN_FRAMES, MIN_UNSEEN_SIZE_PX } from "./limits"
import { bounded } from "./queue"
import { allNodes, type SnapshotNode } from "./snapshot"

/**
 * What a page shows that snapshot, find and read_page cannot read, so an
 * assistant does not take a page for empty when it is not: an iframe whose
 * content the tree does not include (one from another site most often), a
 * closed shadow root (which Playwright's snapshot cannot open), and a
 * canvas (pixels, no elements). Looked at in PCP's own world, never by page
 * script: the iframes through Playwright's handles, the shadow roots and
 * canvases through the tab's DevTools session (DOM.getDocument, which
 * reaches closed shadow roots and the frames in the page's own process).
 * Every step is bounded; one that fails counts nothing.
 */

export type UnseenFrame = {
  /** Its ref in the snapshot; null when read_page found it without one. */
  ref: string | null
  /** Its page is at another origin than the tab's. */
  crossOrigin: boolean
}

export type Unseen = {
  frames: UnseenFrame[]
  closedShadowRoots: number
  canvases: number
}

/** What a probe gives for a page with nothing unseen. */
export const NOTHING_UNSEEN: Unseen = {
  frames: [],
  closedShadowRoots: 0,
  canvases: 0,
}

/** How long one look at the page may take. */
const PROBE_MS = 3_000

type DomNode = {
  nodeId: number
  nodeType: number
  nodeName: string
  shadowRootType?: string
  children?: DomNode[]
  shadowRoots?: DomNode[]
  contentDocument?: DomNode
}

function originOf(address: string): string | null {
  try {
    const url = new URL(address)
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null
  } catch {
    return null
  }
}

function bigEnough(box: { width: number; height: number } | null): boolean {
  return (
    !!box && box.width >= MIN_UNSEEN_SIZE_PX && box.height >= MIN_UNSEEN_SIZE_PX
  )
}

function* walk(node: DomNode): Generator<DomNode> {
  yield node
  for (const child of [
    ...(node.children ?? []),
    ...(node.shadowRoots ?? []),
    ...(node.contentDocument ? [node.contentDocument] : []),
  ]) {
    yield* walk(child)
  }
}

/** Whether a shadow root holds an element of its own. */
function holdsElements(root: DomNode): boolean {
  return (root.children ?? []).some((child) => child.nodeType === 1)
}

/**
 * The page's closed shadow roots with something in them, and its canvases
 * (the nodes, sized afterwards), as DevTools sees the page's document.
 * Exported for tests.
 */
export function domUnseen(root: DomNode): {
  closedShadowRoots: number
  canvases: number[]
} {
  let closedShadowRoots = 0
  const canvases: number[] = []

  for (const node of walk(root)) {
    if (node.shadowRootType === "closed" && holdsElements(node)) {
      closedShadowRoots += 1
    }

    if (node.nodeType === 1 && node.nodeName === "CANVAS") {
      canvases.push(node.nodeId)
    }
  }

  return { closedShadowRoots, canvases }
}

/** A canvas's size on the page, from its box model; null when it has none. */
async function canvasBox(
  cdp: CDPSession,
  nodeId: number,
): Promise<{ width: number; height: number } | null> {
  try {
    const { model } = await bounded(
      cdp.send("DOM.getBoxModel", { nodeId }),
      PROBE_MS,
      "DOM.getBoxModel",
    )
    return { width: model.width, height: model.height }
  } catch {
    return null
  }
}

async function shadowsAndCanvases(
  cdp: CDPSession,
): Promise<Pick<Unseen, "closedShadowRoots" | "canvases">> {
  try {
    const { root } = await bounded(
      cdp.send("DOM.getDocument", { depth: -1, pierce: true }),
      PROBE_MS,
      "DOM.getDocument",
    )
    const found = domUnseen(root as DomNode)
    let canvases = 0

    for (const nodeId of found.canvases.slice(0, MAX_UNSEEN_FRAMES)) {
      if (bigEnough(await canvasBox(cdp, nodeId))) {
        canvases += 1
      }
    }

    return { closedShadowRoots: found.closedShadowRoots, canvases }
  } catch {
    return { closedShadowRoots: 0, canvases: 0 }
  }
}

/** An iframe element's frame, when it shows a page at a size worth seeing. */
async function shownFrame(
  pageOrigin: string | null,
  locator: Locator,
): Promise<{ crossOrigin: boolean } | null> {
  try {
    if (!bigEnough(await locator.boundingBox({ timeout: PROBE_MS }))) {
      return null
    }

    const handle = await locator.elementHandle({ timeout: PROBE_MS })

    if (!handle) {
      return null
    }

    try {
      const frame = await bounded(handle.contentFrame(), PROBE_MS, "frame")
      const origin = frame ? originOf(frame.url()) : null
      return origin ? { crossOrigin: origin !== pageOrigin } : null
    } finally {
      await handle.dispose().catch(() => {})
    }
  } catch {
    return null
  }
}

/**
 * What the page holds that the snapshot `nodes` leaves out: each iframe it
 * shows with nothing inside (by its ref, through `resolve`), closed shadow
 * roots, and canvases.
 */
export async function unseenInSnapshot(
  holder: { page: Page; cdp: CDPSession },
  nodes: SnapshotNode[],
  resolve: (ref: string) => Promise<Locator | null>,
): Promise<Unseen> {
  const pageOrigin = originOf(holder.page.url())
  const frames: UnseenFrame[] = []
  const empty = allNodes(nodes)
    .filter(
      (node) =>
        node.role === "iframe" && node.ref && node.children.length === 0,
    )
    .slice(0, MAX_UNSEEN_FRAMES)

  for (const node of empty) {
    const locator = await resolve(node.ref!).catch(() => null)
    const shown = locator ? await shownFrame(pageOrigin, locator) : null

    if (shown) {
      frames.push({ ref: node.ref, crossOrigin: shown.crossOrigin })
    }
  }

  return { frames, ...(await shadowsAndCanvases(holder.cdp)) }
}

/**
 * What the page holds that its HTML (read_page's text, which is the main
 * frame's alone) leaves out: every iframe it shows a page in, closed
 * shadow roots, and canvases.
 */
export async function unseenInHtml(holder: {
  page: Page
  cdp: CDPSession
}): Promise<Unseen> {
  const pageOrigin = originOf(holder.page.url())
  const frames: UnseenFrame[] = []

  for (const frame of holder.page
    .mainFrame()
    .childFrames()
    .slice(0, MAX_UNSEEN_FRAMES)) {
    const origin = originOf(frame.url())

    if (!origin) {
      continue
    }

    const element = await bounded(
      frame.frameElement(),
      PROBE_MS,
      "frameElement",
    ).catch(() => null)
    const box = element
      ? await bounded(element.boundingBox(), PROBE_MS, "boundingBox").catch(
          () => null,
        )
      : null
    await element?.dispose().catch(() => {})

    if (bigEnough(box)) {
      frames.push({ ref: null, crossOrigin: origin !== pageOrigin })
    }
  }

  return { frames, ...(await shadowsAndCanvases(holder.cdp)) }
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function refsOf(frames: UnseenFrame[]): string {
  const refs = frames.flatMap((frame) => (frame.ref ? [frame.ref] : []))

  return refs.length === 0
    ? ""
    : ` (${refs.length === 1 ? "ref" : "refs"} ${refs.join(", ")})`
}

/** "a, b and c". */
function listed(parts: string[]): string {
  return parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
}

/** Whether a probe found anything. */
export function anythingUnseen(unseen: Unseen): boolean {
  return (
    unseen.frames.length > 0 ||
    unseen.closedShadowRoots > 0 ||
    unseen.canvases > 0
  )
}

/**
 * The line an answer carries when the page holds what it could not read:
 * "2 cross-origin iframes (refs e3, e8) not included; take a screenshot and
 * OCR it to see them (…)". `ocr` says how (ocr.ts ocrHint). Null when the
 * probe found nothing.
 */
export function unseenLine(unseen: Unseen, ocr: string): string | null {
  if (!anythingUnseen(unseen)) {
    return null
  }

  const foreign = unseen.frames.filter((frame) => frame.crossOrigin)
  const own = unseen.frames.filter((frame) => !frame.crossOrigin)
  const parts = [
    ...(foreign.length > 0
      ? [
          `${counted(foreign.length, "cross-origin iframe", "cross-origin iframes")}${refsOf(foreign)}`,
        ]
      : []),
    ...(own.length > 0
      ? [`${counted(own.length, "iframe", "iframes")}${refsOf(own)}`]
      : []),
    ...(unseen.closedShadowRoots > 0
      ? [
          counted(
            unseen.closedShadowRoots,
            "closed shadow root",
            "closed shadow roots",
          ),
        ]
      : []),
    ...(unseen.canvases > 0
      ? [counted(unseen.canvases, "canvas", "canvases")]
      : []),
  ]

  return `${listed(parts)} not included: the page shows more than this. Take a screenshot to see them (view_image with crop shows you part of it closer) and OCR it to read their text (${ocr}); click with a point (x, y) from the screenshot reaches into them.`
}

/**
 * Words of a find that looks for part of a form: on a page with unseen
 * parts, a find that matches none says the form may be in one of them.
 */
const FORM_WORDS =
  /\b(e-?mail|name|phone|telephone|address|postcode|zip|password|log ?in|sign ?(in|up)|submit|send|subscribe|register|search|form|field|input|button|checkbox|consent|accept|agree)\b/i

export function formLike(text: string): boolean {
  return FORM_WORDS.test(text)
}
