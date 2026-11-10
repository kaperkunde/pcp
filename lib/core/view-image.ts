import type { CallToolResult } from "@modelcontextprotocol/server"

import {
  fitPicture,
  INLINE_IMAGE_BYTES,
  shotLadder,
  type Shot,
} from "./browser/screenshot"
import {
  DEFAULT_IMAGE_QUALITY,
  MAX_IMAGE_SIDE,
  VIEW_IMAGE_SIDE,
} from "./code/limits"
import { decodeImage, encodeJpeg } from "./code/media"
import { runProgram } from "./code/run"
import { sandboxLanguages } from "./code/sandbox"
import { isPcpError } from "./errors"
import { bareType, sniffMediaType } from "./media-types"
import type { PermissionScope } from "./permissions"
import { missingResultMessage } from "./result-handles"
import { openResult, type OpenedResult } from "./tool-results"
import { passOn, toolError, type Outcome } from "./tools/outcome"

/**
 * view_image: one of the token's kept files shown to the assistant as a
 * picture (MCP image content), so the model's own vision reads it rather
 * than only an OCR reading of its text. Nothing here looks at the picture:
 * it is made to fit and handed on.
 *
 * - An image (PNG, JPEG, WebP or GIF, by its first bytes: never an SVG,
 *   which is text) is cropped, made grey and made smaller as asked, then
 *   encoded as a JPEG small enough to pass on inline, stepping its quality
 *   and then its size down as a screenshot's are (browser/screenshot.ts
 *   fitPicture and shotLadder), decoded and encoded by code/media.ts.
 * - A PDF is refused with the call that makes its page a picture first:
 *   convert_document's to "png" (capabilities/, a provider at its own
 *   Write tier). view_image is Read and calls no tool.
 * - A video's frame is taken by ffmpeg in the sandbox, as run_code's
 *   pcp.video.frames takes it (a program of PCP's own through runProgram,
 *   with no tool to call): only when the sandbox runner is connected.
 *
 * A frame taken on the way is kept as a result of the token's, so the
 * assistant can look closer at it (crop) without taking it again.
 */

export type Crop = { x: number; y: number; width: number; height: number }

export type ViewImageArgs = {
  file: { $result: string }
  max_width?: number
  crop?: Crop
  grayscale?: boolean
  quality?: number
  time_s?: number
}

export type ViewSettings = {
  maxWidth?: number
  crop?: Crop
  grayscale?: boolean
  quality?: number
}

export type FittedImage = {
  bytes: Buffer
  width: number
  height: number
  quality: number
  /** Below 1 when it was made smaller than asked, to pass on. */
  scale: number
  /** The size the original shows at. */
  source: { width: number; height: number }
}

/** The image types view_image shows, by their first bytes. */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
])

/** What a kept file is, for view_image. */
export function viewKind(
  bytes: Uint8Array,
  mediaType: string,
): { kind: "image" | "svg" | "pdf" | "video" | "other"; type: string } {
  const sniffed = sniffMediaType(bytes)
  const type = sniffed ?? bareType(mediaType)

  if (sniffed && IMAGE_TYPES.has(sniffed)) {
    return { kind: "image", type }
  }

  // An SVG by its type, or by its markup whatever its type says.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("utf8")

  if (!sniffed && (type === "image/svg+xml" || /<svg[\s>]/i.test(head))) {
    return { kind: "svg", type: "image/svg+xml" }
  }

  if (type === "application/pdf") {
    return { kind: "pdf", type }
  }

  if (type.startsWith("video/")) {
    return { kind: "video", type }
  }

  return { kind: "other", type }
}

class Refused extends Error {}

/**
 * The image in `bytes` as a JPEG that fits `inlineBytes`: decoded once,
 * cropped and grey as asked, its longest side at most VIEW_IMAGE_SIDE (its
 * width at most maxWidth), then encoded from those pixels with its quality
 * and size stepped down until it fits. A signal that aborts stops it
 * between steps.
 */
