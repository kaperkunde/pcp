import type { Locator } from "patchright-core"

import { MAX_ANSWER_IMAGE_CHARS } from "../answers"
import { PcpError } from "../errors"
import {
  ACTION_TIMEOUT_MS,
  MAX_FULL_PAGE_HEIGHT,
  MAX_FULL_PAGE_WIDTH,
  MAX_SCREENSHOT_BYTES,
  SCREENSHOT_QUALITIES,
  SCREENSHOT_SCALED_QUALITY,
  SCREENSHOT_SCALES,
} from "./limits"
import { bounded } from "./queue"
import type { Tab } from "./runtime"

/**
 * screenshot's picture: the tab's viewport, or one element of it, as a
 * JPEG small enough for an answer to pass on inline (answers.ts
 * MAX_ANSWER_IMAGE_CHARS). Its quality steps down first, then its size; a
 * picture that fits at none of them is kept (up to MAX_SCREENSHOT_BYTES)
 * and handed back as a handle. Taken with the DevTools protocol, which
 * scales the picture as it takes it.
 */

/** What fits inline, in bytes (base64 is four characters for three). */
export const INLINE_IMAGE_BYTES = Math.floor(MAX_ANSWER_IMAGE_CHARS / 4) * 3

export type Shot = { quality: number; scale: number }
export type Picture = Shot & { bytes: Buffer }

/** The shots to try, in order: each quality at full size, then smaller. */
export function shotLadder({
  quality,
  scale,
}: {
  quality?: number
  scale: number
}): Shot[] {
  const top = quality ?? SCREENSHOT_QUALITIES[0]
  const qualities = [top, ...SCREENSHOT_QUALITIES.filter((step) => step < top)]
  const scaled = Math.min(top, SCREENSHOT_SCALED_QUALITY)

  return [
    ...qualities.map((step) => ({ quality: step, scale })),
    ...SCREENSHOT_SCALES.map((step) => ({
      quality: scaled,
      scale: scale * step,
    })),
  ]
}

/**
 * The first shot whose picture fits `inlineBytes`; if none does, the
 * smallest, while it is no larger than `maxBytes`.
 */
export async function fitPicture(
  capture: (shot: Shot) => Promise<Buffer>,
  ladder: Shot[],
  {
    inlineBytes = INLINE_IMAGE_BYTES,
    maxBytes = MAX_SCREENSHOT_BYTES,
  }: { inlineBytes?: number; maxBytes?: number } = {},
): Promise<Picture> {
  let smallest: Picture | null = null

  for (const shot of ladder) {
    const bytes = await capture(shot)

    if (bytes.length <= inlineBytes) {
      return { ...shot, bytes }
    }

    if (!smallest || bytes.length < smallest.bytes.length) {
      smallest = { ...shot, bytes }
    }
  }

  if (smallest && smallest.bytes.length <= maxBytes) {
    return smallest
  }

  throw new PcpError("state", "The page's picture is too large to hand back.")
}

type Area = { x: number; y: number; width: number; height: number }

async function layout(tab: Tab) {
  return bounded(
    tab.cdp.send("Page.getLayoutMetrics"),
    ACTION_TIMEOUT_MS,
    "page.screenshot",
  )
}

/**
 * The area full_page takes: the whole page from its top left, as its
 * content size says, held to MAX_FULL_PAGE_WIDTH and MAX_FULL_PAGE_HEIGHT;
 * `cut` when the page goes on past that.
 */
export function fullPageArea(content: { width: number; height: number }): {
  area: Area
  cut: boolean
} {
  const width = Math.max(1, Math.ceil(content.width))
  const height = Math.max(1, Math.ceil(content.height))

  return {
    area: {
      x: 0,
      y: 0,
      width: Math.min(width, MAX_FULL_PAGE_WIDTH),
      height: Math.min(height, MAX_FULL_PAGE_HEIGHT),
    },
    cut: width > MAX_FULL_PAGE_WIDTH || height > MAX_FULL_PAGE_HEIGHT,
  }
}

/**
 * The tab's viewport, the whole page (`fullPage`, from its top, as far as
 * fullPageArea goes), or the part of an element that shows in the viewport
 * (scrolled into view first), as a picture that fits; null when the element
 * shows nowhere on the page.
 */
export async function takePicture(
  tab: Tab,
  {
    element,
    fullPage = false,
    maxWidth,
    quality,
  }: {
    element?: Locator
    fullPage?: boolean
    maxWidth?: number
    quality?: number
  },
): Promise<
  | (Picture & {
      width: number
      height: number
      /**
       * Where its top left is in the viewport, in CSS pixels; for the whole
       * page, where the viewport's top left is in it, negated.
       */
      origin: { x: number; y: number }
      /** The whole page: taken from the page's top, not the viewport. */
      fullPage: boolean
      /** The whole page went on past what full_page takes. */
      cut: boolean
    })
  | null
> {
  if (element) {
    await element
      .scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
      .catch(() => {})
  }

  const metrics = await layout(tab)
  const view = metrics.cssVisualViewport
  // Document coordinates, as the protocol takes them.
  let area: Area = {
    x: view.pageX,
    y: view.pageY,
    width: view.clientWidth,
    height: view.clientHeight,
  }
  let cut = false

  if (fullPage) {
    ;({ area, cut } = fullPageArea(metrics.cssContentSize))
  }

  if (element) {
    const box = await element.boundingBox({ timeout: ACTION_TIMEOUT_MS })

    if (!box) {
      return null
    }

    const left = Math.max(box.x, 0)
    const top = Math.max(box.y, 0)
    const right = Math.min(box.x + box.width, view.clientWidth)
    const bottom = Math.min(box.y + box.height, view.clientHeight)

    if (right - left < 1 || bottom - top < 1) {
      return null
    }

    area = {
      x: view.pageX + left,
      y: view.pageY + top,
      width: right - left,
      height: bottom - top,
    }
  }

  const scale = maxWidth && maxWidth < area.width ? maxWidth / area.width : 1
  const picture = await fitPicture(async (shot) => {
    const { data } = await bounded(
      tab.cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: shot.quality,
        clip: { ...area, scale: shot.scale },
        ...(fullPage ? { captureBeyondViewport: true } : {}),
      }),
      ACTION_TIMEOUT_MS,
      "page.screenshot",
    )
    return Buffer.from(data, "base64")
  }, shotLadder({ quality, scale }))

  return {
    ...picture,
    width: Math.round(area.width * picture.scale),
    height: Math.round(area.height * picture.scale),
    origin: { x: area.x - view.pageX, y: area.y - view.pageY },
    fullPage,
    cut,
  }
}
