import { randomBytes } from "node:crypto"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import type { CallToolResult } from "@modelcontextprotocol/server"
import sharp from "sharp"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import { INLINE_IMAGE_BYTES } from "./browser/screenshot"
import { VIEW_IMAGE_SIDE } from "./code/limits"
import { decodeImage, encodeJpeg } from "./code/media"
import { sandboxLanguages } from "./code/sandbox"
import type { Executor } from "./code/types"
import type { VaultContext } from "./context"
import { buildGatewayServer, type GatewayScope } from "./gateway"
import { scratchDatabase } from "./test-db"
import { keepBytes } from "./tool-results"
import { setupVault } from "./vault"
import { fitImage, viewKind } from "./view-image"
import { entryCall } from "./test-handles"

// view_image at /mcp: a kept picture shown as image content, made to fit;
// a video's frame through a fake sandbox; what it refuses. A PDF's page
// (convert_document's, a provider's work) is tested with the capabilities,
// against fake providers (capabilities.test.ts).

const sandbox = vi.hoisted(() => ({
  languages: [] as string[],
  executor: null as Executor | null,
}))

vi.mock("./code/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./code/sandbox")>()),
  sandboxLanguages: () => sandbox.languages,
  sandboxRuns: () => false,
  sandboxExecutor: () => sandbox.executor!,
}))

// The codec's two steps, counted: the original is decoded once.
vi.mock("./code/media", async (importOriginal) => {
  const media = await importOriginal<typeof import("./code/media")>()

  return {
    ...media,
    decodeImage: vi.fn(media.decodeImage),
    encodeJpeg: vi.fn(media.encodeJpeg),
  }
})

vi.mock("./request-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./request-log")>()),
  appendRequestLog: vi.fn(async () => {}),
}))

const PUBLIC_URL = "http://localhost:3000"

let cleanup: () => Promise<void>
let ctx: VaultContext
let scope: GatewayScope

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  })
  scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
})

afterEach(async () => {
  sandbox.languages = []
  sandbox.executor = null
  vi.mocked(decodeImage).mockClear()
  vi.mocked(encodeJpeg).mockClear()
  await cleanup()
})

async function view(args: Record<string, unknown>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, []).connect(serverSide)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  const result = (await client.callTool(
    entryCall("view_image", args),
  )) as CallToolResult
  await client.close()
  const text = result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
  const image = result.content.find((part) => part.type === "image")

  return {
    isError: result.isError === true,
    text,
    image: image
      ? {
          bytes: Buffer.from(image.data, "base64"),
          mimeType: image.mimeType,
        }
      : null,
  }
}

async function kept(
  bytes: Buffer,
  mediaType: string,
  name: string,
  tokenId = scope.tokenId,
): Promise<string> {
  const result = await keepBytes(ctx, {
    tokenId,
    serverId: null,
    toolName: "test",
    bytes,
    mediaType,
    name,
  })
  return result.id
}

/** A gradient, as a PNG: something in it, and small once a JPEG. */
async function gradient(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3)

  for (let index = 0; index < width * height; index++) {
    raw[index * 3] = (index % width) % 256
    raw[index * 3 + 1] = Math.floor(index / width) % 256
    raw[index * 3 + 2] = 128
  }

  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer()
}

