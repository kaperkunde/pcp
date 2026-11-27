import { randomBytes, randomUUID } from "node:crypto"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import type { CallToolResult } from "@modelcontextprotocol/server"
import sharp from "sharp"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import {
  buildGatewayServer,
  loadGatewayServers,
  type GatewayScope,
} from "../gateway"
import type { PermissionExecutor } from "../permissions"
import { appendRequestLog } from "../request-log"
import { createServer } from "../servers"
import { scratchDatabase } from "../test-db"
import { setServerToolAccess, writeToolAccess } from "../tool-access"
import { setToolTier } from "../tool-tiers"
import { ensureOwnStore } from "../storage/roots"
import { keepBytes, openResult } from "../tool-results"
import { setupVault } from "../vault"
import { PROVIDER_FILES } from "./run"
import { entryCall } from "../test-handles"
import { serverSlugWhere } from "../server-meta"

// The capability tools at /mcp, against fake providers: what they find,
// what they call (through the token's own levels and the tool's tier), and
// what they answer.

vi.mock("../request-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../request-log")>()),
  appendRequestLog: vi.fn(async () => {}),
}))

const PUBLIC_URL = "http://localhost:3000"
const WRITES = { readOnlyHint: false, destructiveHint: false }

const FILE = {
  type: "object",
  properties: {
    $result: { type: "string" },
    name: { type: "string" },
    type: { type: "string" },
  },
  required: ["$result"],
  additionalProperties: false,
}

type FakeTool = {
  name: string
  description: string
  schema: unknown
  annotations?: unknown
}

/** A converter that takes files by handle and does OCR, as Docling's API. */
const CONVERTER: FakeTool[] = [
  {
    name: "convert_file",
    description: "Convert documents from files to Markdown.",
    schema: {
      type: "object",
      properties: {
        files: { type: "array", items: FILE },
        do_ocr: { type: "boolean" },
        force_ocr: { type: "boolean" },
      },
      required: ["files"],
      additionalProperties: false,
    },
    annotations: WRITES,
  },
]

const PATH = { type: "string", description: "A path under /data." }

/** A PDF server with its own folder, as the PDF MCP Server. */
const PDF_SERVER: FakeTool[] = [
  {
    name: "put_file",
    description: "Save a file into the data folder.",
    schema: {
      type: "object",
      properties: {
        file_path: PATH,
        content_base64: { type: "string" },
        overwrite: { type: "boolean" },
      },
      required: ["file_path", "content_base64"],
      additionalProperties: false,
    },
    annotations: WRITES,
  },
  {
    name: "get_file",
    description: "Get a file from the data folder.",
    schema: {
      type: "object",
      properties: { file_path: PATH },
      required: ["file_path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "extract_text",
    description: "Text extraction, with OCR by Tesseract.",
    schema: {
      type: "object",
      properties: {
        pdf_path: PATH,
        include_confidence: { type: "boolean" },
      },
      required: ["pdf_path"],
      additionalProperties: false,
    },
    annotations: WRITES,
  },
  {
    name: "fill_pdf_form",
    description: "Fill a PDF form with provided data.",
    schema: {
      type: "object",
      properties: {
        input_path: PATH,
        output_path: PATH,
        data: { type: "object" },
        flatten: { type: "boolean" },
      },
      required: ["input_path", "output_path", "data"],
      additionalProperties: false,
    },
    // No hints: Destructive, until the owner says otherwise.
  },
]

let cleanup: () => Promise<void>
let ctx: VaultContext
let scope: GatewayScope
let ran: Array<{ server: string; tool: string; args: Record<string, unknown> }>
let answers: Record<string, () => CallToolResult>

const executor: PermissionExecutor = {
  callTool: async (_ctx, server, tool, args) => {
    ran.push({ server: server.slug, tool, args })
    const answer = answers[`${server.slug}/${tool}`]
    return answer
      ? answer()
      : { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] }
  },
  syncTools: async () => ({ status: "ok", message: "", toolCount: 0 }),
}

function json(value: unknown): () => CallToolResult {
  return () => ({ content: [{ type: "text", text: JSON.stringify(value) }] })
}

async function server(
  name: string,
  tools: FakeTool[],
  access: Record<string, "allowed" | "ask"> = {},
): Promise<string> {
  const { id } = await createServer(ctx, {
    name,
    url: `https://${name}.example.com/mcp`,
    authType: "none",
  })

  for (const tool of tools) {
    await db().mcpTool.create({
      data: {
        id: randomUUID(),
        serverId: id,
        plainName: tool.name,
        plainDescription: tool.description,
        plainInputSchema: JSON.stringify(tool.schema),
        annotations: tool.annotations ? JSON.stringify(tool.annotations) : null,
      },
    })
    await writeToolAccess(
      scope.ctx,
      scope.tokenId,
      id,
      tool.name,
      access[tool.name] ?? "allowed",
    )
  }

  return id
}

async function connect(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, await loadGatewayServers(scope), {
    executor,
  }).connect(serverSide)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  return client
}

