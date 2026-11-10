import { randomUUID } from "node:crypto"
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
import { writeToolAccess } from "../tool-access"
import { setToolTier } from "../tool-tiers"
import { keepBytes, openResult } from "../tool-results"
import { setupVault } from "../vault"
import { PROVIDER_FILES } from "./run"
import { entryCall } from "../test-handles"

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
        name: tool.name,
        description: tool.description,
        inputSchema: JSON.stringify(tool.schema),
        annotations: tool.annotations ? JSON.stringify(tool.annotations) : null,
      },
    })
    await writeToolAccess(
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
      where: { slug: "conv" },
    }))!.id
    await writeToolAccess(scope.tokenId, serverId, "convert_file", "blocked")
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
