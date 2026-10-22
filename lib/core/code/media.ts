import type { OutputInfo } from "sharp"
import type SharpType from "sharp"

import { bareType, sniffMediaType } from "../media-types"
import {
  DEFAULT_FRAME_WIDTH,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_VIDEO_FRAMES,
  IMAGE_TIMEOUT_S,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  MAX_VIDEO_FRAMES,
} from "./limits"

/**
 * Images and videos for a program (the bridge's `media` operation, run.ts):
 * a kept image made smaller (pcp.image.compress) and frames taken from a
 * kept video (pcp.video.frames), each kept again as a result of the
 * token's, so an assistant looks at a small picture rather than a large one.
 *
 * Images are decoded here, in PCP's process, never in the program's engine:
 * the program sends a handle and options as JSON and gets a handle back.
 * The codec is sharp's WebAssembly build (@img/sharp-wasm32), the same in
 * the container, a checkout and the Mac app, with no native code
 * (pnpm-workspace.yaml leaves sharp's native packages out). It reads PNG,
 * JPEG, WebP and GIF only, by their bytes, up to MAX_IMAGE_PIXELS, one
 * image at a time; what it writes carries no metadata (no EXIF, no place).
 *
 * Videos are not decoded here: frames come from ffmpeg in the sandbox
 * (sandbox/pcp.py `frames`), which run.ts hands the job to.
 */

/** The image types pcp.image reads, by their first bytes. */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
])

const FORMATS = ["jpeg", "webp", "png"] as const
export type ImageFormat = (typeof FORMATS)[number]

const MEDIA_TYPE: Record<ImageFormat, string> = {
  jpeg: "image/jpeg",
  webp: "image/webp",
  png: "image/png",
}

const EXTENSION: Record<ImageFormat, string> = {
  jpeg: "jpg",
  webp: "webp",
  png: "png",
}

export type ImageOptions = {
  maxWidth?: number
  maxHeight?: number
  crop?: { x: number; y: number; width: number; height: number }
  grayscale?: boolean
  format: ImageFormat
  quality?: number
}

export type FrameOptions = {
  at?: number[]
  every?: number
  count?: number
  maxWidth: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isWhole(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  )
}

const IMAGE_OPTIONS = new Set([
  "maxWidth",
  "maxHeight",
  "crop",
  "grayscale",
  "format",
  "quality",
])

/**
 * pcp.image.compress's options as the program sent them, checked: the
 * options, or what is wrong with them.
 */
export function readImageOptions(
  value: unknown,
): { ok: true; options: ImageOptions } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error })
  const options = value ?? {}

  if (!isRecord(options)) {
    return fail(
      "pcp.image.compress takes a handle and options: { maxWidth, maxHeight, crop, grayscale, format, quality }.",
    )
  }

  const unknown = Object.keys(options).find((key) => !IMAGE_OPTIONS.has(key))

  if (unknown !== undefined) {
    return fail(
      `pcp.image.compress has no option "${unknown.slice(0, 40)}": it takes maxWidth, maxHeight, crop, grayscale, format and quality.`,
    )
  }

  const { maxWidth, maxHeight, crop, grayscale, format, quality } = options

  for (const [name, side] of [
    ["maxWidth", maxWidth],
    ["maxHeight", maxHeight],
  ] as const) {
    if (side !== undefined && !isWhole(side, 1, MAX_IMAGE_SIDE)) {
      return fail(
        `${name} is a whole number of pixels, 1 to ${MAX_IMAGE_SIDE.toLocaleString("en")}.`,
      )
    }
  }

  if (
    crop !== undefined &&
    !(
      isRecord(crop) &&
      isWhole(crop.x, 0, MAX_IMAGE_SIDE * 4) &&
      isWhole(crop.y, 0, MAX_IMAGE_SIDE * 4) &&
      isWhole(crop.width, 1, MAX_IMAGE_SIDE) &&
      isWhole(crop.height, 1, MAX_IMAGE_SIDE)
    )
  ) {
    return fail(
      "crop is { x, y, width, height } in whole pixels of the image as it shows: x and y from its top left corner.",
    )
  }

  if (grayscale !== undefined && typeof grayscale !== "boolean") {
    return fail("grayscale is true or false.")
  }

  if (
    format !== undefined &&
    !FORMATS.includes(format as (typeof FORMATS)[number])
  ) {
    return fail('format is "jpeg" (the default), "webp" or "png".')
  }

  if (quality !== undefined && !isWhole(quality, 1, 100)) {
    return fail("quality is a whole number from 1 to 100.")
  }

  return {
    ok: true,
    options: {
      ...(maxWidth !== undefined ? { maxWidth: maxWidth as number } : {}),
      ...(maxHeight !== undefined ? { maxHeight: maxHeight as number } : {}),
      ...(crop !== undefined
        ? {
            crop: {
              x: (crop as Record<string, number>).x!,
              y: (crop as Record<string, number>).y!,
              width: (crop as Record<string, number>).width!,
              height: (crop as Record<string, number>).height!,
            },
          }
        : {}),
      ...(grayscale !== undefined ? { grayscale } : {}),
      format: (format as ImageFormat | undefined) ?? "jpeg",
      ...(quality !== undefined ? { quality: quality as number } : {}),
    },
  }
}