async function call(name: string, args: Record<string, unknown>) {
  const client = await connect()
  const result = (await client.callTool(
    entryCall(name, args),
  )) as CallToolResult
  await client.close()
  const text = result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")

  return {
    isError: result.isError === true,
    text,
    // Through execute, a value whose text is its JSON comes as the text
    // alone (tools/serve.ts withoutRepeatedStructure).
    structured: (result.structuredContent ?? structuredText(result)) as Record<
      string,
      unknown
    >,
  }
}

/** The value a result's last text is the JSON of, or undefined. */
function structuredText(result: CallToolResult): unknown {
  const last = result.content.filter((part) => part.type === "text").at(-1)

  try {
    return last?.type === "text" ? JSON.parse(last.text) : undefined
  } catch {
    return undefined
  }
}

async function keptFile(name: string, mediaType: string): Promise<string> {
  const kept = await keepBytes(ctx, {
    tokenId: scope.tokenId,
    serverId: null,
    toolName: "test",
    bytes: Buffer.from(`bytes of ${name}`),
    mediaType,
    name,
  })
  return kept.id
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
  scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  ran = []
  answers = {}
  vi.mocked(appendRequestLog).mockClear()
})

afterEach(async () => {
  await cleanup()
})

describe("a capability with no provider", () => {
  it("answers with the owner's link to its page, last, and says it asked", async () => {
    const id = await keptFile("meter.png", "image/png")
    const answer = await call("read_image", { file: { $result: id } })

    expect(answer.isError).toBe(false)
    expect(answer.structured).toMatchObject({
      kind: "needs_owner",
      reason: "setup",
      url: `${PUBLIC_URL}/plugins/read_image`,
      label: "Set up image reading in PCP",
      capability: "read_image",
    })
    expect(answer.text.trimEnd().split("\n").at(-1)).toBe(
      `[Set up image reading in PCP](${PUBLIC_URL}/plugins/read_image)`,
    )
    expect(answer.text).toContain("call read_image again")
    expect(ran).toEqual([])
    expect(vi.mocked(appendRequestLog)).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "read_image", asked: true }),
    )
  })

  it("is named in search, and describe says it has none", async () => {
    const client = await connect()
    const found = (await client.callTool({
      name: "search",
      arguments: { query: "ocr a photo of the meter" },
    })) as CallToolResult
    const described = (await client.callTool(
      entryCall("describe", { ref: "read_image" }),
    )) as CallToolResult
    await client.close()
    const textOf = (result: CallToolResult) =>
      result.content.map((part) => (part.type === "text" ? part.text : ""))

    expect(textOf(found).join("\n")).toMatch(
      /not installed: Read images and scans \(pcp read_image\)/,
    )
    expect(JSON.parse(textOf(described)[0]!)).toMatchObject({
      tool: "read_image",
      providers: [],
      setup: expect.stringContaining("Set up image reading in PCP"),
    })
  })

  it("refuses a file that holds a part keep named (final 3)", async () => {
    const kept = await keepBytes(ctx, {
      tokenId: scope.tokenId,
      serverId: null,
      toolName: "test",
      bytes: Buffer.from("secret scan"),
      mediaType: "application/pdf",
      name: "s.pdf",
      passOnly: true,
    })

    for (const tool of ["convert_document", "read_image", "edit_pdf"]) {
      const answer = await call(tool, {
        file: { $result: kept.id },
        ...(tool === "convert_document" ? { to: "markdown" } : {}),
        ...(tool === "edit_pdf" ? { operation: "flatten" } : {}),
      })

      expect(answer.isError, tool).toBe(true)
      expect(answer.text, tool).toMatch(/never reads it out/)
    }
  })

  it("refuses a file that is not the token's", async () => {
    const answer = await call("convert_document", {
      file: { $result: "nope" },
    })

    expect(answer.isError).toBe(true)
    expect(answer.text).toMatch(/not there for this token/)
  })
})