describe("view_image on a picture", () => {
  it("shows a PNG as a JPEG no larger than it may be, saying what it did", async () => {
    const id = await kept(await gradient(2000, 1000), "image/png", "sign.png")

    const answer = await view({ file: { $result: id } })

    expect(answer.isError, answer.text).toBe(false)
    expect(answer.image?.mimeType).toBe("image/jpeg")
    const shown = await sharp(answer.image!.bytes).metadata()
    expect(shown).toMatchObject({
      format: "jpeg",
      width: VIEW_IMAGE_SIDE,
      height: Math.round((VIEW_IMAGE_SIDE * 1000) / 2000),
    })
    expect(answer.text).toContain("sign.png")
    expect(answer.text).toContain("2000 × 1000 pixels")
    expect(answer.text).toContain(`Shown at ${VIEW_IMAGE_SIDE} × 784`)
  })

  it("crops in the original's pixels, makes it grey and keeps to max_width", async () => {
    const id = await kept(await gradient(1600, 1200), "image/png", "a.png")

    const answer = await view({
      file: { $result: id },
      crop: { x: 100, y: 200, width: 800, height: 400 },
      grayscale: true,
      max_width: 400,
    })

    expect(answer.isError, answer.text).toBe(false)
    expect(await sharp(answer.image!.bytes).metadata()).toMatchObject({
      width: 400,
      height: 200,
      channels: 1,
    })
    expect(answer.text).toContain("cropped to 800 × 400 at (100, 200)")
    expect(answer.text).toContain("in grey")
  })

  it("shows a JPEG, and makes one that does not fit smaller until it does", async () => {
    const noise = await sharp(randomBytes(2400 * 2400 * 3), {
      raw: { width: 2400, height: 2400, channels: 3 },
    })
      .jpeg({ quality: 95 })
      .toBuffer()
    expect(noise.length).toBeGreaterThan(INLINE_IMAGE_BYTES)
    const id = await kept(noise, "application/octet-stream", "noise.bin")

    const answer = await view({ file: { $result: id }, quality: 90 })

    expect(answer.isError, answer.text).toBe(false)
    expect(answer.image!.bytes.length).toBeLessThanOrEqual(INLINE_IMAGE_BYTES)
    expect(answer.text).toContain("image/jpeg")
    expect(answer.text).toMatch(
      /quality lowered from 90 to pass on|made smaller to pass on/,
    )
    // Every step of the ladder encodes from the pixels decoded once.
    expect(vi.mocked(decodeImage)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(encodeJpeg).mock.calls.length).toBeGreaterThan(1)
  }, 60_000)

  it("stops between steps once the request went away", async () => {
    const noise = await sharp(randomBytes(1600 * 1600 * 3), {
      raw: { width: 1600, height: 1600, channels: 3 },
    })
      .jpeg({ quality: 95 })
      .toBuffer()
    const controller = new AbortController()
    const real = (
      await vi.importActual<typeof import("./code/media")>("./code/media")
    ).encodeJpeg
    vi.mocked(encodeJpeg).mockImplementationOnce(async (raw, options) => {
      controller.abort()
      return real(raw, options)
    })

    const fitted = await fitImage(
      noise,
      { quality: 90 },
      { signal: controller.signal, inlineBytes: 1_000 },
    )

    expect(fitted).toEqual({
      ok: false,
      error: "The request went away, so PCP stopped making the picture.",
    })
    expect(vi.mocked(encodeJpeg)).toHaveBeenCalledTimes(1)
  }, 60_000)

  it("refuses a crop past the picture's edge", async () => {
    const id = await kept(await gradient(300, 200), "image/png", "small.png")

    const answer = await view({
      file: { $result: id },
      crop: { x: 250, y: 0, width: 100, height: 100 },
    })

    expect(answer.isError).toBe(true)
    expect(answer.text).toContain("300 × 200")
    expect(answer.image).toBeNull()
  })
})