const FRAME_OPTIONS = new Set(["at", "every", "count", "maxWidth"])

/** pcp.video.frames's options, checked, as for an image. */
export function readFrameOptions(
  value: unknown,
): { ok: true; options: FrameOptions } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error })
  const options = value ?? {}

  if (!isRecord(options)) {
    return fail(
      "pcp.video.frames takes a handle and options: { at, every, count, maxWidth }.",
    )
  }

  const unknown = Object.keys(options).find((key) => !FRAME_OPTIONS.has(key))

  if (unknown !== undefined) {
    return fail(
      `pcp.video.frames has no option "${unknown.slice(0, 40)}": it takes at, every, count and maxWidth.`,
    )
  }

  const { at, every, count, maxWidth } = options
  const named = [at, every, count].filter((item) => item !== undefined)

  if (named.length > 1) {
    return fail(
      "pcp.video.frames takes one of at (times in seconds), every (seconds between frames) or count (frames spread over the video).",
    )
  }

  if (
    at !== undefined &&
    !(
      Array.isArray(at) &&
      at.length > 0 &&
      at.length <= MAX_VIDEO_FRAMES &&
      at.every(
        (time) =>
          typeof time === "number" && Number.isFinite(time) && time >= 0,
      )
    )
  ) {
    return fail(
      `at is a list of 1 to ${MAX_VIDEO_FRAMES} times in seconds from the start, as [0, 2.5, 10].`,
    )
  }

  if (
    every !== undefined &&
    !(typeof every === "number" && Number.isFinite(every) && every > 0)
  ) {
    return fail("every is a number of seconds between frames, more than 0.")
  }

  if (count !== undefined && !isWhole(count, 1, MAX_VIDEO_FRAMES)) {
    return fail(`count is a whole number of frames, 1 to ${MAX_VIDEO_FRAMES}.`)
  }

  if (maxWidth !== undefined && !isWhole(maxWidth, 16, MAX_IMAGE_SIDE)) {
    return fail(
      `maxWidth is a whole number of pixels, 16 to ${MAX_IMAGE_SIDE.toLocaleString("en")}.`,
    )
  }

  return {
    ok: true,
    options: {
      ...(at !== undefined ? { at: at as number[] } : {}),
      ...(every !== undefined ? { every: every as number } : {}),
      ...(at === undefined && every === undefined
        ? { count: (count as number | undefined) ?? DEFAULT_VIDEO_FRAMES }
        : {}),
      maxWidth: (maxWidth as number | undefined) ?? DEFAULT_FRAME_WIDTH,
    },
  }
}

/** What a kept file is, by its bytes first and then its type: for refusals. */
export function mediaKind(
  bytes: Uint8Array,
  mediaType: string,
): { type: string; image: boolean; video: boolean } {
  const type = sniffMediaType(bytes) ?? bareType(mediaType)

  return {
    type,
    image: IMAGE_TYPES.has(type),
    video: type.startsWith("video/"),
  }
}

let loaded: Promise<typeof SharpType> | null = null

/** sharp, loaded the first time an image is asked for. */
function codec(): Promise<typeof SharpType> {
  loaded ??= import("sharp").then(
    ({ default: sharp }) => {
      // A long-lived process: nothing is cached between images, and libvips
      // works on one at a time, beside everything else PCP does.
      sharp.cache(false)
      sharp.concurrency(1)
      return sharp
    },
    (error: unknown) => {
      // Tried again next time; this image is refused.
      loaded = null
      throw error
    },
  )

  return loaded
}

/** Images take turns: one is decoded at a time in the process. */
let lane: Promise<unknown> = Promise.resolve()

export type CompressedImage = {
  bytes: Buffer
  width: number
  height: number
  type: string
  name: string
}

/** A file name for the new image, from the old one's. */
function nameFor(name: string | null, format: ImageFormat): string {
  const base = (name ?? "image").replace(/\.[a-z0-9]{1,8}$/i, "") || "image"

  return `${base}.${EXTENSION[format]}`
}

/** sharp's message, short and on one line, for the program. */
function codecMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  return message.replace(/\s+/g, " ").trim().slice(0, 200)
}

/**
 * The image in `bytes` cropped, made to fit, grey and encoded as asked; or
 * why not. `maxBytes` is the largest file PCP keeps: an image that comes out
 * larger is refused, not cut.
 */
export function compressImage(
  bytes: Buffer,
  {
    options,
    name,
    maxBytes,
  }: { options: ImageOptions; name: string | null; maxBytes: number },
): Promise<
  { ok: true; image: CompressedImage } | { ok: false; error: string }
> {
  const turn = lane.then(() => compress(bytes, options, name, maxBytes))
  lane = turn.catch(() => {})
  return turn
}