describe("read_image with two providers", () => {
  it("runs both, by handle and through the file step, and flags where they disagree", async () => {
    await server("conv", CONVERTER)
    await server("pdf", PDF_SERVER)
    const id = await keptFile("meter.pdf", "application/pdf")
    answers["conv/convert_file"] = json({
      document: { md_content: "Meter 04512.7 kWh" },
      status: "success",
    })
    answers["pdf/extract_text"] = json({
      text: "Meter 04517.7 kWh",
      overall_average_confidence: 62,
      page_details: [{ words: [] }],
    })

    const answer = await call("read_image", {
      file: { $result: id, type: "application/pdf", size: 18 },
    })

    expect(answer.isError).toBe(false)
    expect(answer.structured).toMatchObject({
      kind: "readings",
      agree: false,
      // The one that says OCR first; the converter found by its arguments.
      readings: [
        { provider: "pdf/extract_text", confidence: 0.62 },
        { provider: "conv/convert_file", text: "Meter 04512.7 kWh" },
      ],
    })
    const flags = (answer.structured.flags as string[]).join("\n")
    expect(flags).toContain("Low confidence: pdf/extract_text was 62% sure")
    expect(flags).toContain("The numbers differ")
    expect(answer.structured.check).toMatch(/meter readings/)

    // The PDF server got the file in its folder; the converter its handle.
    const put = ran[0]!
    expect(put.tool).toBe("put_file")
    expect(put.args).toMatchObject({
      content_base64: { $result: id },
      overwrite: true,
    })
    expect(String(put.args.file_path)).toMatch(
      new RegExp(`^${PROVIDER_FILES}/[0-9a-f]{16}/meter\\.pdf$`),
    )
    expect(ran[1]).toEqual({
      server: "pdf",
      tool: "extract_text",
      args: { pdf_path: put.args.file_path, include_confidence: true },
    })
    expect(ran[2]).toEqual({
      server: "conv",
      tool: "convert_file",
      args: { files: [{ $result: id }], do_ocr: true, force_ocr: true },
    })

    // Each provider's call has its own line under read_image.
    expect(vi.mocked(appendRequestLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "read_image",
        server: "pdf",
        upstreamTool: "extract_text",
        ok: true,
      }),
    )
  })

  it("skips a provider that takes PDFs only for a picture", async () => {
    await server("conv", CONVERTER)
    await server("pdf", PDF_SERVER)
    const id = await keptFile("meter.png", "image/png")
    answers["conv/convert_file"] = json({
      document: { md_content: "Meter 04512.7 kWh" },
    })

    const answer = await call("read_image", { file: { $result: id } })

    expect(answer.structured).toMatchObject({
      kind: "readings",
      agree: null,
      skipped: [{ provider: "pdf/extract_text", reason: "it takes PDFs only" }],
    })
    expect(ran.map((entry) => entry.tool)).toEqual(["convert_file"])
  })
})

describe("a capability with a provider", () => {
  it("is not suggested as missing, and describe names its providers", async () => {
    await server("conv", CONVERTER)
    const client = await connect()
    const found = (await client.callTool({
      name: "search",
      arguments: { query: "convert a docx to markdown" },
    })) as CallToolResult
    const described = (await client.callTool(
      entryCall("describe", { ref: "convert_document" }),
    )) as CallToolResult
    await client.close()
    const textOf = (result: CallToolResult) =>
      result.content.map((part) => (part.type === "text" ? part.text : ""))

    expect(textOf(found).join("\n")).toContain("pcp convert_document")
    expect(textOf(found).join("\n")).not.toContain("not installed")
    expect(JSON.parse(textOf(described)[0]!)).toMatchObject({
      providers: ["conv/convert_file (convert)"],
    })
  })
})