export async function fitImage(
  bytes: Buffer,
  settings: ViewSettings,
  {
    inlineBytes = INLINE_IMAGE_BYTES,
    signal,
  }: { inlineBytes?: number; signal?: AbortSignal } = {},
): Promise<{ ok: true; image: FittedImage } | { ok: false; error: string }> {
  const gone = {
    ok: false as const,
    error: "The request went away, so PCP stopped making the picture.",
  }

  if (signal?.aborted) {
    return gone
  }

  const decoded = await decodeImage(bytes, {
    ...(settings.crop ? { crop: settings.crop } : {}),
    ...(settings.grayscale ? { grayscale: true } : {}),
    maxWidth: Math.min(settings.maxWidth ?? VIEW_IMAGE_SIDE, VIEW_IMAGE_SIDE),
    maxHeight: VIEW_IMAGE_SIDE,
  })

  if (!decoded.ok) {
    return decoded
  }

  const { raw } = decoded
  const sizes = new Map<Buffer, { width: number; height: number }>()

  const capture = async (shot: Shot): Promise<Buffer> => {
    if (signal?.aborted) {
      throw new Refused(gone.error)
    }

    const made = await encodeJpeg(raw, {
      quality: shot.quality,
      width: Math.max(1, Math.round(raw.width * shot.scale)),
      height: Math.max(1, Math.round(raw.height * shot.scale)),
    })

    if (!made.ok) {
      throw new Refused(made.error)
    }

    sizes.set(made.bytes, { width: made.width, height: made.height })
    return made.bytes
  }

  try {
    const picture = await fitPicture(
      capture,
      shotLadder({
        quality: settings.quality ?? DEFAULT_IMAGE_QUALITY,
        scale: 1,
      }),
      { inlineBytes, maxBytes: inlineBytes },
    )
    const size = sizes.get(picture.bytes)!

    return {
      ok: true,
      image: {
        bytes: picture.bytes,
        width: size.width,
        height: size.height,
        quality: picture.quality,
        scale: picture.scale,
        source: decoded.shown,
      },
    }
  } catch (error) {
    if (error instanceof Refused) {
      return { ok: false, error: error.message }
    }

    if (isPcpError(error)) {
      return {
        ok: false,
        error:
          "The picture does not fit in an answer even at its smallest: crop it to the part you need.",
      }
    }

    throw error
  }
}

