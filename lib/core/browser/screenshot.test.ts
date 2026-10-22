import { describe, expect, it } from "vitest"

import { MAX_ANSWER_IMAGE_CHARS } from "../answers"
import { MAX_SCREENSHOT_BYTES } from "./limits"
import {
  fitPicture,
  INLINE_IMAGE_BYTES,
  shotLadder,
  type Shot,
} from "./screenshot"

// A screenshot is made small enough to pass on inline: its quality steps
// down first, then its size. A fake camera stands in for Chromium: its
// picture's size grows with quality and with the area it covers.

function camera(bytesAtFull: number) {
  const taken: Shot[] = []

  return {
    taken,
    capture: async (shot: Shot) => {
      taken.push(shot)
      return Buffer.alloc(
        Math.round(bytesAtFull * (shot.quality / 70) * shot.scale ** 2),
      )
    },
  }
}

describe("a screenshot's size", () => {
  it("fits what an answer passes on inline, in base64", () => {
    expect(Math.ceil(INLINE_IMAGE_BYTES / 3) * 4).toBeLessThanOrEqual(
      MAX_ANSWER_IMAGE_CHARS,
    )
  })

  it("is the first shot when that fits", async () => {
    const { capture, taken } = camera(100_000)
    const picture = await fitPicture(capture, shotLadder({ scale: 1 }))

    expect(picture).toMatchObject({ quality: 70, scale: 1 })
    expect(taken).toHaveLength(1)
  })

  it("steps the quality down, then the size, until it fits", async () => {
    const { capture, taken } = camera(INLINE_IMAGE_BYTES * 3)
    const picture = await fitPicture(capture, shotLadder({ scale: 1 }))

    expect(taken).toEqual([
      { quality: 70, scale: 1 },
      { quality: 55, scale: 1 },
      { quality: 40, scale: 1 },
      { quality: 30, scale: 1 },
      { quality: 40, scale: 0.75 },
    ])
    expect(picture.bytes.length).toBeLessThanOrEqual(INLINE_IMAGE_BYTES)
    expect(picture).toMatchObject({ quality: 40, scale: 0.75 })
  })

  it("starts from the quality and width asked for", () => {
    expect(shotLadder({ quality: 50, scale: 0.5 })).toEqual([
      { quality: 50, scale: 0.5 },
      { quality: 40, scale: 0.5 },
      { quality: 30, scale: 0.5 },
      { quality: 40, scale: 0.375 },
      { quality: 40, scale: 0.25 },
      { quality: 40, scale: 0.175 },
      { quality: 40, scale: 0.125 },
    ])
    expect(shotLadder({ quality: 20, scale: 1 })[0]).toEqual({
      quality: 20,
      scale: 1,
    })
    expect(shotLadder({ quality: 20, scale: 1 }).at(-1)).toEqual({
      quality: 20,
      scale: 0.25,
    })
  })

  it("keeps the smallest when none fits inline, up to what is kept of one, and refuses past that", async () => {
    const big = camera(INLINE_IMAGE_BYTES * 100)
    const kept = await fitPicture(big.capture, shotLadder({ scale: 1 }), {
      maxBytes: Number.MAX_SAFE_INTEGER,
    })
    expect(kept.scale).toBe(0.25)

    const huge = camera(MAX_SCREENSHOT_BYTES * 1000)
    await expect(
      fitPicture(huge.capture, shotLadder({ scale: 1 })),
    ).rejects.toThrow(/too large/)
  })
})