describe("forwarding through the token's levels and tiers", () => {
  it("passes on the owner's link when a provider's tool asks, and runs nothing", async () => {
    await server("conv", CONVERTER, { convert_file: "ask" })
    const id = await keptFile("letter.png", "image/png")

    const answer = await call("convert_document", { file: { $result: id } })

    expect(answer.structured).toMatchObject({
      kind: "needs_owner",
      reason: "permission",
    })
    expect(answer.text).toContain("conv/convert_file, which needs the owner")
    expect(answer.text.trimEnd().split("\n").at(-1)).toMatch(
      /^\[.*\]\(http:\/\/localhost:3000\/permissions\/[^)]+\)$/,
    )
    expect(ran).toEqual([])
  })

  it("refuses a provider tool above the capability tool's tier, naming the entry that runs it", async () => {
    await server("pdf", PDF_SERVER)
    const id = await keptFile("form.pdf", "application/pdf")

    const answer = await call("edit_pdf", {
      operation: "fill_form",
      file: { $result: id },
      fields: { name: "Ada" },
    })

    expect(answer.isError).toBe(true)
    expect(answer.text).toContain(
      "pdf/fill_pdf_form is a Destructive tool, above edit_pdf (Write)",
    )
    expect(answer.text).toContain("execute_destructive")
    // The file was put in place; the edit itself never ran.
    expect(ran.map((entry) => entry.tool)).toEqual(["put_file"])
  })

  it("fills a form once the owner made the tool Write, and hands back the PDF it wrote", async () => {
    const id = await server("pdf", PDF_SERVER)
    await setToolTier(ctx, id, "fill_pdf_form", "write")
    const file = await keptFile("form.pdf", "application/pdf")
    answers["pdf/get_file"] = () => ({
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///data/pcp/x/fill_form.pdf",
            mimeType: "application/pdf",
            blob: Buffer.from("%PDF-1.7 filled").toString("base64"),
          },
        },
      ],
    })

    const answer = await call("edit_pdf", {
      operation: "fill_form",
      file: { $result: file },
      fields: { name: "Ada" },
      flatten: true,
    })

    expect(answer.isError, answer.text).toBe(false)
    expect(answer.structured).toMatchObject({
      kind: "pdf",
      operation: "fill_form",
      provider: "pdf/fill_pdf_form",
      files: [{ type: "application/pdf" }],
    })
    const fill = ran.find((entry) => entry.tool === "fill_pdf_form")!
    expect(fill.args).toMatchObject({
      data: { name: "Ada" },
      flatten: true,
    })
    expect(String(fill.args.output_path)).toMatch(/\/fill_form\.pdf$/)
    expect(ran.at(-1)).toEqual({
      server: "pdf",
      tool: "get_file",
      args: { file_path: fill.args.output_path },
    })
  })

  it("leaves out a provider the owner blocked", async () => {
    await server("conv", CONVERTER)
    const serverId = (await db().mcpServer.findFirst({
      where: serverSlugWhere(scope.ctx, "conv"),
    }))!.id
    await writeToolAccess(
      scope.ctx,
      scope.tokenId,
      serverId,
      "convert_file",
      "blocked",
    )
    const id = await keptFile("letter.png", "image/png")

    const answer = await call("convert_document", { file: { $result: id } })

    expect(answer.structured).toMatchObject({ reason: "setup" })
    expect(ran).toEqual([])
  })
})

/** A PDF page renderer that takes the file by handle, as an API's upload. */
function renderer(annotations: unknown, page: Record<string, unknown>) {
  return [
    {
      name: "render_page",
      description: "Render a page of a PDF to a PNG image.",
      schema: {
        type: "object",
        properties: { file: FILE, ...page, dpi: { type: "integer" } },
        required: ["file"],
        additionalProperties: false,
      },
      annotations,
    },
  ] satisfies FakeTool[]
}

/** A kept PDF, by its first bytes: only those have pages to render. */
async function pdfFile(type = "application/pdf"): Promise<string> {
  const kept = await keepBytes(ctx, {
    tokenId: scope.tokenId,
    serverId: null,
    toolName: "test",
    bytes: Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n"),
    mediaType: type,
    name: "letter.pdf",
  })
  return kept.id
}

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: "#c00" },
  })
    .png()
    .toBuffer()
}