function sized(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function handleText(id: string): string {
  return JSON.stringify({ $result: id })
}

/** convert_document's arguments that make a PDF's first page a picture. */
export function pdfCall(id: string): string {
  return JSON.stringify({ file: { $result: id }, to: "png", page: 1 })
}

/** The answer: a line on what was shown and how, then the picture. */
async function show(
  bytes: Buffer,
  args: ViewImageArgs,
  what: string,
  signal: AbortSignal | undefined,
): Promise<Outcome> {
  const fitted = await fitImage(
    bytes,
    {
      ...(args.max_width !== undefined ? { maxWidth: args.max_width } : {}),
      ...(args.crop ? { crop: args.crop } : {}),
      ...(args.grayscale ? { grayscale: true } : {}),
      ...(args.quality !== undefined ? { quality: args.quality } : {}),
    },
    signal ? { signal } : {},
  )

  if (!fitted.ok) {
    return toolError(fitted.error, { code: "validation" })
  }

  const { image } = fitted
  const source = image.source
  const done = [
    ...(args.crop
      ? [
          `cropped to ${args.crop.width} × ${args.crop.height} at (${args.crop.x}, ${args.crop.y})`,
        ]
      : []),
    ...(args.grayscale ? ["in grey"] : []),
    ...(image.quality < (args.quality ?? DEFAULT_IMAGE_QUALITY)
      ? [
          `its quality lowered from ${args.quality ?? DEFAULT_IMAGE_QUALITY} to pass on`,
        ]
      : []),
    ...(image.scale < 1 ? ["made smaller to pass on"] : []),
  ]
  const lines = [
    `${what}: ${source.width} × ${source.height} pixels, ${sized(bytes.length)}. Shown at ${image.width} × ${image.height}, JPEG quality ${image.quality}${done.length > 0 ? `, ${done.join(", ")}` : ""}.`,
    "To look closer at a part, call view_image again with crop (x, y, width, height in pixels of the original, from its top left corner). read_image reads its text (OCR).",
  ]
  const result: CallToolResult = {
    content: [
      { type: "text", text: lines.join("\n") },
      {
        type: "image",
        data: image.bytes.toString("base64"),
        mimeType: "image/jpeg",
      },
    ],
  }

  return passOn(result)
}

function nameOf(opened: OpenedResult): string {
  return opened.name ? `${opened.name} (${opened.id})` : opened.id
}

/** The program that takes one frame, through run_code's own bridge. */
function frameProgram(id: string, at: number | undefined): string {
  const options =
    at === undefined
      ? { count: 1, maxWidth: MAX_IMAGE_SIDE }
      : { at: [at], maxWidth: MAX_IMAGE_SIDE }

  return `return await pcp.video.frames(${JSON.stringify({ $result: id })}, ${JSON.stringify(options)})`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** One frame of a kept video, kept as a JPEG of the token's: its id. */
async function takeFrame(
  scope: PermissionScope,
  id: string,
  at: number | undefined,
  signal: AbortSignal | undefined,
): Promise<{ id: string; t: number; duration: number } | Outcome> {
  const run = await runProgram(
    scope,
    { code: frameProgram(id, at), label: "run_code", logAs: "view_image" },
    {
      call: async () => ({
        ok: false,
        error: "view_image calls no tools.",
        refused: true,
      }),
      ...(signal ? { signal } : {}),
    },
  )

  if ("busy" in run) {
    return toolError(run.busy, { code: "state" })
  }

  if (run.result.kind === "error") {
    return toolError(
      `PCP could not take a frame of that video: ${run.result.message.replace(/^Error: /, "")}`,
      { code: "upstream" },
    )
  }

  if (run.result.kind !== "done" || run.result.returned === null) {
    return toolError("PCP could not take a frame of that video.", {
      code: "upstream",
    })
  }

  const found: unknown = JSON.parse(run.result.returned)
  const frame =
    isRecord(found) && Array.isArray(found.frames) ? found.frames[0] : null
  const handle = isRecord(frame) ? frame.handle : null
  const frameId = isRecord(handle) ? handle.$result : null

  if (typeof frameId !== "string") {
    return toolError("PCP could not take a frame of that video.", {
      code: "upstream",
    })
  }

  return {
    id: frameId,
    t: isRecord(frame) && typeof frame.t === "number" ? frame.t : (at ?? 0),
    duration:
      isRecord(found) && typeof found.duration === "number"
        ? found.duration
        : 0,
  }
}

export type ViewImageDeps = {
  /** The request's: a frame's run stops when it goes away. */
  signal?: AbortSignal
}

/** view_image's work: the file, made a picture that fits, as image content. */
export async function viewImage(
  scope: PermissionScope,
  args: ViewImageArgs,
  deps: ViewImageDeps,
): Promise<Outcome> {
  const opened = await openResult(scope.ctx, {
    tokenId: scope.tokenId,
    id: args.file.$result,
  })

  if (!opened) {
    return toolError(missingResultMessage(), { code: "not_found" })
  }

  const bytes = opened.bytes()
  const { kind, type } = viewKind(bytes, opened.mediaType)
  const refuse = (message: string) => toolError(message, { code: "validation" })

  if (args.time_s !== undefined && kind !== "video") {
    return refuse(`time_s is for a video; ${nameOf(opened)} is ${type}.`)
  }

  switch (kind) {
    case "image":
      return show(bytes, args, `${nameOf(opened)}, ${type}`, deps.signal)
    case "svg":
      return refuse(
        `${nameOf(opened)} is an SVG, which PCP does not show as a picture: it is text (markup that can hold scripts and links). Read it with read_result.`,
      )
    case "pdf":
      return refuse(
        `${nameOf(opened)} is a PDF, not a picture: convert the page first with convert_document ${pdfCall(opened.id)} (page counts from 1), then call view_image with the handle it answers.`,
      )
    case "video": {
      if (!sandboxLanguages().includes("python")) {
        return toolError(
          `${nameOf(opened)} is a video (${type}): PCP takes a video's frames in its sandbox, which is not connected to this PCP. view_image shows pictures without it; the owner can add the sandbox (docs/self-hosting.md).`,
          { code: "state" },
        )
      }

      const frame = await takeFrame(scope, opened.id, args.time_s, deps.signal)

      if ("type" in frame) {
        return frame
      }

      const picture = await openResult(scope.ctx, {
        tokenId: scope.tokenId,
        id: frame.id,
      })

      if (!picture) {
        return toolError("PCP could not take a frame of that video.", {
          code: "upstream",
        })
      }

      return show(
        picture.bytes(),
        args,
        `The frame at ${frame.t} s of ${nameOf(opened)}${frame.duration > 0 ? ` (${frame.duration.toFixed(1)} s long)` : ""}, kept as ${handleText(picture.id)} (pass that to view_image to crop it); image/jpeg`,
        deps.signal,
      )
    }
    default:
      return refuse(
        `${nameOf(opened)} is ${type}, not a picture or video PCP shows. view_image takes PNG, JPEG, WebP and GIF pictures and videos (a PDF's page: convert_document to "png" first).`,
      )
  }
}
