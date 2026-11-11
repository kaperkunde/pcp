import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import { storeTools } from "../catalogue"
import type { VaultContext } from "../context"
import { db } from "../db"
import { serverCreateData } from "../server-meta"
import { scratchDatabase } from "../test-db"
import { writeToolAccess } from "../tool-access"
import { setupVault } from "../vault"
import { ocrHint, ocrToolFor } from "./ocr"

// The OCR tool a screenshot's answer names: found by its words among the
// tools the token may call (OCR in its name or description, or force_ocr
// among its arguments), never by a vendor's name; none when the token has
// none, or only a blocked one.

let cleanup: () => Promise<void>
let ctx: VaultContext
let tokenId: string

async function server(slug: string, tools: Parameters<typeof storeTools>[2]) {
  const id = `srv_${slug}`
  await db().mcpServer.create({
    data: serverCreateData(ctx, {
      id,
      vaultId: ctx.vaultId,
      kind: "http",
      name: slug,
      slug,
      url: `https://${slug}.example.com/mcp`,
    }),
  })
  await storeTools(ctx, id, tools)
  return id
}

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
  tokenId = (await resolveApiToken(token))!.tokenId
})

afterEach(async () => {
  await cleanup()
})

describe("the OCR tool a token can call", () => {
  it("is none when the token has no tool that does OCR", async () => {
    await server("notes", [
      { name: "write_note", description: "Democracy notes", inputSchema: {} },
    ])
    expect(await ocrToolFor(ctx, tokenId)).toBeNull()
    expect(ocrHint(null)).toContain("read_image")
  })

  it("is found by force_ocr among its arguments, and named with it", async () => {
    await server("docling", [
      {
        name: "convert_file",
        description: "Converts a document to Markdown.",
        inputSchema: {
          type: "object",
          properties: {
            file: { type: "string" },
            force_ocr: { type: "boolean" },
          },
        },
      },
    ])

    const found = await ocrToolFor(ctx, tokenId)
    expect(found).toEqual({ name: "docling/convert_file", forceOcr: true })
    expect(ocrHint(found)).toBe(
      "pass its handle to docling/convert_file with force_ocr: true (an OCR tool this token can call)",
    )
  })

  it("prefers one that says OCR and that the token may call without asking, and skips a blocked one", async () => {
    const reader = await server("reader", [
      {
        name: "read_image",
        description: "OCR: reads the text in an image.",
        inputSchema: { type: "object" },
      },
    ])
    await server("pdf", [
      {
        name: "extract",
        description: "Text from a PDF.",
        inputSchema: {
          type: "object",
          properties: { ocr: { type: "boolean", description: "Use OCR." } },
        },
      },
    ])

    expect((await ocrToolFor(ctx, tokenId))?.name).toBe("reader/read_image")

    await writeToolAccess(tokenId, reader, "read_image", "blocked")
    expect((await ocrToolFor(ctx, tokenId))?.name).toBe("pdf/extract")
  })
})