describe("convert_document to a picture of a PDF's page", () => {
  const picture = (bytes: Buffer) => () => ({
    content: [
      {
        type: "image" as const,
        data: bytes.toString("base64"),
        mimeType: "image/png",
      },
    ],
  })

  it("answers with the owner's link when no tool renders a page, saying what it takes", async () => {
    await server("conv", CONVERTER)
    const id = await pdfFile()

    const answer = await call("convert_document", {
      file: { $result: id },
      to: "png",
    })

    expect(answer.structured).toMatchObject({
      kind: "needs_owner",
      reason: "setup",
      url: `${PUBLIC_URL}/plugins/convert_document`,
      capability: "convert_document",
    })
    expect(answer.text).toContain("turns a PDF's page into a picture")
    expect(answer.text).toContain("renders a page to an image")
    // No common item does it: the text offers none to launch.
    expect(answer.text).not.toContain("Docling")
    expect(answer.text.trimEnd().split("\n").at(-1)).toBe(
      `[Set up document conversion in PCP](${PUBLIC_URL}/plugins/convert_document)`,
    )
    expect(ran).toEqual([])
  })

  it("has a provider that takes the file by handle render the page, counting from 0 where it does", async () => {
    await server(
      "pages",
      renderer(WRITES, {
        page_index: { type: "integer", description: "The page, 0-based." },
      }),
    )
    const id = await pdfFile()
    answers["pages/render_page"] = picture(await png(300, 400))

    const answer = await call("convert_document", {
      file: { $result: id },
      to: "png",
      page: 3,
    })

    expect(answer.isError, answer.text).toBe(false)
    expect(ran).toEqual([
      {
        server: "pages",
        tool: "render_page",
        args: { file: { $result: id }, page_index: 2, dpi: 150 },
      },
    ])
    expect(answer.structured).toMatchObject({
      kind: "page_image",
      provider: "pages/render_page",
      page: 3,
      file: { $result: expect.any(String), type: "image/png" },
    })
    // The handle is the token's own picture, for view_image.
    const made = await openResult(ctx, {
      tokenId: scope.tokenId,
      id: (answer.structured.file as { $result: string }).$result,
    })
    expect(await sharp(made!.bytes()).metadata()).toMatchObject({
      width: 300,
      height: 400,
    })
    expect(vi.mocked(appendRequestLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "convert_document",
        server: "pages",
        upstreamTool: "render_page",
      }),
    )
  })

  it("puts the PDF in a provider's folder and fetches the PNG it wrote, the page as it is", async () => {
    const PAGE_SERVER: FakeTool[] = [
      ...PDF_SERVER.filter((tool) =>
        ["put_file", "get_file"].includes(tool.name),
      ),
      {
        name: "render_page",
        description: "Render a PDF page as an image.",
        schema: {
          type: "object",
          properties: {
            pdf_path: PATH,
            output_path: PATH,
            page_number: { type: "integer", description: "From 1." },
          },
          required: ["pdf_path", "output_path", "page_number"],
          additionalProperties: false,
        },
        annotations: WRITES,
      },
    ]
    await server("pdf", PAGE_SERVER)
    const id = await pdfFile()
    const bytes = await png(40, 60)
    answers["pdf/get_file"] = () => ({
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///data/pcp/x/page_image.png",
            mimeType: "image/png",
            blob: bytes.toString("base64"),
          },
        },
      ],
    })

    const answer = await call("convert_document", {
      file: { $result: id },
      to: "png",
      page: 2,
    })

    expect(answer.isError, answer.text).toBe(false)
    expect(ran.map((entry) => entry.tool)).toEqual([
      "put_file",
      "render_page",
      "get_file",
    ])
    const render = ran[1]!
    expect(render.args).toMatchObject({
      pdf_path: ran[0]!.args.file_path,
      page_number: 2,
    })
    expect(String(render.args.output_path)).toMatch(/\/page_image\.png$/)
    expect(ran[2]!.args).toEqual({ file_path: render.args.output_path })
    expect(answer.structured).toMatchObject({
      kind: "page_image",
      provider: "pdf/render_page",
      file: { type: "image/png" },
    })
  })

  it("refuses page without to png, and a picture, which view_image shows as it is", async () => {
    const pdf = await pdfFile()
    // A picture by its bytes, whatever its type says.
    const photo = (
      await keepBytes(ctx, {
        tokenId: scope.tokenId,
        serverId: null,
        toolName: "test",
        bytes: await png(10, 10),
        mediaType: "application/octet-stream",
        name: "photo",
      })
    ).id

    const paged = await call("convert_document", {
      file: { $result: pdf },
      page: 2,
    })
    const pictured = await call("convert_document", {
      file: { $result: photo },
      to: "png",
    })

    expect(paged.isError).toBe(true)
    expect(paged.text).toContain('page goes with to "png"')
    expect(pictured.isError).toBe(true)
    expect(pictured.text).toContain("already a picture")
    expect(pictured.text).toContain("view_image")
    expect(ran).toEqual([])
  })

  it("refuses a file that is not a PDF by its bytes, whatever its type says", async () => {
    await server("pages", renderer(WRITES, { page: { type: "integer" } }))
    const id = await keptFile("letter.docx", "application/pdf")

    const answer = await call("convert_document", {
      file: { $result: id },
      to: "png",
    })

    expect(answer.isError).toBe(true)
    expect(answer.text).toContain("only a PDF's page")
    expect(ran).toEqual([])
  })

  it("answers that the renderer made no picture when its file is none", async () => {
    await server("pages", renderer(WRITES, { page: { type: "integer" } }))
    const id = await pdfFile()
    answers["pages/render_page"] = () => ({
      content: [
        {
          type: "image",
          data: Buffer.from("%PDF-1.7 not a picture").toString("base64"),
          mimeType: "image/png",
        },
      ],
    })

    const answer = await call("convert_document", {
      file: { $result: id },
      to: "png",
    })

    expect(answer.isError).toBe(true)
    expect(answer.text).toContain(
      "pages/render_page: the renderer answered with no picture",
    )
    expect(answer.structured?.kind).not.toBe("page_image")
  })
})

