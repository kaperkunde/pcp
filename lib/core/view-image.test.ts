import { randomBytes } from "node:crypto"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import type { CallToolResult } from "@modelcontextprotocol/server"
import sharp from "sharp"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import { INLINE_IMAGE_BYTES } from "./browser/screenshot"
import { VIEW_IMAGE_SIDE } from "./code/limits"
import { sandboxLanguages } from "./code/sandbox"
import type { VaultContext } from "./context"
import { buildGatewayServer, type GatewayScope } from "./gateway"
import { scratchDatabase } from "./test-db"
import { keepBytes } from "./tool-results"
import { setupVault } from "./vault"
import { viewKind } from "./view-image"

// view_image at /mcp: a kept picture shown as image content, made to fit;
// what it refuses. A PDF's page (a provider's work) is tested with the
// other capabilities, against fake providers (capabilities.test.ts).

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
  await cleanup()
})

async function view(args: Record<string, unknown>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, []).connect(serverSide)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  const result = (await client.callTool({
    name: "view_image",
    arguments: args,
  })) as CallToolResult
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

  it("page for a file that is not a PDF, and a file that is no picture", async () => {
    const png = await kept(await gradient(50, 50), "image/png", "a.png")
    const text = await kept(Buffer.from("hello"), "text/plain", "a.txt")

    const paged = await view({ file: { $result: png }, page: 2 })
    const plain = await view({ file: { $result: text } })

    expect(paged.isError).toBe(true)
    expect(paged.text).toContain("page is for a PDF")
    expect(plain.isError).toBe(true)
    expect(plain.text).toContain("is text/plain, not a picture")
  })
})

describe("viewKind", () => {
  it("takes a picture by its first bytes only", async () => {
    expect(viewKind(await gradient(4, 4), "text/plain").kind).toBe("image")
    expect(viewKind(Buffer.from("not a png"), "image/png").kind).toBe("other")
    expect(viewKind(Buffer.from("%PDF-1.7\n"), "").kind).toBe("pdf")
  })
})