async function compress(
  bytes: Buffer,
  options: ImageOptions,
  name: string | null,
  maxBytes: number,
): Promise<
  { ok: true; image: CompressedImage } | { ok: false; error: string }
> {
  let sharp: typeof SharpType

  try {
    sharp = await codec()
  } catch (error) {
    console.error("[run_code] the image codec did not load", {
      error: codecMessage(error),
    })
    return { ok: false, error: "PCP could not load its image codec." }
  }
  const input = {
    limitInputPixels: MAX_IMAGE_PIXELS,
    failOn: "error" as const,
    // The picture as it shows, turned as its EXIF says; a GIF's first frame.
    autoOrient: true,
    pages: 1,
  }
  let shown: { width: number; height: number }

  try {
    // Only the header is read here, with no limit, so that a picture too
    // large is refused by its size rather than a codec's error.
    const metadata = await sharp(bytes, {
      ...input,
      limitInputPixels: false,
    }).metadata()

    if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
      return {
        ok: false,
        error: `The image is ${metadata.width.toLocaleString("en")} × ${metadata.height.toLocaleString("en")} pixels, more than PCP decodes (${(MAX_IMAGE_PIXELS / 1_000_000).toLocaleString("en")} million).`,
      }
    }

    shown = metadata.autoOrient
  } catch (error) {
    return {
      ok: false,
      error: `PCP could not read that image: ${codecMessage(error)}`,
    }
  }

  const { crop } = options

  if (
    crop &&
    (crop.x + crop.width > shown.width || crop.y + crop.height > shown.height)
  ) {
    return {
      ok: false,
      error: `The crop goes past the image, which is ${shown.width} × ${shown.height} pixels.`,
    }
  }

  const quality = options.quality ?? DEFAULT_IMAGE_QUALITY
  let pipeline = sharp(bytes, input).timeout({ seconds: IMAGE_TIMEOUT_S })

  if (crop) {
    pipeline = pipeline.extract({
      left: crop.x,
      top: crop.y,
      width: crop.width,
      height: crop.height,
    })
  }

  if (options.maxWidth !== undefined || options.maxHeight !== undefined) {
    pipeline = pipeline.resize({
      ...(options.maxWidth !== undefined ? { width: options.maxWidth } : {}),
      ...(options.maxHeight !== undefined ? { height: options.maxHeight } : {}),
      fit: "inside",
      withoutEnlargement: true,
    })
  }

  if (options.grayscale) {
    // One channel where the format has one (JPEG, PNG): a third the size.
    pipeline = pipeline.grayscale()

    if (options.format !== "webp") {
      pipeline = pipeline.toColourspace("b-w")
    }
  }

  switch (options.format) {
    case "jpeg":
      // JPEG has no transparency: what was clear shows white.
      pipeline = pipeline
        .flatten({ background: "#ffffff" })
        .jpeg({ quality, mozjpeg: true })
      break
    case "webp":
      pipeline = pipeline.webp({ quality })
      break
    case "png":
      // A quality asks for a palette, which makes a screenshot far smaller.
      pipeline = pipeline.png({
        compressionLevel: 9,
        ...(options.quality !== undefined
          ? { palette: true, quality: options.quality }
          : {}),
      })
      break
  }

  let output: { data: Buffer; info: OutputInfo }

  try {
    output = await pipeline.toBuffer({ resolveWithObject: true })
  } catch (error) {
    return {
      ok: false,
      error: `PCP could not make that image: ${codecMessage(error)}`,
    }
  }

  if (output.data.length > maxBytes) {
    return {
      ok: false,
      error: `The image came out at ${output.data.length.toLocaleString("en")} bytes, more than PCP keeps of one file (${maxBytes.toLocaleString("en")}). Ask for a smaller size or a lower quality.`,
    }
  }

  return {
    ok: true,
    image: {
      bytes: output.data,
      width: output.info.width,
      height: output.info.height,
      type: MEDIA_TYPE[options.format],
      name: nameFor(name, options.format),
    },
  }
}

/**
 * The Python program the sandbox runs for pcp.video.frames: sandbox/pcp.py's
 * `frames`, on the one result named, with the options checked here. Only
 * JSON goes into it, as a string Python reads as one.
 */
export function framesProgram(id: string, options: FrameOptions): string {
  const request = JSON.stringify({
    handle: { $result: id },
    at: options.at ?? null,
    every: options.every ?? null,
    count: options.count ?? null,
    max_width: options.maxWidth,
  })

  return [
    "import json, sys",
    "import pcp",
    `request = json.loads(${JSON.stringify(request)})`,
    "try:",
    "    found = pcp.frames(request.pop('handle'), **request)",
    "except pcp.PcpError as error:",
    "    sys.stdout.write(json.dumps({'error': str(error)}) + '\\n')",
    "else:",
    "    sys.stdout.write(json.dumps({'value': found}) + '\\n')",
    "",
  ].join("\n")
}