describe("read_image with include_image", () => {
  it("shows the picture beside the readings, which stay its structured answer", async () => {
    await server("conv", CONVERTER)
    const kept = await keepBytes(ctx, {
      tokenId: scope.tokenId,
      serverId: null,
      toolName: "test",
      bytes: await png(64, 32),
      mediaType: "image/png",
      name: "sign.png",
    })
    answers["conv/convert_file"] = json({
      document: { md_content: "STOP" },
    })

    const client = await connect()
    const result = (await client.callTool(
      entryCall("read_image", {
        file: { $result: kept.id },
        include_image: true,
      }),
    )) as CallToolResult
    await client.close()

    expect(result.isError).toBeFalsy()
    // Through execute the readings are the text alone, once.
    expect(result.structuredContent).toBeUndefined()
    expect(
      JSON.parse(
        result.content.flatMap((part) =>
          part.type === "text" && part.text.startsWith("{") ? [part.text] : [],
        )[0]!,
      ),
    ).toMatchObject({
      kind: "readings",
      readings: [{ provider: "conv/convert_file", text: "STOP" }],
    })
    expect(result.content.map((part) => part.type)).toEqual([
      "text",
      "text",
      "image",
    ])
  })
})

// ---- generate_image ------------------------------------------------------

const IMAGE_BODY = {
  prompt: { type: "string" },
  model: { type: "string", default: "gpt-image-2" },
  n: { type: "integer" },
  size: { type: "string" },
  quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
  background: { type: "string", enum: ["transparent", "opaque", "auto"] },
}

/** An images API as PCP generates its tools: generations and an edit. */
const IMAGES_API: FakeTool[] = [
  {
    name: "create_image",
    description:
      "Generate an image\n\nMake a picture from a text prompt.\n\nPOST /images/generations",
    schema: {
      type: "object",
      properties: {
        body: { type: "object", required: ["prompt"], properties: IMAGE_BODY },
      },
      required: ["body"],
    },
    annotations: WRITES,
  },
  {
    name: "create_image_edit",
    description:
      "Edit an image\n\nChange pictures you give it.\n\nPOST /images/edits",
    schema: {
      type: "object",
      properties: {
        body: {
          type: "object",
          required: ["image[]", "prompt"],
          properties: {
            "image[]": { type: "array", items: FILE },
            ...IMAGE_BODY,
          },
        },
      },
      required: ["body"],
    },
    annotations: WRITES,
  },
]

/** A picture large enough that PCP keeps it as a file on sight (noise). */
async function smallPng(): Promise<string> {
  return (
    await sharp(randomBytes(48 * 48 * 3), {
      raw: { width: 48, height: 48, channels: 3 },
    })
      .png()
      .toBuffer()
  ).toString("base64")
}

describe("generate_image with no provider", () => {
  it("answers with the owner's link to its page, last, and says it asked", async () => {
    const answer = await call("generate_image", { prompt: "A red kite" })

    expect(answer.isError).toBe(false)
    expect(answer.structured).toMatchObject({
      kind: "needs_owner",
      reason: "setup",
      url: `${PUBLIC_URL}/plugins/generate_image`,
      label: "Set up image generation in PCP",
      capability: "generate_image",
    })
    expect(answer.text.trimEnd().split("\n").at(-1)).toBe(
      `[Set up image generation in PCP](${PUBLIC_URL}/plugins/generate_image)`,
    )
    expect(answer.text).toContain("add with their own key")
    expect(ran).toEqual([])
    expect(vi.mocked(appendRequestLog)).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "generate_image", asked: true }),
    )
  })

  it("is named in search before it is set up", async () => {
    const client = await connect()
    const found = (await client.callTool({
      name: "search",
      arguments: { query: "draw an illustration for the blog" },
    })) as CallToolResult
    await client.close()

    expect(
      found.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n"),
    ).toMatch(/not installed: Generate images \(pcp generate_image\)/)
  })

  it("says an edit has no provider where only generations are there", async () => {
    await server("images", IMAGES_API.slice(0, 1))
    const id = await keptFile("kite.png", "image/png")

    const answer = await call("generate_image", {
      prompt: "Make it blue",
      images: [{ $result: id }],
    })

    expect(answer.structured).toMatchObject({ reason: "setup" })
    expect(answer.text).toContain("changes a picture")
    expect(ran).toEqual([])
  })
})