describe("view_image on a video", () => {
  it("shows a frame the sandbox took, kept so a closer look reuses it", async () => {
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from("ftypisom"),
      Buffer.alloc(32),
    ])
    const video = await kept(mp4, "video/mp4", "clip.mp4")
    const frame = await sharp(await gradient(640, 360))
      .jpeg()
      .toBuffer()
    const asked: string[] = []
    sandbox.languages = ["python"]
    // The runner, as sandbox/pcp.py's frames uses the bridge: it reads the
    // video, keeps a JPEG, and prints its answer as the last line.
    sandbox.executor = async ({ code, bridge }) => {
      asked.push(code)
      const read = await bridge("read", { id: video, as: "base64" })
      expect(read).toMatchObject({ ok: true })
      const keptFrame = await bridge("keep", {
        value: frame.toString("base64"),
        encoding: "base64",
        type: "image/jpeg",
        name: "frame-1.jpg",
      })
      const handle = "value" in keptFrame ? keptFrame.value : null
      const answer = {
        value: {
          duration: 10,
          width: 640,
          height: 360,
          frames: [{ t: 2.5, handle }],
        },
      }

      return {
        kind: "done",
        returned: null,
        output: `${JSON.stringify(answer)}\n`,
        dropped: 0,
      }
    }

    const answer = await view({ file: { $result: video }, time_s: 2.5 })

    expect(answer.isError, answer.text).toBe(false)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain("2.5")
    expect(answer.text).toContain("The frame at 2.5 s of clip.mp4")
    expect(await sharp(answer.image!.bytes).metadata()).toMatchObject({
      width: 640,
      height: 360,
    })
    const reused = /kept as \{"\$result":"([^"]+)"\}/.exec(answer.text)?.[1]
    expect(reused).toBeTruthy()

    const closer = await view({
      file: { $result: reused },
      crop: { x: 0, y: 0, width: 320, height: 180 },
    })

    expect(closer.isError, closer.text).toBe(false)
    expect(asked).toHaveLength(1)
    expect(await sharp(closer.image!.bytes).metadata()).toMatchObject({
      width: 320,
      height: 180,
    })
  }, 60_000)
})

describe("view_image refuses", () => {
  it("an SVG, which is text, whatever its type says", async () => {
    const svg = Buffer.from(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    )

    for (const type of ["image/svg+xml", "image/png"]) {
      const id = await kept(svg, type, "drawing.svg")
      const answer = await view({ file: { $result: id } })

      expect(answer.isError, type).toBe(true)
      expect(answer.text).toContain("SVG")
      expect(answer.text).toContain("read_result")
      expect(answer.image).toBeNull()
    }
  })

  it("another token's file", async () => {
    const { token } = await createApiToken(ctx, {
      name: "Other",
      allowAllServers: true,
    })
    const other = (await resolveApiToken(token))!
    const id = await kept(
      await gradient(100, 100),
      "image/png",
      "theirs.png",
      other.tokenId,
    )

    const answer = await view({ file: { $result: id } })

    expect(answer.isError).toBe(true)
    expect(answer.text).toMatch(/not there for this token/)
    expect(answer.image).toBeNull()
  })

  it("a video while the sandbox is not connected, saying so", async () => {
    expect(sandboxLanguages()).toEqual([])
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from("ftypisom"),
      Buffer.alloc(32),
    ])
    const id = await kept(mp4, "video/mp4", "clip.mp4")

    const answer = await view({ file: { $result: id }, time_s: 2 })

    expect(answer.isError).toBe(true)
    expect(answer.text).toContain("is a video (video/mp4)")
    expect(answer.text).toContain("sandbox")
  })

  it("a file that is no picture", async () => {
    const text = await kept(Buffer.from("hello"), "text/plain", "a.txt")

    const plain = await view({ file: { $result: text } })

    expect(plain.isError).toBe(true)
    expect(plain.text).toContain("is text/plain, not a picture")
  })

  it("a PDF, naming the convert_document call that makes its page a picture", async () => {
    const id = await kept(
      Buffer.from("%PDF-1.7\n%…"),
      "application/pdf",
      "letter.pdf",
    )

    const answer = await view({ file: { $result: id } })

    expect(answer.isError).toBe(true)
    expect(answer.text).toContain(
      `convert the page first with convert_document {"file":{"$result":"${id}"},"to":"png","page":1}`,
    )
    expect(answer.image).toBeNull()
  })

  it("page, which is convert_document's", async () => {
    const id = await kept(await gradient(50, 50), "image/png", "a.png")

    const answer = await view({ file: { $result: id }, page: 2 })

    expect(answer.isError).toBe(true)
    expect(answer.text).toMatch(/page/)
  })
})

describe("viewKind", () => {
  it("takes a picture by its first bytes only", async () => {
    expect(viewKind(await gradient(4, 4), "text/plain").kind).toBe("image")
    expect(viewKind(Buffer.from("not a png"), "image/png").kind).toBe("other")
    expect(viewKind(Buffer.from("%PDF-1.7\n"), "").kind).toBe("pdf")
  })
})