describe("generate_image with an images API", () => {
  it("keeps a full-size picture as a file, however long its base64", async () => {
    await server("images", IMAGES_API)
    // About what a 1536x1024 picture comes back as: over 1 MB of base64,
    // past what a program is handed.
    const big = (
      await sharp(randomBytes(520 * 520 * 3), {
        raw: { width: 520, height: 520, channels: 3 },
      })
        .png()
        .toBuffer()
    ).toString("base64")
    answers["images/create_image"] = json({
      created: 1,
      data: [{ b64_json: big }],
      usage: { total_tokens: 10 },
    })

    const answer = await call("generate_image", { prompt: "A red kite" })

    expect(answer.isError, answer.text).toBe(false)
    const images = answer.structured.images as Array<{ $result: string }>
    expect(images).toHaveLength(1)
    const kept = await openResult(scope.ctx, {
      tokenId: scope.tokenId,
      id: images[0]!.$result,
    })
    expect(kept!.mediaType).toBe("image/png")
  })

  it("makes pictures, keeps each as a handle, and sends only what the API takes", async () => {
    await server("images", IMAGES_API)
    const b64 = await smallPng()
    answers["images/create_image"] = json({
      created: 1,
      data: [{ b64_json: b64 }, { b64_json: b64 }],
      usage: { total_tokens: 10 },
    })

    const answer = await call("generate_image", {
      prompt: "A red kite over dunes",
      size: "1536x1024",
      quality: "low",
      n: 2,
      background: "opaque",
    })

    expect(answer.isError, answer.text).toBe(false)
    expect(answer.structured).toMatchObject({
      kind: "images",
      operation: "generate",
      provider: "images/create_image",
      ignored: [],
      saved: [],
    })
    const images = answer.structured.images as Array<{ $result: string }>
    expect(images).toHaveLength(2)

    const kept = await openResult(scope.ctx, {
      tokenId: scope.tokenId,
      id: images[0]!.$result,
    })
    expect(kept!.mediaType).toBe("image/png")
    expect(kept!.bytes().subarray(1, 4).toString()).toBe("PNG")

    // The model comes from the schema's default; nothing it lacks is sent.
    expect(ran).toEqual([
      {
        server: "images",
        tool: "create_image",
        args: {
          body: {
            prompt: "A red kite over dunes",
            model: "gpt-image-2",
            size: "1536x1024",
            quality: "low",
            n: 2,
            background: "opaque",
          },
        },
      },
    ])
    expect(vi.mocked(appendRequestLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "generate_image",
        server: "images",
        upstreamTool: "create_image",
        ok: true,
      }),
    )
  })

  it("says which setting the provider has no such value for, and leaves it out", async () => {
    await server("images", [
      {
        ...IMAGES_API[0]!,
        schema: {
          type: "object",
          properties: {
            body: {
              type: "object",
              required: ["prompt"],
              properties: {
                prompt: { type: "string" },
                quality: { type: "string", enum: ["standard", "hd"] },
              },
            },
          },
        },
      },
    ])
    answers["images/create_image"] = json({
      data: [{ b64_json: await smallPng() }],
    })

    const answer = await call("generate_image", {
      prompt: "A kite",
      quality: "high",
      model: "other-model",
    })

    expect(answer.structured).toMatchObject({
      kind: "images",
      ignored: ["quality"],
    })
    expect(ran[0]!.args).toEqual({ body: { prompt: "A kite" } })
  })

  it("changes the pictures it is given, by their handles", async () => {
    await server("images", IMAGES_API)
    const a = await keptFile("a.png", "image/png")
    const b = await keptFile("b.png", "image/png")
    answers["images/create_image_edit"] = json({
      data: [{ b64_json: await smallPng() }],
    })

    const answer = await call("generate_image", {
      prompt: "Make the sky blue",
      images: [{ $result: a }, { $result: b }],
    })

    expect(answer.structured).toMatchObject({
      kind: "images",
      operation: "edit",
      provider: "images/create_image_edit",
    })
    expect(ran).toEqual([
      {
        server: "images",
        tool: "create_image_edit",
        args: {
          body: {
            "image[]": [{ $result: a }, { $result: b }],
            prompt: "Make the sky blue",
            model: "gpt-image-2",
          },
        },
      },
    ])
  })

  it("takes a picture an MCP image server answers with as an image", async () => {
    await server("painter", [
      {
        name: "generate_image",
        description: "Generate a picture from a text prompt.",
        schema: {
          type: "object",
          properties: { prompt: { type: "string" } },
          required: ["prompt"],
        },
        annotations: WRITES,
      },
    ])
    const data = await smallPng()
    answers["painter/generate_image"] = () => ({
      content: [{ type: "image", data, mimeType: "image/png" }],
    })

    const answer = await call("generate_image", { prompt: "A lighthouse" })

    expect(answer.structured).toMatchObject({
      kind: "images",
      provider: "painter/generate_image",
    })
    expect((answer.structured.images as unknown[]).length).toBe(1)
  })

  it("fails a provider that answers with a link instead of a picture", async () => {
    await server("images", IMAGES_API)
    answers["images/create_image"] = json({
      data: [{ url: "https://cdn.example.com/x.png" }],
    })

    const answer = await call("generate_image", { prompt: "A kite" })

    expect(answer.isError).toBe(true)
    expect(answer.text).toMatch(
      /images\/create_image: it answered with no picture/,
    )
  })

  it("passes on the owner's link when the provider's tool asks, and runs nothing", async () => {
    await server("images", IMAGES_API, { create_image: "ask" })

    const answer = await call("generate_image", { prompt: "A kite" })

    expect(answer.structured).toMatchObject({
      kind: "needs_owner",
      reason: "permission",
    })
    expect(answer.text).toContain("images/create_image, which needs the owner")
    expect(ran).toEqual([])
  })

  it("is not made twice by a repeat: the guard answers, and rerun with a reason makes it again", async () => {
    await server("images", IMAGES_API)
    answers["images/create_image"] = json({
      data: [{ b64_json: await smallPng() }],
    })

    const first = await call("generate_image", { prompt: "A kite" })
    const second = await call("generate_image", { prompt: "A kite" })

    expect(first.isError).toBe(false)
    expect(second.isError).toBe(true)
    expect(second.text).toMatch(/rerun/)
    expect(ran).toHaveLength(1)
  })

  it("refuses a prompt, a count or a size past its limits before anything runs", async () => {
    await server("images", IMAGES_API)

    for (const args of [
      { prompt: "x".repeat(4_001) },
      { prompt: "A kite", n: 5 },
      { prompt: "A kite", size: "huge" },
      { prompt: "" },
    ]) {
      const answer = await call("generate_image", args)
      expect(answer.isError, JSON.stringify(args).slice(0, 40)).toBe(true)
    }

    expect(ran).toEqual([])
  })
})

describe("generate_image saving to a store", () => {
  it("also saves each picture in PCP's own store, through its save_file at the token's levels", async () => {
    const own = await ensureOwnStore(ctx)
    await setServerToolAccess(ctx, scope.tokenId, own, "allowed")
    await server("images", IMAGES_API)
    const b64 = await smallPng()
    answers["images/create_image"] = json({
      data: [{ b64_json: b64 }, { b64_json: b64 }],
    })

    const answer = await call("generate_image", {
      prompt: "A kite",
      n: 2,
      folder: "",
      file_name: "cover",
    })

    expect(answer.isError, answer.text).toBe(false)
    expect(answer.structured.saved).toEqual([
      { store: "pcp-files", path: "cover-1.png", error: null },
      { store: "pcp-files", path: "cover-2.png", error: null },
    ])
    // The fake executor stands in for the store: its calls are what ran.
    const images = answer.structured.images as Array<{ $result: string }>
    expect(ran.filter((entry) => entry.tool === "save_file")).toEqual([
      {
        server: "pcp-files",
        tool: "save_file",
        args: { path: "cover-1.png", file: { $result: images[0]!.$result } },
      },
      {
        server: "pcp-files",
        tool: "save_file",
        args: { path: "cover-2.png", file: { $result: images[1]!.$result } },
      },
    ])
    expect(vi.mocked(appendRequestLog)).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "generate_image",
        server: "pcp-files",
        upstreamTool: "save_file",
      }),
    )
  })

  it("refuses a store the token has not got before any money is spent", async () => {
    await server("images", IMAGES_API)

    const answer = await call("generate_image", {
      prompt: "A kite",
      store: "nowhere",
    })

    expect(answer.isError).toBe(true)
    expect(answer.text).toMatch(/no store called nowhere/i)
    expect(ran).toEqual([])
  })

  it("keeps the pictures and hands over the owner's link when saving asks", async () => {
    await ensureOwnStore(ctx)
    await server("images", IMAGES_API)
    answers["images/create_image"] = json({
      data: [{ b64_json: await smallPng() }],
    })

    const answer = await call("generate_image", {
      prompt: "A kite",
      folder: "",
    })

    expect(answer.text).toContain("saving to pcp-files needs the owner first")
    expect(answer.text).toContain("do not call generate_image again")
    expect(ran).toHaveLength(1)
    expect(await db().storageEntry.count()).toBe(0)
  })
})
